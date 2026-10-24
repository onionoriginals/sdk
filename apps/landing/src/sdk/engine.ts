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
import { MemoryStore, OriginalsSDK, btcoAlias, type EditInput, type HostedFetch, type OriginalView, type OriginalsSigner, type OriginalsStore, type SharedHost, type SubmitResult } from "@originals/sdk/originals";
import type { OffChainEvidence } from "@originals/sdk/originals/bitcoin";
import type { BitcoinSigner, Utxo } from "@originals/sdk";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import type { AliasEvidence, AuthorDidEvidence, AuthorRef } from "@originals/vh/originals";
import { didWebvhLogUrl } from "@originals/vh/webvh";
import { base58AddressToEd25519Multikey } from "@originals/sdk";
import { parseJson } from "@originals/vh/json";
import { ensureAuthorshipAccount, ensureIdentityAccount, fundingSignerAddress, type TurnkeyBitcoinClient } from "../auth/turnkey-session";
import {
  AnchoringSubmitError, guardedSign, httpAnchoringTransport, indexedDbOutbox, publishNextEntry, resendWaiting, signingGuard,
  type AnchoringOutbox, type AnchoringStatus, type AnchoringTransport, type PublishNextResult, type SubmitAnswer,
} from "./anchoring";
import { HttpOrdinalsProvider } from "./http-ordinals-provider";
import { TurnkeySatSigner } from "./turnkey-sat-signer";
import { TurnkeyWebVHSigner, readUserWebVHDid, userWebvhSlug, type WebVHSigner } from "../auth/webvh";
import { webvhDomain } from "../auth/webvh-domain";
import { FEATURES, type Feature } from "./features";
import { publishOriginal, type HostedUpload } from "./publish";
import { landingSharedHost, type SubmitTransport } from "./shared-host";
import { DurableHostingStorageAdapter } from "./durable-hosting-adapter";
import { short } from "./format";
import { StampedAuthorEvidence } from "./author-evidence";
import { createLocalAuthor } from "./local-author";
import { IndexedDbStore } from "./idb-store";
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
  /** Resource changes: id and new digest, or null for a removed resource (P4.1, P14.4). */
  changes: Array<{ resource: string; to: string | null }>;
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
  /**
   * The Original's anchoring on Bitcoin (plan 011, PR 10b), reported in parts
   * (section 7): the server's status (publication label, next step, heads,
   * the sat's holder), what the last submission did, and what Bitcoin will
   * not hold (P9.18).
   */
  anchoring?: {
    status: AnchoringStatus | null;
    lastSent?: SubmitAnswer;
    offChain?: OffChainEvidence;
    /**
     * Entries committed in this browser after the head Bitcoin accepts, oldest
     * first: still to inscribe, one per block (P9.13). The server's status
     * describes its own copy and cannot see these until they are submitted.
     */
    unpublished: string[];
  };
  /** The verification report of the current checkpoint. */
  provenance: unknown;
}

export interface AssetSource {
  content: ResourceContent;
  contentType: string;
  filename: string;
}

/**
 * A shared-host save refused with a stale-parent conflict (P6.7): someone
 * saved first. The change is kept, signed and labelled refused, and is never
 * published; it needs reconciling against the new head (P6.8).
 */
export class StaleSaveError extends Error {
  constructor(public readonly refused: string, public readonly hostHead: string) {
    super("Someone saved this Original first. Your change is kept as a refused candidate and was not published; reconcile it with the new version.");
    this.name = "StaleSaveError";
  }
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
    transitions: Array<{ resource: string; to: string | null }>;
    asset: { name: string; aliases?: string[] };
  };
}

/** An Original this account's store holds, read from its stored log for a list. `open` verifies it. */
export interface StoredOriginalSummary {
  did: string;
  name: string;
  checkpoint: string;
  published: boolean;
}

/**
 * Where an Original is published, and the key that controls its alias (P3.7).
 * An upload that can also `submit` takes shared-host saves of the published
 * Original (P6.7); `read` fetches its public files (defaults to `fetch`).
 */
export interface PublishTarget {
  upload: HostedUpload & Partial<SubmitTransport>;
  read?: HostedFetch;
  domain: string;
  slug: string;
  aliasSigner: () => Promise<WebVHSigner>;
}

