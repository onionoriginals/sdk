import type { HostedAssets, HostedEvidence } from "./hosted.js";
import {
  CelError,
  parseAssetDid,
  parseDocument,
  resolveSat,
  validateDocument,
  digestBytes,
  type SatSnapshot,
  type SatResolution,
  type BitcoinNetwork,
} from "@originals/cel/v3";
import type { DIDDocument } from "../types/did.js";
import { summarizeVerification } from "./verification.js";
import { OriginalsAsset } from "./OriginalsAsset.js";
import { attachment, resourceCatalog } from "./resources.js";
import type {
  OriginalsConfig,
  AssetVerification,
  ResourceAttachment,
} from "./types.js";

/** A complete chain/index observation. Providers assert chain facts; the shared core checks CEL authority. */
export interface SatProvider {
  getSatSnapshot(sat: string): Promise<SatSnapshot>;
}
export interface AssetResolutionOptions {
  expectedAssetId?: string;
  /** @deprecated Use expectedAssetId. */
  expectedDid?: string;
}
export type AssetResolution =
  | Exclude<SatResolution, { status: "accepted" }>
  | {
      status: "accepted";
      asset: OriginalsAsset;
      verification: AssetVerification;
      resolution: Extract<SatResolution, { status: "accepted" }>;
      didDocument: DIDDocument | null;
    };
export interface AssetDIDResolution {
  didDocument: DIDDocument | null;
  didResolutionMetadata: { status: SatResolution["status"]; error?: string };
  didDocumentMetadata: {
    deactivated?: boolean;
    head?: string;
    ownership?: SatSnapshot["ownership"];
    tip?: SatSnapshot["tipBefore"];
    scope: "sat";
    crossSatCanonicality: "unknown";
    webvhBinding?: "unverified";
  };
}

export function btcoDid(sat: string, network: BitcoinNetwork): string {
  const did = `did:btco:${network === "mainnet" ? "" : network === "regtest" ? "reg:" : network === "signet" ? "sig:" : "test:"}${sat}`;
  parseAssetDid(did);
  return did;
}
const failure = (
  status: Exclude<SatResolution["status"], "accepted">,
  reason: string,
): AssetResolution => ({
  status,
  reason,
  scope: "sat",
  crossSatCanonicality: "unknown",
});

/** No cache or creator-local boundary map: every call obtains and checks a fresh complete observation. */
export class AssetResolver {
  constructor(
    readonly network: BitcoinNetwork,
    private readonly provider?: SatProvider,
    private readonly config: OriginalsConfig = {},
    private readonly hosted?: HostedAssets,
  ) {}

  async checkWeb(did: string, expectedDid: string): Promise<HostedEvidence> {
    return this.hosted
      ? this.hosted.check(did, expectedDid)
      : { status: "incomplete", did, reason: "Configure hosted storage" };
  }

  async observe(
    sat: string,
    options: AssetResolutionOptions = {},
  ): Promise<{ snapshot?: SatSnapshot; resolution: SatResolution }> {
    let result = await this.observeOnce(sat, options);
    for (
      let attempt = 1;
      attempt < 3 &&
      ["chain-changed", "inconsistent-evidence"].includes(
        result.resolution.status,
      );
      attempt++
    ) {
      result = await this.observeOnce(sat, options);
    }
    return result;
  }

  private async observeOnce(
    sat: string,
    options: AssetResolutionOptions = {},
  ): Promise<{ snapshot?: SatSnapshot; resolution: SatResolution }> {
    btcoDid(sat, this.network);
    if (!this.provider)
      return {
        resolution: failure(
          "unsupported-capability",
          "A complete sat snapshot provider is required",
        ) as SatResolution,
      };
    try {
      const snapshot = structuredClone(await this.provider.getSatSnapshot(sat));
      if (snapshot?.sat !== sat || snapshot.network !== this.network)
        return {
          resolution: failure(
            "inconsistent-evidence",
            "Provider snapshot differs from requested sat or network",
          ) as SatResolution,
        };
      return { snapshot, resolution: resolveSat(snapshot, options) };
    } catch (error) {
      return {
        resolution: failure(
          error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "SAT_SNAPSHOT_CHAIN_CHANGED"
            ? "chain-changed"
            : "incomplete",
          "The provider could not obtain a complete sat snapshot",
        ) as SatResolution,
      };
    }
  }

