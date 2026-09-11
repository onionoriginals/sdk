import { StructuredError } from "@originals/cel";
import { base58 } from "@scure/base";
import {
  CelError,
  decodeController,
  decodeValue,
  decodeUtf8,
  encodeDocument,
  parseAssetDid,
  assetDigest,
  sameAssetIdentity,
  parseDocument,
  signEvent,
  verifyHistory,
  validateDocument,
  type CelDocument,
  type CelSigner,
} from "@originals/cel/v3";
import { WebVHManager } from "../did/WebVHManager.js";
import { Ed25519Verifier } from "../did/Ed25519Verifier.js";
import type { DIDDocument } from "../types/did.js";
import type { StorageAdapter } from "../storage/StorageAdapter.js";
import { OriginalsAsset } from "./OriginalsAsset.js";
import { attachment, resourceCatalog } from "./resources.js";
import { byteBudget, decodeEnvelope } from "./envelope.js";
import { captureSigner } from "./options.js";
import type { AssetEnvelope, OriginalsConfig, LoadedAsset } from "./types.js";
import type { AssetResolver } from "./resolution.js";

export interface WebPublicationOptions {
  /** Required permanent DNS host. No production/staging default is inferred. */
  domain: string;
  signer?: CelSigner;
  /** Separate Ed25519 method-log custody, if the asset controller uses another suite. */
  webvhSigner?: CelSigner;
  /** Defaults to the anonymous publication namespace plus immutable genesis identity. */
  paths?: string[];
}
export interface PreparedWebPublication {
  format: "originals/web-publication";
  version: 3;
  did: string;
  asset: AssetEnvelope;
  /** The separately signed did:webvh method history, not the CEL. */
  didLog: unknown[];
}
export interface PublishedWebAsset {
  status: "published";
  did: string;
  asset: OriginalsAsset;
  /**
   * 'independently-verified' only when a `publicReachability` check fetched the
   * advertised URL through a path separate from the write-side storage adapter
   * and confirmed it serves this exact method history. 'adapter-asserted' means
   * only the same storage adapter that wrote the log was asked to read it back —
   * true today of every publication with no `publicReachability` configured.
   */
  hostingEvidence: HostingEvidence;
}
export type HostingEvidence = "adapter-asserted" | "independently-verified";
/**
 * Fetches a publicly advertised hosted URL independently of the storage adapter
 * used to write it. Returning `null` means the URL could not be confirmed public;
 * throwing is treated the same way. Core cannot verify the checker itself is
 * independent — only that supplying one is an explicit, non-default choice.
 */
export type PublicReachabilityCheck = (
  url: string,
) => Promise<Uint8Array | null>;
export interface HostedAssetsOptions {
  /** Independent confirmation that the advertised WebVH log is actually public. */
  publicReachability?: PublicReachabilityCheck;
  /**
   * Fail publication instead of silently labeling it 'adapter-asserted' when the
   * advertised log cannot be independently confirmed reachable. Requires
   * `publicReachability` to also be configured.
   */
  requirePublicReachability?: boolean;
}
/**
 * A ready-made `publicReachability` check: a real HTTPS GET, bypassing any
 * configured storage adapter entirely. Bounded so a slow or oversized
 * response (a hung connection, or a host that streams far more than a DID
 * log could ever legitimately be) cannot block or exhaust publication.
 */
export async function fetchPublicReachabilityCheck(
  url: string,
): Promise<Uint8Array | null> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      byteBudget(total);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
export interface HostedEvidence {
  status: "verified" | "incomplete";
  did: string;
  head?: string;
  reason?: string;
}
function location(did: string) {
  const parsed = parseAssetDid(did);
  if (parsed.method !== "webvh")
    throw new CelError(
      "invalid",
      "ASSET_WEBVH",
      "Expected a did:webvh asset alias",
    );
  const url = new URL(parsed.logUrl);
  return {
    domain: url.host,
    prefix: url.pathname.slice(1, -"did.jsonl".length),
  };
}
const error = (code: string, message: string): never => {
  throw new CelError("invalid", code, message);
};