export interface Authoring {
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
  /**
   * Signed in, the account's IndexedDB store, so work survives a browser
   * restart (#976 B, G2). Signed out, a MemoryStore: that work is page-scoped
   * and its key is discarded with the page (B5).
   */
  private store: OriginalsStore | null = null;
  private storeOpening: Promise<OriginalsStore> | null = null;
  private readonly openStoreWith?: () => Promise<OriginalsStore>;
  private readonly authorWith?: () => Promise<Authoring>;
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

  private readonly networkFlag: BtcNetworkFlag;
  private readonly anchoringOpts: AnchoringOptions;
  private anchoring: Omit<NonNullable<DemoAssetState["anchoring"]>, "unpublished"> | undefined = undefined;

  constructor(opts?: {
    authed?: boolean;
    subOrgId?: string;
    networkFlag?: BtcNetworkFlag;
    /** Overrides FEATURES, for tests. */
    features?: Partial<Record<Feature, boolean>>;
    /** Overrides the signed-in account's host and Turnkey identity key, for tests. */
    publishTarget?: PublishTarget;
    /**
     * Overrides the signed-in author (Turnkey `#key-1`), for tests and the
     * regtest journey, which sign with local keys and say so.
     */
    author?: Authoring | (() => Promise<Authoring>);
    /** Overrides how anchoring reaches the network, stores its outbox and signs the commit; for tests and the regtest journey. */
    anchoring?: AnchoringOptions;
    /** Overrides the store, for tests. */
    openStore?: () => Promise<OriginalsStore>;
  }) {
    this.authed = opts?.authed ?? false;
    this.subOrgId = opts?.subOrgId;
    this.features = { ...FEATURES, ...opts?.features };
    this.target = opts?.publishTarget;
    this.authorOverride = typeof opts?.author === "function" ? undefined : opts?.author;
    this.anchoringOpts = opts?.anchoring ?? {};
    this.networkFlag = opts?.networkFlag ?? btcNetwork();
    this.openStoreWith = opts?.openStore;
    this.authorWith = typeof opts?.author === "function" ? opts.author : undefined;
    (globalThis as Record<string, unknown>).__originalsDemo = this;
    this.tier = demoTier(this.networkFlag, this.authed);
  }

  private readonly authorOverride?: Authoring;

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(type: string, summary: string, payload: unknown) {
    log(type, payload);
    const event: DemoEvent = { type, at: new Date().toISOString(), summary, payload };
    for (const l of this.listeners) l(event);
  }

  /** The author DID evidence the SDK reads, with when it was obtained (P7.10). */
  private readonly authorEvidence = new StampedAuthorEvidence();

  /** Hand the SDK new author DID evidence: restamped if it changed, so `obtainedAt` is never a stale setup time. */
  private setAuthorEvidence(evidence: AuthorDidEvidence): void {
    this.authorEvidence.set(evidence);
  }

  /** This engine's store: the account's durable one when signed in and the browser has IndexedDB. */
  private openStore(): Promise<OriginalsStore> {
    this.storeOpening ??= (
      this.openStoreWith
        ? this.openStoreWith()
        : this.authed && this.subOrgId && globalThis.indexedDB
          ? IndexedDbStore.open(this.subOrgId)
          : Promise.resolve(new MemoryStore())
    ).then((store) => (this.store = store));
    return this.storeOpening;
  }

