import type { ContentValidator } from "./content-validation.js";
import type { ChainValidator } from "./chain-validation.js";
import type { HostedAssets, HostedEvidence } from "./hosted.js";
import {
  CelError,
  parseAssetAlias,
  parseDocument,
  resolveSat,
  validateDocument,
  digestBytes,
  type SatSnapshot,
  type SatResolution,
  type ResourceAvailabilityRecord,
  type BitcoinNetwork,
  type ChainEvidence,
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
/**
 * A second, independently configured Ordinals index consulted for its
 * inscription enumeration and current sat ownership observation, to
 * corroborate that the primary provider did not omit a publication or
 * misreport who currently holds the sat. `label` is a non-secret
 * description of the source (never credentials or a full URL) carried into
 * resolution metadata.
 */
export interface IndependentEnumerationSource {
  label: string;
  provider: SatProvider;
}
export interface AssetResolutionOptions {
  expectedAssetId?: string;
}
/**
 * Whether one historical resource version's bytes are recoverable from the accepted
 * Bitcoin inscriptions alone ("bitcoin-inline"), or depend on a separate off-chain host
 * ("referenced"). At most one current resource is inlined per publication (see
 * `inlineResourceId` on `prepareBitcoinPublication`), so a multi-resource asset commonly
 * has both kinds at once; "referenced" is the expected, by-design state for the rest,
 * not a defect.
 */
export type ResourceAvailability = ResourceAvailabilityRecord;
export type AssetResolution =
  | Exclude<SatResolution, { status: "accepted" }>
  | {
      status: "accepted";
      asset: OriginalsAsset;
      verification: AssetVerification;
      resolution: Extract<SatResolution, { status: "accepted" }>;
      didDocument: DIDDocument | null;
      /** One entry per historical resource version in the accepted log, oldest first. */
      resourceAvailability: ResourceAvailability[];
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
    chainEvidence: Readonly<ChainEvidence>;
    /** Unconfirmed publication ids observed for this sat, present only when `didResolutionMetadata.status` is `"pending"`. */
    pending?: readonly string[];
    /** See `SatResolution.trajectoryAssurance`: ownership is a snapshot fact, never an independently derived transfer path. */
    trajectoryAssurance?: "not-independently-derived";
    enumerationAssurance?: "provider-asserted" | "cross-checked";
    /** The independent source's non-secret label, present only when `enumerationAssurance` is `"cross-checked"`. */
    enumerationSource?: string;
    ownershipAssurance?: "provider-asserted" | "cross-checked";
    contentAssurance?: "provider-asserted" | "cross-checked";
  };
}

export function btcoDid(sat: string, network: BitcoinNetwork): string {
  const did = `did:btco:${network === "mainnet" ? "" : network === "regtest" ? "reg:" : network === "signet" ? "sig:" : "test:"}${sat}`;
  parseAssetAlias(did);
  return did;
}
const failure = (
  status: Exclude<SatResolution["status"], "accepted" | "pending">,
  reason: string,
  chainEvidence: Readonly<ChainEvidence> = { assurance: "provider-asserted" },
): AssetResolution => ({
  status,
  reason,
  scope: "sat",
  crossSatCanonicality: "unknown",
  chainEvidence,
});
/**
 * Shared by `check()` and `resolveDID()`: a syntactically valid alias that parses
 * successfully but names a different layer/network than this resolver is configured
 * for is an ordinary resolution outcome, not a thrown error — only a malformed
 * identifier should fail parsing itself (see `parseAssetAlias`).
 */
const layerNetworkMismatch = (): {
  status: "identity-mismatch";
  reason: string;
  scope: "sat";
  crossSatCanonicality: "unknown";
  chainEvidence: Readonly<ChainEvidence>;
} => ({
  status: "identity-mismatch",
  reason: "Asset layer or network differs from configured provider",
  scope: "sat",
  crossSatCanonicality: "unknown",
  chainEvidence: { assurance: "unavailable" },
});
const validChainTip = (tip: unknown): tip is SatSnapshot["tipBefore"] => {
  const t = tip as { height?: unknown; hash?: unknown } | null | undefined;
  return (
    !!t &&
    Number.isSafeInteger(t.height) &&
    (t.height as number) >= 0 &&
    typeof t.hash === "string" &&
    /^[0-9a-f]{64}$/.test(t.hash)
  );
};
const sameChainTip = (a: SatSnapshot["tipBefore"], b: SatSnapshot["tipBefore"]) =>
  a.height === b.height && a.hash === b.hash;
