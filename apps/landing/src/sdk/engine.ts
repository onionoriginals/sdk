/**
 * The browser creator flow on the Originals Protocol (plan 011, PR 5).
 *
 * Each Original is a did:vh whose log is signed by its author's DID (P5.2,
 * P5.3). A signed-in visitor authors as their did:webvh, with the Turnkey
 * authorship key published as its `#key-1` assertionMethod. A visitor who is
 * not signed in authors as a did:vh created in this page (`local-author.ts`).
 *
 * Create and revise work today, and an Original's evidence package can be
 * downloaded and verified anywhere without a key. Web publication and Bitcoin
 * anchoring return with later phases (`features.ts`); until then `publish` and
 * `inscribe` refuse by name rather than doing something else.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { MemoryStore, OriginalsSDK, type OriginalView, type OriginalsSigner } from "@originals/sdk/originals";
import type { AliasEvidence, AuthorDidEvidence, AuthorRef } from "@originals/vh/originals";
import { didWebvhLogUrl } from "@originals/vh/webvh";
import { base58AddressToEd25519Multikey } from "@originals/sdk";
import { parseJson } from "@originals/vh/json";
import { ensureAuthorshipAccount, ensureIdentityAccount, type TurnkeyBitcoinClient } from "../auth/turnkey-session";
import { DEFAULT_WEBVH_DOMAIN, TurnkeyWebVHSigner, readUserWebVHDid, userWebvhSlug, type WebVHSigner } from "../auth/webvh";
import { FEATURES, type Feature } from "./features";
import { publishOriginal, type HostedUpload } from "./publish";
import { DurableHostingStorageAdapter } from "./durable-hosting-adapter";
import { short } from "./format";
import { createLocalAuthor } from "./local-author";
import { btcNetwork, demoTier, type BtcNetworkFlag, type DemoTier } from "./network-flag";
import { contentBytes, contentText, resourceView, type ResourceContent } from "./resource-view";
import { authorshipPublicKeyMultibase, turnkeyAuthorshipSigner } from "./turnkey-authorship-signer";

export { short };
export { btcNetwork, btcRealEnabled, btcRealFor, btcoExplorerUrl, demoTier } from "./network-flag";
export type { DemoTier } from "./network-flag";
export { ANON_IDENTITY, engineIdentity } from "./engine-identity";

export type LayerId = "did:vh" | "did:webvh" | "did:btco";

export interface DemoEvent {
  type: string;
  at: string;
  summary: string;
  payload: unknown;
}

/** One entry of the Original's asset log, for display. */
export interface HistoryEntry {
  versionId: string;
  versionTime: string;
  operation: string;
  /** The author verification method that signed it. */
  authorKey: string;
  /** Resource changes: id and new digest. */
  changes: Array<{ resource: string; to: string }>;
  name: string;
}

export interface DemoAssetState {
  layer: LayerId;
  did: string;
  webvhDid?: string;
  webvhLogUrl?: string;
  webvhResolved?: boolean;
  btcoDid?: string;
  author: string;
  resource: {
    id: string;
    hash: string;
    contentType: string;
    content: ResourceContent;
    version: number;
  };
  metadata?: {
    id: string;
    hash: string;
    content: string;
  };
  credentials: number;
  history: HistoryEntry[];
  inscription?: {
    txid: string;
    inscriptionId: string;
    satoshi: string;
    commitTxId?: string;
    feeRate?: number;
    explorerUrl?: string;
  };
  /** The verification report of the current checkpoint. */
  provenance: unknown;
}

export interface AssetSource {
  content: ResourceContent;
  contentType: string;
  filename: string;
}

/** A refusal for a feature that waits on a later phase. */
export class FeatureUnavailableError extends Error {
  constructor(public readonly feature: "hostedPublication" | "bitcoinAnchoring", message: string) {
    super(message);
    this.name = "FeatureUnavailableError";
  }
}

type Listener = (event: DemoEvent) => void;

interface LogLine {
  versionId: string;
  versionTime: string;
  state: {
    operation: string;
    author: { verificationMethod: string };
    transitions: Array<{ resource: string; to: string }>;
    asset: { name: string };
  };
}

/** Where an Original is published, and the key that controls its alias (P3.7). */
export interface PublishTarget {
  upload: HostedUpload;
  domain: string;
  slug: string;
  aliasSigner: () => Promise<WebVHSigner>;
}