  /** The author this engine signs as, set up once per engine. */
  private async author(): Promise<Authoring> {
    if (this.authoring) return this.authoring;
    const store = await this.openStore();
    this.authoring = this.authorOverride ?? (this.authorWith ? await this.authorWith() : this.authed ? await this.signedInAuthor() : await createLocalAuthor());
    this.setAuthorEvidence(this.authoring.evidence);
    this.sdk = OriginalsSDK.create({
      store,
      // This page holds or just read the author's own DID: the SDK reads it as stamped when it was
      // obtained, restamped whenever it changes. An unanchored Original is still only valid as of
      // its checkpoint, never current (P7.10).
      authors: async (did) => this.authorEvidence.get(did),
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
      signer: turnkeyAuthorshipSigner({
        // Re-auth replaces the session credential, while this Original and its
        // author stay fixed (P5.3). Never retain the expired client's key.
        client: async () => (await openSessionKey(this.subOrgId!)).client as unknown as TurnkeyBitcoinClient,
        subOrgId: this.subOrgId, signWith: address, verificationMethod,
      }),
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
    this.alias = null;
    this.did = result.original.did;
    this.view = result.original;
    await this.refresh();
    this.emit("asset:created", `Created ${short(this.did)}, signed by ${short(ref.did)}`, { did: this.did, checkpoint: this.view.checkpoint });
    return this.snapshot();
  }

  /**
   * The Originals this account's store holds, read from each stored log's
   * last entry: a list, not a verification. `open` verifies.
   */
  async listOriginals(): Promise<StoredOriginalSummary[]> {
    const store = await this.openStore();
    const out: StoredOriginalSummary[] = [];
    for (const did of await store.list()) {
      const log = (await store.get(did))?.log.trimEnd();
      if (!log) continue;
      const last = parseJson(log.slice(log.lastIndexOf("\n") + 1)) as unknown as LogLine;
      out.push({ did, name: last.state.asset.name, checkpoint: last.versionId, published: (last.state.asset.aliases?.length ?? 0) > 0 });
    }
    return out;
  }

  /**
   * Reopen an Original from this account's store (#976 B3), verified as any
   * load is. A published one gets its alias back from the stored evidence,
   * so its revisions go through the host again. Continuing still needs this
   * author's signer: the store holds no key.
   */
  async open(did: string): Promise<DemoAssetState> {
    await this.author();
    const view = await this.sdk!.get(did);
    const aliasDid = view.state.aliases[0];
    const alias = aliasDid ? await this.store!.getAuthorEvidence(aliasDid) : undefined;
    this.did = did;
    this.view = view;
    this.alias = alias?.log !== undefined ? { did: alias.did, log: alias.log, ...(alias.witness === undefined ? {} : { witness: alias.witness }) } : null;
    await this.refresh();
    this.emit("asset:opened", `Opened ${short(did)} at ${short(view.checkpoint)}`, { did, checkpoint: view.checkpoint });
    return this.snapshot();
  }

  async update(title: string, style: string, source: string | AssetSource): Promise<DemoAssetState> {
    if (!this.did || !this.view) throw new Error("Create an asset first");
    const { ref, signer } = await this.author();
    // A save whose answer was lost is sent again first, byte for byte (P6.4).
    await this.retryPending();
    const input = this.changeFor(title, style, source, ref);
    if (!input) return this.snapshot();
    this.view = this.published() ? await this.saveThroughHost(input, signer) : (await this.sdk!.edit(this.did, { ...input, signer })).original;
    await this.refresh();
    this.emit("asset:updated", `Revised ${short(this.did)} at ${short(this.view.checkpoint)}`, { checkpoint: this.view.checkpoint });
    return this.snapshot();
  }

  /** The edit that makes the current version look like this, or undefined when nothing changes. */
  private changeFor(title: string, style: string, source: string | AssetSource, ref: AuthorRef): EditInput | undefined {
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
      title === this.view!.state.name &&
      (metadata === undefined || metadata === current.metadata?.content)
    ) {
      return undefined;
    }
    return {
      parent: this.view!.checkpoint,
      name: title,
      resources: [
        { id: current.resource.id, bytes: artwork, mediaType: src.contentType },
        ...(metadata && current.metadata ? [{ id: current.metadata.id, bytes: new TextEncoder().encode(metadata) }] : []),
      ],
      author: ref,
    };
  }

  /** Published from this engine, with hosted publication on: saves go through the host. */
  private published(): boolean {
    return this.features.hostedPublication && !!this.alias && !!this.view?.state.aliases.includes(this.alias.did);
  }

  /**
   * A shared-host save (P6.7, P6.8): sign a candidate against the exact
   * parent, submit it, and commit it locally only once the host accepts it.
   * A stale parent keeps the refused candidate and throws StaleSaveError.
   */
  private async saveThroughHost(input: EditInput, signer: OriginalsSigner): Promise<OriginalView> {
    return this.answered(await this.sdk!.submit(await this.sdk!.sign(await this.sdk!.prepareEdit(this.did!, input), signer), this.sharedHost()));
  }

  /** The published Original's shared host. */
  private sharedHost(): SharedHost {
    const target = this.target ?? this.accountTarget();
    const transport = target.upload;
    if (typeof transport.submit !== "function") throw new Error("This host does not take saves for published Originals.");
    return landingSharedHost({
      sdk: this.sdk!,
      aliasDid: this.alias!.did,
      transport: { submit: (key, body) => transport.submit!(key, body) },
      read: target.read ?? publicRead,
    });
  }

  /** The view a host's answer leaves; a stale parent keeps the refused candidate and throws StaleSaveError. */
  private answered(result: SubmitResult): OriginalView {
    if (result.status === "stale-parent") {
      this.emit("asset:refused", `The host refused ${short(result.refused.versionId)}: ${short(result.hostHead)} was saved first`, { refused: result.refused.versionId, hostHead: result.hostHead });
      throw new StaleSaveError(result.refused.versionId, result.hostHead);
    }
    return result.original;
  }

  /**
   * Send again, byte for byte, a save whose answer never came back (P6.4):
   * the host recognises it if it took it. Never a new candidate for it.
   */
  private async retryPending(): Promise<void> {
    if (!this.published()) return;
    const pending = await this.sdk!.pending(this.did!);
    if (!pending || pending.parent !== this.view!.checkpoint) return;
    this.view = this.answered(await this.sdk!.submit(pending, this.sharedHost()));
    await this.refresh();
    this.emit("asset:updated", `Saved ${short(this.view.checkpoint)}, whose answer was lost`, { checkpoint: this.view.checkpoint });
  }

  /**
   * After a StaleSaveError (P6.8): fetch and verify the host's accepted log
   * and move to it when it extends local history. A host that diverges is a
   * fork, kept beside local history; nothing is merged.
   */
  async syncWithHost(): Promise<DemoAssetState> {
    if (!this.did || !this.published()) throw new Error("Publish the Original first");
    const synced = await this.sdk!.sync(this.did, this.sharedHost());
    this.view = synced.original;
    await this.refresh();
    this.emit("asset:synced", `The host's version ${short(this.view.checkpoint)} (${synced.status})`, { checkpoint: this.view.checkpoint });
    return this.snapshot();
  }

  /**
   * Reconcile a refused save (P6.8): the change the user now chooses, signed
   * against the host's new head and shown as the change from it (P5.11). The
   * refused candidate stays, labelled with what carried its change. The SDK
   * never merges: the change is exactly what is given here.
   */
  async reconcile(refused: string, title: string, style: string, source: string | AssetSource): Promise<DemoAssetState> {
    if (!this.did || !this.published()) throw new Error("Publish the Original first");
    const { ref, signer } = await this.author();
    const result = await this.sdk!.reconcile(this.did, {
      host: this.sharedHost(),
      refused,
      author: ref,
      signer,
      change: ({ head }) => {
        this.view = head;
        const input = this.changeFor(title, style, source, ref);
        if (!input) throw new Error("Nothing to reconcile: the host's version already matches.");
        return { name: input.name!, resources: input.resources! };
      },
    });
    this.view = this.answered(result);
    await this.refresh();
    this.emit("asset:updated", `Reconciled at ${short(this.view.checkpoint)}`, { checkpoint: this.view.checkpoint });
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
      onAlias: (alias) => {
        this.alias = alias;
      },
    });
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
      domain: webvhDomain(),
      slug: userWebvhSlug(subOrgId),
      aliasSigner: async () => {
        const { openSessionKey } = await import("../auth/turnkey-browser-client");
        const client = (await openSessionKey(subOrgId)).client as unknown as TurnkeyBitcoinClient;
        const address = await ensureIdentityAccount(client, subOrgId);
        return new TurnkeyWebVHSigner(client, subOrgId, address, base58AddressToEd25519Multikey(address));
      },
    };
  }

  /**
   * Anchor the Original on a sat, or publish its next entry on that sat
   * (plan 011, PR 10b; behind `bitcoinAnchoring`, off). Signed-in authors
   * only: the commit is funded from, and returns the sat to, the account's
   * bound deposit address.
   *
   * The first time, the sat is the first sat of `fundingUtxos[0]`, and the
   * author key signs the anchoring entry that names it (P9.10). After that
   * the sat's current output is input 0 (P9.12). Then the next entry Bitcoin
   * can accept is prepared, verified (P9.18), signed by the deposit key and
   * handed to the server (anchoring.ts). Each signature is checked against
   * the session first (`sessionActive`) and against `signal`; a cancel or an
   * expiry before the hand-off sends nothing. A retry never re-signs a
   * committed entry: the anchoring entry, once committed, stays, and the next
   * call goes straight to the pair.
   */
  async inscribe(opts?: {
    funding?: { fundingUtxos: Utxo[]; changeAddress: string; signingClient?: TurnkeyBitcoinClient };
    signal?: AbortSignal;
    sessionActive?: () => boolean;
  }): Promise<DemoAssetState> {
    if (!this.features.bitcoinAnchoring) {
      throw new FeatureUnavailableError("bitcoinAnchoring", "Anchoring on Bitcoin is not open yet.");
    }
    if (!this.did || !this.view || !this.sdk) throw new Error("Create an asset first");
    if (!this.authed && !this.authorOverride) throw new Error("Sign in to anchor: the sat is funded from, and returned to, your own address.");
    const network = this.anchoringNetwork();
    const transport = this.anchoringTransport();
    const outbox = this.outbox();
    // A pair whose answer was lost goes first, identical, needing no funding or signature (P9.6).
    const resent = await resendWaiting(transport, outbox, this.did);
    if (resent) return this.afterSend(transport, resent);
    const funding = opts?.funding;
    if (!funding || funding.fundingUtxos.length === 0) throw new Error("Anchoring needs funding from your deposit address.");
    const guard = signingGuard({ signal: opts?.signal, sessionActive: opts?.sessionActive });
    const { ref, signer } = await this.author();
    const script = p2wpkhScript(funding.changeAddress, network);
    let fundingUtxos = funding.fundingUtxos.map((u) => ({ ...u, scriptPubKey: u.scriptPubKey ?? script }));

    const alias = this.btcoAlias();
    if (!alias) {
      // The anchoring entry: the author key names the sat (P9.10). Once committed it is never signed again.
      const sat = await transport.provider.getFirstSatOfOutput!(fundingUtxos[0]);
      const anchored = await guardedSign(guard, () => this.sdk!.anchor(this.did!, { parent: this.view!.checkpoint, author: ref, signer, sat: btcoAlias(network, sat) }));
      this.view = anchored.original;
      await this.refresh();
      this.emit("asset:anchoring", `Anchoring ${short(this.did)} to sat ${sat}`, { sat, checkpoint: this.view.checkpoint });
    } else {
      fundingUtxos = await this.satFirst(alias, fundingUtxos, transport, script);
    }

    const satSigner: BitcoinSigner = this.anchoringOpts.satSigner ?? (() => {
      if (!funding.signingClient) throw new Error("Sign in again: the deposit key signs the commit.");
      return new TurnkeySatSigner({ client: funding.signingClient, signWith: fundingSignerAddress(funding.changeAddress) });
    })();
    const feeRate = await transport.provider.estimateFee(1);
    const result = await publishNextEntry({
      sdk: this.sdk, did: this.did, network, transport, outbox, satSigner, changeAddress: funding.changeAddress, fundingUtxos, feeRate,
      index: this.anchoringOpts.index ?? `ord@landing-${network}`, guard,
    });
    return this.afterSend(transport, result);
  }

  private async afterSend(transport: AnchoringTransport, result: PublishNextResult): Promise<DemoAssetState> {
    this.lastSubmission = { broadcast: result.sent.broadcast };
    this.anchoring = { status: await this.readStatus(transport), lastSent: result.sent, offChain: result.offChain };
    this.view = await this.sdk!.get(this.did!);
    await this.refresh();
    this.emit("asset:inscribed", `${result.resent ? "Resent" : "Sent"} ${short(result.sent.versionId)} for inscription (${result.sent.broadcast})`, {
      versionId: result.sent.versionId, commitTxId: result.sent.commitTxId, revealTxId: result.sent.revealTxId, broadcast: result.sent.broadcast,
    });
    return this.snapshot();
  }

  /** Re-read the anchoring from the server: the publication label and next step (P9.18). */
  async anchoringStatus(): Promise<DemoAssetState> {
    if (!this.did) throw new Error("Create an asset first");
    this.anchoring = { ...this.anchoring, status: await this.readStatus(this.anchoringTransport()) };
    return this.snapshot();
  }

  /** A pair handed to the server whose answer never came back: it is sent again identically on the next inscribe (P9.6). */
  async pendingHandOff(): Promise<boolean> {
    return !!this.did && !!(await this.outbox().get(this.did));
  }

  private readStatus(transport: AnchoringTransport): Promise<AnchoringStatus | null> {
    return transport.status(this.did!).catch((error) => {
      if (error instanceof AnchoringSubmitError && error.status === 404) return null;
      throw error;
    });
  }

  /** After Bitcoin's accepted head; before the anchor is accepted, from the anchoring entry on (P9.17). */
  private unpublished(status: AnchoringStatus | null): string[] {
    const ids = this.logEntries.map((e) => e.versionId);
    const accepted = status?.heads.accepted;
    if (accepted && ids.includes(accepted)) return ids.slice(ids.indexOf(accepted) + 1);
    const anchor = this.logEntries.findIndex((e) => e.state.asset.aliases?.some((a) => a.startsWith("did:btco:")));
    return anchor < 0 ? [] : ids.slice(anchor);
  }

  private btcoAlias(): string | undefined {
    return this.view?.state.aliases.find((a) => a.startsWith("did:btco:"));
  }

  /**
   * Input 0 is the output holding the sat (P9.12): the one the server reports
   * at this account's address, or, before the server has seen the anchor (a
   * retry after a cancel or an expiry), the candidate whose first sat it is.
   */
  private async satFirst(alias: string, utxos: FundingUtxo[], transport: AnchoringTransport, script: string): Promise<FundingUtxo[]> {
    const status = await this.readStatus(transport);
    if (status?.satUtxo) {
      const holder = { ...status.satUtxo, scriptPubKey: script };
      return [holder, ...utxos.filter((u) => u.txid !== holder.txid || u.vout !== holder.vout)];
    }
    if (status && status.heldByThisAccount === false) {
      throw new Error("The sat is no longer at your address. Whoever holds it now is the one who can inscribe next.");
    }
    const sat = alias.slice(alias.lastIndexOf(":") + 1);
    for (const [k, u] of utxos.slice(0, 25).entries()) {
      const first = await transport.provider.getFirstSatOfOutput!(u).catch(() => null);
      if (first === sat) return [u, ...utxos.filter((_, j) => j !== k)];
    }
    throw new Error(`None of your deposit's outputs holds sat ${sat}, the one this Original is anchored to.`);
  }

  private anchoringNetwork(): "mainnet" | "regtest" {
    const network = this.anchoringOpts.network ?? (this.networkFlag === "mainnet" || this.networkFlag === "regtest" ? this.networkFlag : undefined);
    if (!network) throw new Error("Anchoring runs on regtest and mainnet only.");
    return network;
  }

  private anchoringTransport(): AnchoringTransport {
    return (this.transport ??= this.anchoringOpts.transport ?? httpAnchoringTransport({ provider: new HttpOrdinalsProvider() }));
  }
  private transport?: AnchoringTransport;

  private outbox(): AnchoringOutbox {
    return (this.outboxStore ??= this.anchoringOpts.outbox ?? indexedDbOutbox());
  }
  private outboxStore?: AnchoringOutbox;

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
    const alias = state.aliases.find((a) => a.startsWith("did:webvh:"));
    const btco = state.aliases.find((a) => a.startsWith("did:btco:"));
    return {
      layer: btco ? "did:btco" : alias ? "did:webvh" : "did:vh",
      did: this.did,
      ...(alias ? { webvhDid: alias, webvhLogUrl: didWebvhLogUrl(alias) } : {}),
      ...(btco ? { btcoDid: btco } : {}),
      ...(this.anchoring ? { anchoring: { ...this.anchoring, unpublished: this.unpublished(this.anchoring.status) } } : {}),
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
    const stored = await this.store!.get(this.did);
    const text = stored?.log ?? "";
    this.logEntries = text.trimEnd().split("\n").filter(Boolean).map((line) => parseJson(line) as unknown as LogLine);
    for (const v of this.view?.resources ?? []) {
      const bytes = await this.store!.getResource(v.digest);
      if (bytes) this.bytes.set(v.digest, bytes);
    }
  }
}

/** A funding UTXO with its script, as the commit's witness UTXO needs. */
type FundingUtxo = Utxo & { scriptPubKey: string };

export interface AnchoringOptions {
  transport?: AnchoringTransport;
  outbox?: AnchoringOutbox;
  /** Signs the commit; defaults to the Turnkey deposit key. */
  satSigner?: BitcoinSigner;
  network?: "mainnet" | "regtest";
  /** The index named on the browser's sat reads (P9.11). */
  index?: string;
}

/** The bound deposit address's script, for the funding inputs' witness UTXOs. */
function p2wpkhScript(address: string, network: "mainnet" | "regtest"): string {
  const decoded = btc.Address(network === "regtest" ? { ...btc.TEST_NETWORK, bech32: "bcrt" } : btc.NETWORK).decode(address);
  if (!decoded || decoded.type !== "wpkh") throw new Error("The deposit address must be P2WPKH.");
  return hex.encode(btc.OutScript.encode(decoded as Parameters<typeof btc.OutScript.encode>[0]));
}

/** A public read of a hosted file, as any reader makes it. */
const publicRead: HostedFetch = async (url, options) => {
  const res = await fetch(url, { signal: options.signal, credentials: "omit", redirect: "error" });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

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