/**
 * A second source can only corroborate enumeration completeness if its own
 * observation was itself complete, healthy and stable. An independent
 * snapshot that fails these is unusable evidence, not weaker evidence: it
 * must not be able to confer "cross-checked" by reporting less. Equal tips
 * are not enough on their own — two identical malformed values would still
 * satisfy a bare equality check, so each tip's own shape is validated first.
 */
const usableIndependentSnapshot = (snapshot: SatSnapshot): boolean =>
  snapshot.enumerationComplete === true &&
  snapshot.indexHealthy === true &&
  Array.isArray(snapshot.publications) &&
  validChainTip(snapshot.tipBefore) &&
  validChainTip(snapshot.tipAfter) &&
  validChainTip(snapshot.indexTip) &&
  sameChainTip(snapshot.tipBefore, snapshot.tipAfter) &&
  sameChainTip(snapshot.tipBefore, snapshot.indexTip);

/** No cache or creator-local boundary map: every call obtains and checks a fresh complete observation. */
export class AssetResolver {
  constructor(
    readonly network: BitcoinNetwork,
    private readonly provider?: SatProvider,
    private readonly config: OriginalsConfig = {},
    private readonly hosted?: HostedAssets,
    private readonly chainValidator?: ChainValidator,
    private readonly independentEnumeration?: IndependentEnumerationSource,
    private readonly contentValidator?: ContentValidator,
  ) {}