  async check(did: string, expectedDid: string): Promise<SatResolution> {
    const parsed = parseAssetDid(did);
    if (parsed.method !== "btco" || parsed.network !== this.network)
      return failure(
        "identity-mismatch",
        "Asset network differs from configured provider",
      ) as SatResolution;
    return (await this.observe(parsed.sat, { expectedDid })).resolution;
  }

  async resolve(
    sat: string,
    options: AssetResolutionOptions = {},
  ): Promise<AssetResolution> {
    const did = btcoDid(sat, this.network);
    const { snapshot, resolution } = await this.observe(sat, options);
    if (resolution.status !== "accepted") return resolution;
    // Reconstruct only entries selected by the core, in its accepted publication order.
    // Fully inspected unrelated/invalid publications can never supply authority or media.
    const observations = new Map(
      snapshot!.publications.map((publication) => [
        publication.id,
        publication,
      ]),
    );
    const entries = resolution.publications.flatMap((publication) => {
      const observation = observations.get(publication.inscriptionId)!;
      if (observation.body.status !== "complete")
        throw new CelError(
          "invalid",
          "ASSET_OBSERVATION",
          "Publication changed during resolution",
        );
      const body = observation.body;
      return (
        body.metadata === null
          ? parseDocument(body.bytes, "json")
          : parseDocument(body.metadata, "cbor")
      ).log;
    });
    const document = validateDocument({ log: entries });
    const catalog = resourceCatalog(document);
    const attachments: ResourceAttachment[] = [];
    const inlineBytes = new Map<string, Uint8Array>();
    for (const publication of resolution.publications) {
      const body = observations.get(publication.inscriptionId)!.body;
      if (
        body.status !== "complete" ||
        body.metadata === null ||
        publication.inlineContentStatus !== "matched"
      )
        continue;
      const key = JSON.stringify([body.mediaType, digestBytes(body.bytes)]);
      if (!inlineBytes.has(key)) inlineBytes.set(key, body.bytes);
    }
    for (const resource of catalog) {
      const bytes = inlineBytes.get(
        JSON.stringify([resource.mediaType, resource.digestMultibase]),
      );
      if (bytes)
        attachments.push(attachment(resource.id, resource.version, bytes));
    }
    const asset = new OriginalsAsset(
      document,
      attachments,
      this.config,
      resolution.state.assetId,
      [],
      this,
    );
    const verification = summarizeVerification(asset, resolution);
    const controller = resolution.state.controller;
    const key = controller.slice("did:key:".length);
    const method = `${controller}#${key}`;
    const didDocument: DIDDocument | null = resolution.state.active
      ? {
          "@context": [
            "https://www.w3.org/ns/did/v1",
            "https://w3id.org/security/multikey/v1",
          ],
          id: did,
          controller: [controller],
          alsoKnownAs: resolution.state.aliases.filter(
            (alias) => alias !== did,
          ),
          verificationMethod: [
            {
              id: method,
              type: "Multikey",
              controller,
              publicKeyMultibase: key,
            },
          ],
          authentication: [method],
          assertionMethod: [method],
        }
      : null;
    return { status: "accepted", asset, verification, resolution, didDocument };
  }

  async resolveDID(did: string): Promise<AssetDIDResolution> {
    const parsed = parseAssetDid(did);
    if (parsed.method !== "btco" || parsed.network !== this.network)
      throw new CelError(
        "invalid",
        "ASSET_NETWORK",
        "Expected a Bitcoin asset DID for the configured network",
      );
    const result = await this.resolve(parsed.sat);
    if (result.status !== "accepted")
      return {
        didDocument: null,
        didResolutionMetadata: { status: result.status, error: result.reason },
        didDocumentMetadata: { scope: "sat", crossSatCanonicality: "unknown" },
      };
    return {
      didDocument: result.didDocument,
      didResolutionMetadata: { status: "accepted" },
      didDocumentMetadata: {
        deactivated: !result.resolution.state.active,
        head: result.resolution.state.head,
        ownership: result.resolution.ownership,
        tip: result.resolution.tip,
        scope: "sat",
        crossSatCanonicality: "unknown",
        webvhBinding: "unverified",
      },
    };
  }
}