interface Authoring {
  ref: AuthorRef;
  signer: OriginalsSigner;
  evidence: AuthorDidEvidence;
}

const consoleTag = "color:#f7931a;font-weight:600;font-family:ui-monospace,monospace";
function log(kind: string, detail: unknown) {
  console.log(`%c[originals-sdk] ${kind}`, consoleTag, detail);
}

export class DemoEngine {
  private readonly authed: boolean;
  private readonly subOrgId?: string;
  private readonly listeners = new Set<Listener>();
  private readonly store = new MemoryStore();
  private authoring: Authoring | null = null;
  private sdk: OriginalsSDK | null = null;
  private did: string | null = null;
  private view: OriginalView | null = null;
  /** The committed log and resource bytes, cached for display after each commit. */
  private logEntries: LogLine[] = [];
  private readonly bytes = new Map<string, Uint8Array>();
  readonly tier: DemoTier;
  /** The last Bitcoin submission; always null until anchoring returns (PR 10). */
  lastSubmission: { broadcast?: string } | null = null;

  private readonly features: Record<Feature, boolean>;
  private readonly target?: PublishTarget;
  private alias: AliasEvidence | null = null;

  constructor(opts?: {
    authed?: boolean;
    subOrgId?: string;
    networkFlag?: BtcNetworkFlag;
    /** Overrides FEATURES, for tests. */
    features?: Partial<Record<Feature, boolean>>;
    /** Overrides the signed-in account's host and Turnkey identity key, for tests. */
    publishTarget?: PublishTarget;
  }) {
    this.authed = opts?.authed ?? false;
    this.subOrgId = opts?.subOrgId;
    this.features = { ...FEATURES, ...opts?.features };
    this.target = opts?.publishTarget;
    (globalThis as Record<string, unknown>).__originalsDemo = this;
    this.tier = demoTier(opts?.networkFlag ?? btcNetwork(), this.authed);
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(type: string, summary: string, payload: unknown) {
    log(type, payload);
    const event: DemoEvent = { type, at: new Date().toISOString(), summary, payload };
    for (const l of this.listeners) l(event);
  }

  /** The author this engine signs as, set up once per engine. */
  private async author(): Promise<Authoring> {
    if (this.authoring) return this.authoring;
    this.authoring = this.authed ? await this.signedInAuthor() : await createLocalAuthor();
    this.sdk = OriginalsSDK.create({
      store: this.store,
      authors: [this.authoring.evidence],
      // This page holds or just read the author's own DID, so it vouches for its freshness (P7.8).
      freshness: "asserted",
    });
    this.emit("authorship:key", `Authoring as ${short(this.authoring.ref.did)}`, { author: this.authoring.ref });
    return this.authoring;
  }

  private async signedInAuthor(): Promise<Authoring> {
    if (!this.subOrgId) throw new Error("Sign in again to restore your authorship key.");
    const found = await readUserWebVHDid({ subOrgId: this.subOrgId, hosting: new DurableHostingStorageAdapter() });
    if (!found) throw new Error("Create your DID first: Originals are signed by your DID's authorship key.");
    const document = found.didDocument as { verificationMethod?: Array<{ id?: string; publicKeyMultibase?: string }> };
    const verificationMethod = `${found.did}#key-1`;
    const listed = document?.verificationMethod?.find((vm) => vm.id === verificationMethod || vm.id === "#key-1");
    const { openSessionKey } = await import("../auth/turnkey-browser-client");
    const handle = await openSessionKey(this.subOrgId);
    const client = handle.client as unknown as TurnkeyBitcoinClient;
    const address = await ensureAuthorshipAccount(client, this.subOrgId);
    if (!listed || listed.publicKeyMultibase !== authorshipPublicKeyMultibase(address)) {
      throw new Error("Your DID does not list your authorship key as #key-1, so it cannot sign Originals.");
    }
    const entries = Array.isArray(found.didLog) ? (found.didLog as Array<{ versionId: string }>) : [];
    const versionId = entries[entries.length - 1]?.versionId;
    if (!versionId) throw new Error("Your DID log could not be read.");
    return {
      ref: { did: found.did, verificationMethod, versionId },
      signer: turnkeyAuthorshipSigner({ client, subOrgId: this.subOrgId, signWith: address, verificationMethod }),
      evidence: { did: found.did, log: entries },
    };
  }

  async create(title: string, style: string, source: string | AssetSource): Promise<DemoAssetState> {
    const src = asSource(source);
    const artwork = contentBytes(src.content);
    const metadata = new TextEncoder().encode(buildMetadata({
      title, style, created: new Date().toISOString(), artworkHash: toHex(sha256(artwork)), artworkFile: src.filename,
    }));
    const { ref, signer } = await this.author();
    const result = await this.sdk!.create({
      name: title,
      resources: [
        { id: src.filename, mediaType: src.contentType, bytes: artwork },
        { id: "metadata.json", mediaType: "application/json", bytes: metadata },
      ],
      author: ref,
      signer,
    });
    if (result.kind !== "original") throw new Error("The Original was not signed.");
    this.did = result.original.did;
    this.view = result.original;
    await this.refresh();
    this.emit("asset:created", `Created ${short(this.did)}, signed by ${short(ref.did)}`, { did: this.did, checkpoint: this.view.checkpoint });
    return this.snapshot();
  }

  async update(title: string, style: string, source: string | AssetSource): Promise<DemoAssetState> {
    if (!this.did || !this.view) throw new Error("Create an asset first");
    const { ref, signer } = await this.author();
    const current = this.snapshot();
    const src = asSource(source);
    // The artwork keeps its resource id; only its bytes change (P4.1).
    const artwork = contentBytes(src.content);
    const artworkHash = toHex(sha256(artwork));
    const metadata = current.metadata
      ? buildMetadata({ title, style, created: createdAtOf(current.metadata.content), artworkHash, artworkFile: current.resource.id })
      : undefined;
    // Nothing changed: no entry. An empty signed entry would tell a reader
    // something changed when nothing did.
    if (
      artworkHash === current.resource.hash &&
      src.contentType === current.resource.contentType &&
      title === this.view.state.name &&
      (metadata === undefined || metadata === current.metadata?.content)
    ) {
      return current;
    }
    const result = await this.sdk!.edit(this.did, {
      parent: this.view.checkpoint,
      name: title,
      resources: [
        { id: current.resource.id, bytes: artwork, mediaType: src.contentType },
        ...(metadata && current.metadata ? [{ id: current.metadata.id, bytes: new TextEncoder().encode(metadata) }] : []),
      ],
      author: ref,
      signer,
    });
    this.view = result.original;
    await this.refresh();
    this.emit("asset:updated", `Revised ${short(this.did)} at ${short(this.view.checkpoint)}`, { checkpoint: this.view.checkpoint });
    return this.snapshot();
  }

  /**
   * Publish to the web (plan 011, PR 8): a did:webvh alias in the author's own
   * namespace, the publish entry, and the hosted files (./publish.ts). Off until
   * the owner's public-host proof passes (owner decision Q13). A retry reuses
   * the alias and repeats the same snapshot (P9.2).
   */
  async publish(): Promise<DemoAssetState> {
    if (!this.features.hostedPublication) {
      throw new FeatureUnavailableError("hostedPublication", "Publishing to the web is not open yet.");
    }
    if (!this.did || !this.view || !this.sdk) throw new Error("Create an asset first");
    const authoring = await this.author();
    const target = this.target ?? this.accountTarget();
    const result = await publishOriginal({
      sdk: this.sdk,
      did: this.did,
      parent: this.view.checkpoint,
      author: authoring.ref,
      signer: authoring.signer,
      aliasSigner: await target.aliasSigner(),
      domain: target.domain,
      slug: target.slug,
      hosting: target.upload,
      ...(this.alias ? { alias: this.alias } : {}),
    });
    this.alias = result.alias;
    this.view = await this.sdk.get(this.did);
    await this.refresh();
    this.emit("asset:published", `Published ${short(this.did)} as ${short(result.alias.did)}`, { alias: result.alias.did, baseUrl: result.baseUrl });
    return this.snapshot();
  }

  /** The signed-in account's host namespace, with its Turnkey identity key controlling the alias. */
  private accountTarget(): PublishTarget {
    const subOrgId = this.subOrgId;
    if (!this.authed || !subOrgId) throw new Error("Sign in to publish: an Original's web address lives in your account.");
    return {
      upload: new DurableHostingStorageAdapter(),
      domain: DEFAULT_WEBVH_DOMAIN,
      slug: userWebvhSlug(subOrgId),
      aliasSigner: async () => {
        const { openSessionKey } = await import("../auth/turnkey-browser-client");
        const client = (await openSessionKey(subOrgId)).client as unknown as TurnkeyBitcoinClient;
        const address = await ensureIdentityAccount(client, subOrgId);
        return new TurnkeyWebVHSigner(client, subOrgId, address, base58AddressToEd25519Multikey(address));
      },
    };
  }

  /** Bitcoin anchoring returns with plan 011, PR 10. */
  inscribe(_opts?: unknown): Promise<DemoAssetState> {
    return Promise.reject(new FeatureUnavailableError("bitcoinAnchoring", "Anchoring on Bitcoin returns with the Bitcoin phase of the Originals Protocol."));
  }

  /** The Original's evidence package (a ZIP), verifiable offline by anyone (spec section 7). */
  async evidencePackage(): Promise<Uint8Array> {
    if (!this.did) throw new Error("Create an asset first");
    return (await this.sdk!.package(this.did)).bytes;
  }

  snapshot(): DemoAssetState {
    const view = this.view;
    if (!view || !this.did) throw new Error("No asset yet");
    const state = view.state;
    const [primary, ...rest] = state.resources;
    const meta = rest.find((r) => r.id === "metadata.json");
    const versionOf = (id: string) => view.resources.filter((r) => r.resource === id).length;
    const bytesOf = (digest: string) => this.bytes.get(digest) ?? new Uint8Array();
    const alias = state.aliases[0];
    return {
      layer: alias ? "did:webvh" : "did:vh",
      did: this.did,
      ...(alias ? { webvhDid: alias, webvhLogUrl: didWebvhLogUrl(alias) } : {}),
      author: view.report.identityEvidence.author ?? "",
      resource: {
        id: primary.id,
        hash: hexOfDigest(primary.digest),
        contentType: primary.mediaType,
        content: resourceView(bytesOf(primary.digest), primary.mediaType),
        version: versionOf(primary.id),
      },
      metadata: meta ? { id: meta.id, hash: hexOfDigest(meta.digest), content: contentText(bytesOf(meta.digest)) } : undefined,
      credentials: 0,
      history: this.history(),
      provenance: view.report,
    };
  }

  private history(): HistoryEntry[] {
    return this.logEntries.map((entry) => ({
      versionId: entry.versionId,
      versionTime: entry.versionTime,
      operation: entry.state.operation,
      authorKey: entry.state.author.verificationMethod,
      changes: entry.state.transitions.map((t) => ({ resource: t.resource, to: t.to })),
      name: entry.state.asset.name,
    }));
  }

  /** Refresh the cached log and bytes from the store after each commit. */
  private async refresh(): Promise<void> {
    if (!this.did) return;
    const stored = await this.store.get(this.did);
    const text = stored?.log ?? "";
    this.logEntries = text.trimEnd().split("\n").filter(Boolean).map((line) => parseJson(line) as unknown as LogLine);
    for (const v of this.view?.resources ?? []) {
      const bytes = await this.store.getResource(v.digest);
      if (bytes) this.bytes.set(v.digest, bytes);
    }
  }
}

function asSource(source: string | AssetSource): AssetSource {
  return typeof source === "string" ? { content: source, contentType: "image/svg+xml", filename: "artwork.svg" } : source;
}

function buildMetadata(input: { title: string; style: string; created: string; artworkHash: string; artworkFile: string }): string {
  return JSON.stringify(
    { title: input.title, style: input.style, creator: "you", created: input.created, artwork: { file: input.artworkFile, sha256: input.artworkHash } },
    null,
    2,
  );
}

function createdAtOf(metadataJson: string): string {
  try {
    const created = (JSON.parse(metadataJson) as { created?: unknown }).created;
    if (typeof created === "string" && created) return created;
  } catch {
    // Fall through to now.
  }
  return new Date().toISOString();
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The SHA-256 hex inside a `z…` sha2-256 multihash digest. */
function hexOfDigest(digest: string): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of digest.slice(1)) n = n * 58n + BigInt(alphabet.indexOf(c));
  const hex = n.toString(16).padStart(68, "0");
  return hex.slice(4);
}