  async checkWeb(did: string, expectedAssetId: string): Promise<HostedEvidence> {
    return this.hosted
      ? this.hosted.check(did, expectedAssetId)
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
          { assurance: "unavailable" },
        ) as SatResolution,
      };
    let obtainedSnapshot = false;
    try {
      const snapshot = structuredClone(await this.provider.getSatSnapshot(sat));
      obtainedSnapshot = true;
      if (snapshot?.sat !== sat || snapshot.network !== this.network)
        return {
          resolution: failure(
            "inconsistent-evidence",
            "Provider snapshot differs from requested sat or network",
          ) as SatResolution,
        };
      let chainEvidence: Readonly<ChainEvidence> = { assurance: "provider-asserted" };
      if (this.chainValidator) {
        // The validator is selected by application configuration, never by snapshot
        // fields or an advertised provider method. A detached copy protects the
        // exact view subsequently resolved from mutation during asynchronous checks.
        const validated = await this.chainValidator(structuredClone(snapshot));
        chainEvidence = Object.freeze({ assurance: "node-validated",
          ...(validated?.source ? { source: validated.source } : {}) });
      }
      let independentEnumeration:
        | {
            source: string;
            inscriptionIds: string[];
            ownership?: SatSnapshot["ownership"];
          }
        | undefined;
      if (this.independentEnumeration) {
        // A configured independent source that cannot be consulted fails
        // closed, the same as a configured chain validator: it must not be
        // possible to silently fall back to an unqualified provider claim
        // by making the second source unreachable.
        let independentSnapshot: SatSnapshot;
        try {
          independentSnapshot = structuredClone(
            await this.independentEnumeration.provider.getSatSnapshot(sat),
          );
        } catch {
          return {
            resolution: failure(
              "incomplete",
              "Independent enumeration source did not return a usable observation",
              chainEvidence,
            ) as SatResolution,
          };
        }
        if (
          independentSnapshot?.sat !== sat ||
          independentSnapshot.network !== this.network
        )
          return {
            resolution: failure(
              "inconsistent-evidence",
              "Independent enumeration source snapshot differs from requested sat or network",
              chainEvidence,
            ) as SatResolution,
          };
        // An incomplete, unhealthy or unstable independent snapshot must
        // not confer "cross-checked": an empty or partial enumeration list
        // trivially never disagrees with the primary snapshot, so a broken
        // or dishonest second source could otherwise earn full assurance by
        // reporting nothing at all.
        if (!usableIndependentSnapshot(independentSnapshot))
          return {
            resolution: failure(
              "incomplete",
              "Independent enumeration source did not report a complete, healthy, stable observation",
              chainEvidence,
            ) as SatResolution,
          };
        // A self-consistent independent snapshot can still be honestly behind
        // the primary's tip: it has indexed no further than its own chain
        // view, marked that view "complete", and truthfully reports whatever
        // it has seen so far — which can be an empty or partial publication
        // list for a sat the primary already resolved further ahead. Such a
        // list trivially never contains anything "absent from the primary
        // snapshot", so without a tip check a lagging (or dishonest) source
        // could earn full corroboration by having observed nothing at all.
        // Require the independent source to describe the same chain tip as
        // the primary before either cross-check can apply, mirroring the
        // ownership-only gate this used to be: a lagging source's report
        // simply sits out this round rather than failing resolution or
        // being credited as corroboration it never performed.
        if (sameChainTip(independentSnapshot.tipBefore, snapshot.tipBefore)) {
          independentEnumeration = {
            source: this.independentEnumeration.label,
            inscriptionIds: independentSnapshot.publications.map((p) => p.id),
            ownership: independentSnapshot.ownership,
          };
        }
      }
      // Validate the snapshot's own structure/chain-position claims locally
      // before spending an external RPC round trip on it: a snapshot that
      // resolveSat would reject anyway (bad block hash, wrong sat/network,
      // inconsistent reveal position) should surface that deterministic
      // reason rather than an unrelated content-validator failure, and never
      // burns a request against the independently trusted node for data
      // that was never going to be accepted regardless of its content.
      const baseline = resolveSat(snapshot, { ...options, independentEnumeration });
      if (baseline.status !== "accepted" || !this.contentValidator)
        return { snapshot, resolution: Object.freeze({ ...baseline, chainEvidence }) };
      // A configured content validator that cannot be consulted fails closed,
      // the same as a configured chain/enumeration validator: it must not be
      // possible to silently fall back to an unqualified provider claim by
      // making the independent source unreachable.
      let independentContent: Awaited<ReturnType<ContentValidator>>;
      try {
        // Preserve the exact snapshot already corroborated by the other checks.
        independentContent = await this.contentValidator(
          structuredClone(snapshot),
          baseline.publications.map((publication) => publication.inscriptionId),
        );
      } catch {
        return {
          resolution: Object.freeze({
            ...(failure(
              "incomplete",
              "Independent content validation is unavailable",
            ) as SatResolution),
            chainEvidence,
          }),
        };
      }
      return {
        snapshot,
        resolution: Object.freeze({
          ...resolveSat(snapshot, { ...options, independentEnumeration, independentContent }),
          chainEvidence,
        }),
      };
    } catch (error) {
      return {
        resolution: failure(
          error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "SAT_SNAPSHOT_CHAIN_CHANGED"
            ? "chain-changed"
            : "incomplete",
          "The provider or configured validator could not establish a complete sat snapshot",
          { assurance: obtainedSnapshot ? "provider-asserted" : "unavailable" },
        ) as SatResolution,
      };
    }
  }

  async check(did: string, expectedAssetId: string): Promise<SatResolution> {
    const parsed = parseAssetAlias(did);
    if (parsed.layer !== "btco" || parsed.network !== this.network)
      return layerNetworkMismatch();
    return (await this.observe(parsed.sat, { expectedAssetId })).resolution;
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
    const resourceAvailability: ResourceAvailability[] = [];
    for (const resource of catalog) {
      const key = JSON.stringify([resource.mediaType, resource.digestMultibase]);
      const bytes = inlineBytes.get(key);
      if (bytes)
        attachments.push(attachment(resource.id, resource.version, bytes));
      resourceAvailability.push({
        id: resource.id,
        version: resource.version,
        availability: bytes ? "bitcoin-inline" : "referenced",
      });
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
    return {
      status: "accepted",
      asset,
      verification,
      resolution,
      didDocument,
      resourceAvailability,
    };
  }

  async resolveDID(did: string): Promise<AssetDIDResolution> {
    const parsed = parseAssetAlias(did);
    if (parsed.layer !== "btco" || parsed.network !== this.network) {
      const mismatch = layerNetworkMismatch();
      return {
        didDocument: null,
        didResolutionMetadata: {
          status: mismatch.status,
          error: mismatch.reason,
        },
        didDocumentMetadata: {
          scope: "sat",
          crossSatCanonicality: "unknown",
          chainEvidence: mismatch.chainEvidence,
        },
      };
    }
    const result = await this.resolve(parsed.sat);
    if (result.status !== "accepted")
      return {
        didDocument: null,
        didResolutionMetadata: { status: result.status, error: result.reason },
        didDocumentMetadata: {
          scope: "sat",
          crossSatCanonicality: "unknown",
          chainEvidence: result.chainEvidence,
          ...(result.status === "pending" ? { pending: result.pending } : {}),
        },
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
        chainEvidence: result.resolution.chainEvidence,
        trajectoryAssurance: result.resolution.trajectoryAssurance,
        enumerationAssurance: result.resolution.enumerationAssurance,
        enumerationSource: result.resolution.enumerationSource,
        ownershipAssurance: result.resolution.ownershipAssurance,
        contentAssurance: result.resolution.contentAssurance,
      },
    };
  }
}