/** Hosted discovery with independently verified method and asset histories, using explicit storage. */
export class HostedAssets {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly config: OriginalsConfig,
    private readonly hostingOptions: HostedAssetsOptions = {},
  ) {}

  async prepare(
    asset: OriginalsAsset,
    options: WebPublicationOptions,
  ): Promise<PreparedWebPublication> {
    if (
      !["cel", "webvh"].includes(asset.state.layer) ||
      (asset.state.layer === "cel" && !asset.state.active) ||
      asset.localResources.length
    )
      return error(
        "ASSET_WEB_STATE",
        "Publish an active local asset with no unsigned drafts",
      );
    if (typeof options?.domain !== "string" || !options.domain)
      return error(
        "WEBVH_DOMAIN_REQUIRED",
        "Supply the permanent WebVH domain",
      );
    const signer = captureSigner(
      options.signer ??
        this.config.signer ??
        error("NO_SIGNING_KEY", "Publication requires controller custody"),
    );
    if (signer.controller !== asset.state.controller)
      return error("CEL_AUTHORITY", "Only the current controller can publish");
    const methodSigner = captureSigner(options.webvhSigner ?? signer);
    if (methodSigner.algorithm !== "Ed25519")
      return error("WEBVH_SIGNER", "Supply an Ed25519 WebVH method signer");
    // Snapshot before the first await: concurrent edits stay on the caller's local asset.
    const envelope = asset.serialize();
    const state = verifyHistory(envelope.eventLog).state;
    if (state.layer === "webvh") {
      const { domain, prefix } = location(state.alias);
      if (domain !== options.domain || options.paths)
        return error(
          "ASSET_WEBVH_BINDING",
          "An existing hosted identity keeps its permanent domain and path",
        );
      const method = await this.storage.getObject(domain, prefix + "did.jsonl");
      if (!method)
        return error(
          "ASSET_WEB_UNAVAILABLE",
          "Existing WebVH method history is unavailable",
        );
      const didLog = decodeUtf8(method.content)
        .trim()
        .split("\n")
        .map((line) => decodeValue(new TextEncoder().encode(line), "json"));
      await this.method(state.alias, didLog, state.assetId);
      return {
        format: "originals/web-publication",
        version: 3,
        did: state.alias,
        asset: envelope,
        didLog,
      };
    }
    const paths = options.paths ?? [
      "published",
      "anonymous",
      assetDigest(asset.id),
    ];
    const key = methodSigner.controller.slice(8);
    const { prepareDataForSigning } = await import("didwebvh-ts");
    const web = await new WebVHManager().createDIDWebVH({
      domain: options.domain,
      paths,
      alsoKnownAs: [asset.id],
      externalSigner: {
        getVerificationMethodId: () =>
          decodeController(methodSigner.controller).verificationMethod,
        async sign({ document, proof }) {
          const message = await prepareDataForSigning(document, proof);
          return {
            proofValue: "z" + base58.encode(await methodSigner.sign(message)),
          };
        },
      },
      externalVerifier: new Ed25519Verifier(),
      verificationMethods: [
        { id: "#key-0", type: "Multikey", publicKeyMultibase: key },
      ],
      updateKeys: [key],
    });
    const migrated = await signEvent(
      {
        previousEvent: state.head,
        operation: {
          type: "migrate",
          data: {
            profile: "originals/cel/3",
            from: asset.id,
            to: web.did,
            layer: "webvh",
            migratedAt: new Date().toISOString(),
          },
        },
      },
      signer,
    );
    const document = validateDocument({
      log: [...envelope.eventLog.log, migrated],
    });
    verifyHistory(document, { expectedDid: asset.id });
    return {
      format: "originals/web-publication",
      version: 3,
      did: web.did,
      asset: { ...envelope, eventLog: document },
      didLog: web.log,
    };
  }

  private async method(
    did: string,
    log: unknown[],
    expectedDid: string,
  ): Promise<DIDDocument> {
    const { resolveDIDFromLog } = await import("didwebvh-ts");
    const resolved = await resolveDIDFromLog(
      log as Parameters<typeof resolveDIDFromLog>[0],
      { verifier: new Ed25519Verifier() },
    );
    const doc = resolved.doc as unknown as DIDDocument;
    if (
      resolved.did !== did ||
      doc?.id !== did ||
      !doc.alsoKnownAs?.some((alias) => sameAssetIdentity(alias, expectedDid)) ||
      resolved.meta.deactivated
    )
      return error(
        "ASSET_WEBVH_BINDING",
        "WebVH method history does not bind the requested alias to this genesis",
      );
    return doc;
  }

  async publish(
    input: PreparedWebPublication,
    resolver?: AssetResolver,
  ): Promise<PublishedWebAsset> {
    if (
      this.hostingOptions.requirePublicReachability &&
      !this.hostingOptions.publicReachability
    )
      return error(
        "ASSET_WEB_REACHABILITY_CHECK_REQUIRED",
        "Configure a publicReachability check before requiring independent verification",
      );
    const prepared = structuredClone(input);
    const envelope = decodeEnvelope(prepared.asset);
    if (envelope.unverified?.localResources.length)
      return error("ASSET_WEB_STATE", "Unsigned drafts cannot be published");
    if (
      prepared.format !== "originals/web-publication" ||
      prepared.version !== 3
    )
      return error("ASSET_WEB_PUBLICATION", "Unsupported hosted publication");
    const asset = new OriginalsAsset(
      envelope.eventLog,
      envelope.resources,
      this.config,
      envelope.assetId,
      [],
      resolver,
    );
    if (asset.state.alias !== prepared.did || asset.state.layer !== "webvh")
      return error(
        "ASSET_WEBVH_BINDING",
        "Publication alias differs from signed asset history",
      );
    await this.method(prepared.did, prepared.didLog, asset.id);
    const { domain, prefix } = location(prepared.did);
    const write = async (
      path: string,
      content: Uint8Array,
      contentType: string,
    ) => {
      const url = await this.storage.putObject(domain, path, content, {
        contentType,
      });
      if (url !== `https://${domain}/${path}`)
        return error(
          "ASSET_STORAGE_URL",
          "Storage URL differs from the permanent hosted path",
        );
    };
    // Publish CEL last. An incomplete upload cannot advertise a complete asset document.
    try {
      for (const resource of asset.resources) {
        if (!resource.content)
          return error(
            "ASSET_RESOURCE_MISSING",
            "Supply every historical resource before hosted publication",
          );
        await write(
          prefix + "resources/" + resource.digestMultibase,
          resource.content,
          "application/octet-stream",
        );
      }
      await write(
        prefix + "did.jsonl",
        new TextEncoder().encode(
          prepared.didLog.map((entry) => JSON.stringify(entry)).join("\n") +
            "\n",
        ),
        "application/jsonl",
      );
      await write(
        prefix + "cel.json",
        encodeDocument(asset.celLog, "json"),
        "application/cel",
      );
    } catch (cause) {
      throw new StructuredError(
        "ASSET_WEB_PUBLISH_INCOMPLETE",
        "Hosted publication incomplete; retry this same prepared publication",
        {
          publication: prepared,
          cause: cause instanceof Error ? cause.message : "storage failure",
        },
      );
    }
    const hostingEvidence = await this.confirmPublicReachability(
      domain,
      prefix,
      prepared,
    );
    return { status: "published", did: prepared.did, asset, hostingEvidence };
  }

  /**
   * Every write above went through `this.storage`. Reading the result back
   * through that same adapter would only prove the adapter agrees with
   * itself, not that the advertised HTTPS URL is reachable from anywhere
   * else. A configured `publicReachability` check is the one path that asks
   * a source other than the write-side adapter.
   *
   * Comparing exact bytes against the just-written `did.jsonl`, rather than
   * independently re-resolving the fetched log, matters: a log that still
   * resolves to this same DID and asset binding is not necessarily *this*
   * publication — a stale cached copy missing this exact update would
   * resolve just as validly. Only byte-for-byte agreement with what was
   * just published proves the public copy is current, not merely genuine.
   */
  private async confirmPublicReachability(
    domain: string,
    prefix: string,
    prepared: PreparedWebPublication,
  ): Promise<HostingEvidence> {
    const checker = this.hostingOptions.publicReachability;
    if (!checker) return "adapter-asserted";
    const published = new TextEncoder().encode(
      prepared.didLog.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    let verified = false;
    try {
      const fetched = await checker(`https://${domain}/${prefix}did.jsonl`);
      verified = !!fetched && bytesEqual(fetched, published);
    } catch {
      verified = false;
    }
    if (verified) return "independently-verified";
    if (this.hostingOptions.requirePublicReachability)
      throw new StructuredError(
        "ASSET_WEB_PUBLIC_UNREACHABLE",
        "Publication wrote successfully but the advertised DID log is not independently reachable at its public URL; retry once hosting is public",
        { publication: prepared },
      );
    return "adapter-asserted";
  }

  async read(
    did: string,
  ): Promise<{
    document: CelDocument;
    envelope: AssetEnvelope;
    didDocument: DIDDocument;
  }> {
    const { domain, prefix } = location(did);
    const cel = await this.storage.getObject(domain, prefix + "cel.json");
    const method = await this.storage.getObject(domain, prefix + "did.jsonl");
    if (!cel || !method)
      return error(
        "ASSET_WEB_UNAVAILABLE",
        "Hosted CEL or WebVH method history unavailable",
      );
    byteBudget(cel.content.length + method.content.length);
    const document = parseDocument(cel.content, "json"),
      history = verifyHistory(document);
    if (!history.state.aliases.includes(did))
      return error(
        "ASSET_WEBVH_BINDING",
        "Hosted CEL does not contain the requested alias",
      );
    const log = decodeUtf8(method.content)
      .trim()
      .split("\n")
      .map((line) => decodeValue(new TextEncoder().encode(line), "json"));
    const didDocument = await this.method(did, log, history.state.assetId);
    const resources = [];
    let total = 0;
    for (const resource of resourceCatalog(document)) {
      const body = await this.storage.getObject(
        domain,
        prefix + "resources/" + resource.digestMultibase,
      );
      if (!body)
        return error(
          "ASSET_RESOURCE_MISSING",
          "Hosted historical resource is unavailable",
        );
      total += body.content.length;
      byteBudget(total);
      // The signed descriptor owns media interpretation. Transport metadata
      // is unsigned and can be shared by equal bytes used under different types.
      resources.push(attachment(resource.id, resource.version, body.content));
    }
    const envelope: AssetEnvelope = {
      format: "originals/asset",
      version: 4,
      assetId: history.state.assetId,
      eventLog: document,
      resources,
    };
    // Performs digest/reference matching, including hostile substituted media.
    new OriginalsAsset(document, resources, {}, history.state.assetId);
    return { document, envelope, didDocument };
  }

  async check(did: string, expectedDid: string): Promise<HostedEvidence> {
    try {
      const read = await this.read(did);
      const state = verifyHistory(read.document).state;
      return sameAssetIdentity(state.assetId, expectedDid)
        ? { status: "verified", did, head: state.head }
        : { status: "incomplete", did, reason: "Genesis mismatch" };
    } catch {
      return {
        status: "incomplete",
        did,
        reason: "Hosted method, history or bytes could not be verified",
      };
    }
  }

  async resolve(did: string, resolver: AssetResolver): Promise<LoadedAsset> {
    const { envelope } = await this.read(did);
    const asset = new OriginalsAsset(
      envelope.eventLog,
      envelope.resources,
      this.config,
      envelope.assetId,
      [],
      resolver,
    );
    return { asset, verification: await asset.verification() };
  }
}
