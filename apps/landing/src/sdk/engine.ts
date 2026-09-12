import { assetDigest } from "@originals/sdk/cel";
/** Browser creator flow using the public CEL 3 SDK and explicit controller custody. */
import { recoveryStorageKey } from "./local-publication-recovery";
import {
  canPersistAnonymousAuthorshipKey,
  persistAnonymousAuthorshipKey,
  restoreAnonymousAuthorshipKey,
} from "./anonymous-authorship-backup";
import {
  encryptAuthorshipKey,
  decryptAuthorshipKey,
  type AuthorshipKeyBackup,
} from "./key-backup";
import { fundingSignerAddress } from "../auth/turnkey-session";
import {
  contentBytes,
  contentText,
  resourceView,
  type ResourceContent,
} from "./resource-view";

import "../shims/buffer-global";
import { short } from "./format";
export { short };
import {
  OriginalsSDK,
  createLocalSigner,
  type CelSigner,
  type AssetEnvelope,
  type OriginalsAsset,
  type PreparedWebPublication,
  type PreparedBitcoinPublication,
  type InscribeOnSatResult,
} from "@originals/sdk";
import { digestMultibaseSha256Hex } from "../pages/original-detail-data";
export type EntryAuthorClass = "creator" | "holder";
import { OrdMockProvider } from "@originals/sdk/testing";
import { HttpHostingStorageAdapter } from "./http-hosting-adapter";
import { DurableHostingStorageAdapter } from "./durable-hosting-adapter";
import { HttpOrdinalsProvider } from "./http-ordinals-provider";
import { TurnkeySatSigner } from "./turnkey-sat-signer";
import {
  btcNetwork,
  btcoExplorerUrl,
  demoTier,
  type BtcNetworkFlag,
  type DemoTier,
} from "./network-flag";
import type { TurnkeyBitcoinClient } from "../auth/turnkey-session";
import { ensureAuthorshipAccount } from "../auth/turnkey-session";
import {
  TurnkeyCelSigner,
  authorshipPublicKeyMultibase,
} from "./turnkey-cel-signer";
import { sha256 } from "@noble/hashes/sha2.js";

export {
  btcNetwork,
  btcRealEnabled,
  btcRealFor,
  btcoExplorerUrl,
  demoTier,
} from "./network-flag";
export type { DemoTier } from "./network-flag";

export type LayerId = "did:cel" | "did:webvh" | "did:btco";

export { ANON_IDENTITY, engineIdentity } from "./engine-identity";

export interface DemoEvent {
  type: string;

  at: string;

  summary: string;

  payload: unknown;
}

export interface CelEntry {
  type: string;
  data: Record<string, unknown>;

  previousEvent?: string;
  proof: Array<{
    type?: string;
    cryptosuite?: string;
    proofPurpose?: string;
    verificationMethod?: string;
    proofValue?: string;
  }>;

  authorClass?: EntryAuthorClass;

  authorKey?: string;
}

export interface DemoAssetState {
  layer: LayerId;
  did: string;
  webvhDid?: string;
  webvhLogUrl?: string;
  webvhResolved?: boolean;
  btcoDid?: string;
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

  celLog: CelEntry[];
  inscription?: {
    txid: string;
    inscriptionId: string;
    satoshi: string;
    commitTxId?: string;
    feeRate?: number;
    explorerUrl?: string;
  };
  provenance: unknown;
}

type Listener = (event: DemoEvent) => void;

const consoleTag =
  "color:#f7931a;font-weight:600;font-family:ui-monospace,monospace";

function log(kind: string, detail: unknown) {
  console.log(`%c[originals-sdk] ${kind}`, consoleTag, detail);
}

export class DemoEngine {
  private sdk: ReturnType<typeof OriginalsSDK.create>;
  private pendingWeb: PreparedWebPublication | null = null;
  private inscription: DemoAssetState["inscription"];
  lastSubmission: InscribeOnSatResult | null = null;
  private listeners = new Set<Listener>();
  private webvhLogUrl: string | null = null;
  private webvhResolved = false;
  private readonly authed: boolean;
  private readonly subOrgId?: string;
  private assetTitle = "";
  private assetResourceHash = "";

  private authorshipSigner: CelSigner | null = null;
  // The raw secret behind an anonymous `authorshipSigner`, kept only so a
  // durable publication can back it up (#598) — never itself persisted.
  private anonymousKeyBytes: Uint8Array | null = null;
  // True once the CALLER holds a portable backup of this session's key
  // (export, or a restore from one) — independent of which asset it later
  // signs, so it satisfies custody for every asset this key touches.
  private anonymousKeyBackedUpExplicitly = false;
  // Asset ids for which THIS browser already holds a transparent local
  // backup. One engine's cached signer can author more than one asset
  // (`resolveAuthorshipSigner` reuses it), so this is per-asset rather than
  // a single flag — otherwise backing up asset A would wrongly skip backing
  // up asset B signed by the same, already-"confirmed" key.
  private readonly anonymousBackedUpAssetIds = new Set<string>();
  asset: OriginalsAsset | null = null;

  readonly tier: DemoTier;

  readonly ordinalsProvider: OrdMockProvider | HttpOrdinalsProvider;

  constructor(opts?: {
    authed?: boolean;
    subOrgId?: string;
    networkFlag?: BtcNetworkFlag;
  }) {
    this.authed = opts?.authed ?? false;
    this.subOrgId = opts?.subOrgId;
    (globalThis as Record<string, unknown>).__originalsDemo = this;
    const tier = demoTier(opts?.networkFlag ?? btcNetwork(), this.authed);
    this.tier = tier;
    this.ordinalsProvider = tier.real
      ? new HttpOrdinalsProvider()
      : new OrdMockProvider();
    this.sdk = OriginalsSDK.create({
      network: tier.network,
      webvhNetwork: tier.webvhNetwork,
      defaultKeyType: "Ed25519",
      ordinalsProvider: this.ordinalsProvider,
      storageAdapter: this.authed
        ? new DurableHostingStorageAdapter()
        : new HttpHostingStorageAdapter(),
      enableLogging: false,
    });
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(type: string, summary: string, payload: unknown) {
    log(type, payload);
    const event: DemoEvent = {
      type,
      at: new Date().toISOString(),
      summary,
      payload,
    };
    for (const l of this.listeners) l(event);
  }

  private async resolveAuthorshipSigner(): Promise<CelSigner> {
    if (this.authorshipSigner) return this.authorshipSigner;
    if (!this.authed) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      this.anonymousKeyBytes = bytes;
      this.authorshipSigner = createLocalSigner("Ed25519", bytes);
      return this.authorshipSigner;
    }
    if (!this.subOrgId)
      throw new Error("Sign in again to restore your authorship key.");
    try {
      const { openSessionKey } = await import("../auth/turnkey-browser-client");
      const handle = await openSessionKey(this.subOrgId);
      const client = handle.client as unknown as TurnkeyBitcoinClient;
      const address = await ensureAuthorshipAccount(client, this.subOrgId);
      const publicKeyMultibase = authorshipPublicKeyMultibase(address);
      if (!publicKeyMultibase) {
        log(
          "authorship:unavailable",
          `authorship account ${address} is not an Ed25519 key`,
        );
        throw new Error(
          "Your authorship account does not provide an Ed25519 key.",
        );
      }
      const external = new TurnkeyCelSigner({
        client,
        subOrgId: this.subOrgId,
        signWith: address,
        publicKeyMultibase,
      });
      this.authorshipSigner = {
        controller: `did:key:${publicKeyMultibase}`,
        algorithm: "Ed25519",
        sign: async (bytes) => (await external.signBytes(bytes)).signature,
      };
      this.emit(
        "authorship:key",
        `Authoring as ${short(this.authorshipSigner.controller)} — a Turnkey-held key, not this browser's`,
        { verificationMethodId: this.authorshipSigner.controller },
      );
      return this.authorshipSigner;
    } catch (err) {
      log("authorship:unavailable", err);
      throw new Error(
        "Your authorship key could not be restored. Reconnect your account before creating or changing this Original.",
      );
    }
  }

  /**
   * Encrypt this session's anonymous authoring key under a passphrase the
   * caller supplies and keeps — a portable backup independent of this
   * browser's own storage. Signed-in sessions have nothing local to back up:
   * their controller is already held durably by the account (#598).
   */
  async exportAuthorshipKeyBackup(
    passphrase: string,
  ): Promise<AuthorshipKeyBackup> {
    if (this.authed)
      throw new Error(
        "Signed-in authorship is already held by your account; there is no local key to back up.",
      );
    const signer = await this.resolveAuthorshipSigner();
    if (!this.anonymousKeyBytes)
      throw new Error("No local authoring key to back up yet.");
    const backup = await encryptAuthorshipKey(
      this.anonymousKeyBytes,
      signer.controller,
      passphrase,
    );
    this.anonymousKeyBackedUpExplicitly = true;
    this.emit(
      "authorship:backup-exported",
      `Encrypted a recoverable backup for ${short(signer.controller)}`,
      { controller: signer.controller },
    );
    return backup;
  }

  /** Restore an anonymous authoring key from a backup made with `exportAuthorshipKeyBackup`. */
  async restoreAuthorshipFromBackup(
    backup: AuthorshipKeyBackup,
    passphrase: string,
  ): Promise<CelSigner> {
    if (this.authed)
      throw new Error(
        "Signed-in sessions restore authorship by signing in again, not from a key backup.",
      );
    const secretKey = await decryptAuthorshipKey(backup, passphrase);
    const signer = createLocalSigner("Ed25519", secretKey);
    if (signer.controller !== backup.controller)
      throw new Error(
        "This backup does not match the expected authoring key.",
      );
    this.anonymousKeyBytes = secretKey;
    this.authorshipSigner = signer;
    this.anonymousKeyBackedUpExplicitly = true;
    this.emit(
      "authorship:restored",
      `Restored ${short(signer.controller)} from an encrypted backup`,
      { controller: signer.controller },
    );
    return signer;
  }

  /**
   * Fail-closed gate for durable publication (#598): an anonymous control key
   * that cannot be restored after a reload must not be allowed to publish. On
   * first call for a given asset this transparently backs the key up to this
   * browser's storage (wrapped under a non-extractable local key — see
   * `keystore.ts`) so an ordinary reload keeps editing working; a visitor
   * who wants a copy independent of this browser should call
   * `exportAuthorshipKeyBackup` themselves first. One engine's signer can go
   * on to author more than one asset (`resolveAuthorshipSigner` caches it),
   * so this tracks which asset ids are already backed up rather than a
   * single flag for the whole session.
   */
  private async ensureAnonymousCustodyRecoverable(
    signer: CelSigner,
  ): Promise<void> {
    if (this.authed || this.anonymousKeyBackedUpExplicitly) return;
    if (!this.anonymousKeyBytes) {
      // Not a key this engine generated (e.g. an externally-held signer
      // supplied by a caller) — the caller already holds it, nothing local
      // to back up.
      return;
    }
    if (!this.asset)
      throw new Error(
        "No local authoring key to make recoverable before publishing.",
      );
    if (this.anonymousBackedUpAssetIds.has(this.asset.id)) return;
    if (!canPersistAnonymousAuthorshipKey())
      throw new Error(
        "This browser has no local storage or durable key store, so an anonymous authoring key here could not survive a reload. Sign in for durable, recoverable publication, or back it up yourself with exportAuthorshipKeyBackup() first.",
      );
    await persistAnonymousAuthorshipKey(
      this.asset.id,
      this.anonymousKeyBytes,
      signer.controller,
    );
    this.anonymousBackedUpAssetIds.add(this.asset.id);
  }

  /** Restore a previously backed-up anonymous authoring key for this asset, if this browser holds one. */
  private async restoreAnonymousCustody(assetId: string): Promise<void> {
    if (this.authed || this.authorshipSigner) return;
    if (!canPersistAnonymousAuthorshipKey()) return;
    const restored = await restoreAnonymousAuthorshipKey(assetId);
    if (!restored) return;
    const signer = createLocalSigner("Ed25519", restored.secretKey);
    const liveController = this.asset?.state.controller;
    if (
      signer.controller !== restored.controller ||
      (liveController && signer.controller !== liveController)
    ) {
      // Either the decrypted key doesn't match the controller recorded
      // alongside it, or it does but that recorded controller isn't the
      // asset's actual current controller (e.g. a stale/foreign record) —
      // either way, treat the backup as unusable rather than sign with it.
      // The next resolveAuthorshipSigner() falls back to a fresh key, which
      // the SDK's own controller check then safely refuses to use for
      // edits, but checking here surfaces the mismatch immediately instead
      // of only on the next failed update.
      log("authorship:restore-mismatch", {
        assetId,
        expected: restored.controller,
        liveController,
        got: signer.controller,
      });
      return;
    }
    this.anonymousKeyBytes = restored.secretKey;
    this.authorshipSigner = signer;
    this.anonymousBackedUpAssetIds.add(assetId);
    this.emit(
      "authorship:restored",
      `Restored ${short(signer.controller)} from this browser's storage`,
      { controller: signer.controller },
    );
  }

  async hydrate(envelope: AssetEnvelope): Promise<DemoAssetState> {
    const { asset } = await this.sdk.lifecycle.loadAsset(envelope);
    this.asset = asset;
    await this.restoreAnonymousCustody(asset.id);
    const primary = asset.resources[0];
    this.assetResourceHash = primary
      ? (digestMultibaseSha256Hex(primary.digestMultibase) ?? "")
      : "";
    this.assetTitle = this.assetTitle || (primary?.id ?? "");
    this.emit(
      "asset:hydrated",
      `Rebuilt ${short(asset.id)} from its hosted event log`,
      {
        assetId: asset.id,
        layer: `did:${asset.state.layer}`,
        events: asset.celLog.log.length ?? 0,
      },
    );
    return this.snapshot();
  }

  /** Authenticate both hosted histories and all resource bytes before resuming. */
  async hydrateFromWeb(did: string): Promise<DemoAssetState> {
    const loaded = await this.sdk.lifecycle.resolveAssetFromWeb(did);
    this.asset = loaded.asset;
    await this.restoreAnonymousCustody(this.asset.id);
    this.webvhLogUrl = webvhLogUrl(did);
    this.webvhResolved = loaded.verification.verified;
    this.assetTitle =
      this.asset.state.name ?? this.asset.resources[0]?.id ?? "";
    this.assetResourceHash = this.snapshot().resource.hash;
    return this.snapshot();
  }

  async create(
    title: string,
    style: string,
    source: string | AssetSource,
  ): Promise<DemoAssetState> {
    const src = asSource(source);
    const svgBytes = contentBytes(src.content);
    const svgHash = toHex(sha256(svgBytes));

    const metadata = buildMetadata({
      title,
      style,
      created: new Date().toISOString(),
      artworkHash: svgHash,
      artworkFile: src.filename,
    });
    const metaBytes = new TextEncoder().encode(metadata);
    const authorship = await this.resolveAuthorshipSigner();
    const asset = await this.sdk.lifecycle.createAsset(
      [
        { id: src.filename, content: svgBytes, mediaType: src.contentType },
        {
          id: "metadata.json",
          content: metaBytes,
          mediaType: "application/json",
        },
      ],
      { signer: authorship, name: title },
    );
    this.asset = asset;
    this.pendingWeb = null;
    this.inscription = undefined;
    this.assetTitle = title;
    this.assetResourceHash = svgHash;
    this.emit(
      "asset:created",
      `Created ${short(asset.id)} from a signed CEL 3 genesis`,
      { asset: { id: asset.id }, event: asset.celLog.log[0] },
    );

    return this.snapshot();
  }

  async update(
    title: string,
    style: string,
    source: string | AssetSource,
  ): Promise<DemoAssetState> {
    const asset = this.asset;
    if (!asset) throw new Error("Create an asset first");
    if (this.pendingWeb)
      throw new Error(
        "Finish the pending publication before editing this Original.",
      );
    if (`did:${asset.state.layer}` === "did:btco") {
      throw new Error(
        "Revising an inscribed asset writes a new inscription on its satoshi — a paid on-chain append, not a demo click.",
      );
    }

    const current = this.snapshot();
    const src = asSource(source);
    const svgHash = toHex(sha256(contentBytes(src.content)));
    const authorship = await this.resolveAuthorshipSigner();
    const signed = authorship ? { signer: authorship } : undefined;
    if (
      svgHash !== current.resource.hash ||
      src.contentType !== current.resource.contentType
    ) {
      await asset.addResourceVersion(
        current.resource.id,
        src.content,
        src.contentType,
        signed,
      );
      this.assetResourceHash = svgHash; // the /me summary posts this on publish
    }
    if (current.metadata) {
      const next = buildMetadata({
        title,
        style,
        created: createdAtOf(current.metadata.content),
        artworkHash: svgHash,
        artworkFile: current.resource.id,
      });
      if (next !== current.metadata.content) {
        await asset.addResourceVersion(
          current.metadata.id,
          next,
          "application/json",
          signed,
        );
      }
    }

    if (asset.state.name !== title) await asset.update({ name: title }, signed);
    this.assetTitle = title;
    if (asset.state.layer === "webvh") await this.publish();
    return this.snapshot();
  }

  async publish(): Promise<DemoAssetState> {
    if (!this.asset) throw new Error("Create an asset first");

    const publishSigner = await this.resolveAuthorshipSigner();
    await this.ensureAnonymousCustodyRecoverable(publishSigner);
    this.pendingWeb ??= await this.sdk.lifecycle.prepareWebPublication(
      this.asset,
      {
        domain: demoHost(),
        signer: publishSigner,
        ...(this.asset.state.layer === "cel"
          ? {
              paths:
                this.authed && this.subOrgId
                  ? [
                      "published",
                      "accounts",
                      this.subOrgId,
                      assetDigest(this.asset.id),
                    ]
                  : ["published", "anonymous", assetDigest(this.asset.id)],
            }
          : {}),
      },
    );
    const webRecoveryKey = this.subOrgId
      ? recoveryStorageKey("web", this.subOrgId, this.asset.id)
      : null;
    if (webRecoveryKey) {
      if (typeof localStorage === "undefined")
        throw new Error("Durable browser recovery storage is unavailable.");
      localStorage.setItem(webRecoveryKey, JSON.stringify(this.pendingWeb));
    }
    const published = await this.sdk.lifecycle.publishPreparedToWeb(
      this.pendingWeb,
    );
    this.asset = published.asset;
    this.pendingWeb = null;
    const assetWebvhDid = published.did;
    const logUrl = webvhLogUrl(assetWebvhDid);
    const loaded = await this.sdk.lifecycle.resolveAssetFromWeb(assetWebvhDid);
    this.webvhLogUrl = logUrl;
    this.webvhResolved = loaded.verification.verified;
    this.emit(
      "did:webvh:resolved",
      `Hosted CEL, method history and resource bytes verified at ${logUrl}`,
      {
        logUrl,
        resolved: this.webvhResolved,
      },
    );
    if (this.authed && assetWebvhDid) {
      try {
        const res = await fetch("/api/originals", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            did: assetWebvhDid,
            title: this.assetTitle,
            resourceHash: this.assetResourceHash,
          }),
        });
        if (!res.ok) log("originals:record-failed", res.status);
        else if (webRecoveryKey) localStorage.removeItem(webRecoveryKey);
      } catch (err) {
        log("originals:record-failed", err);
      }
    }

    return this.snapshot();
  }

  async inscribe(opts?: {
    feeRate?: number;
    funding?: {
      fundingUtxos?: Array<{
        txid: string;
        vout: number;
        value: number;
        scriptPubKey?: string;
        address?: string;
      }>;

      fundingUtxo?: {
        txid: string;
        vout: number;
        value: number;
        scriptPubKey?: string;
        address?: string;
      };
      changeAddress: string;
      signingClient: TurnkeyBitcoinClient;

      signWith?: string;
    };
  }): Promise<DemoAssetState> {
    if (!this.asset) throw new Error("Create an asset first");
    if (!opts?.funding)
      throw new Error(
        "Bitcoin publication requires a funded, signed-in account.",
      );
    const inscribeSigner = await this.resolveAuthorshipSigner();
    await this.ensureAnonymousCustodyRecoverable(inscribeSigner);
    const satSigner = new TurnkeySatSigner({
      client: opts.funding.signingClient,
      signWith:
        opts.funding.signWith ??
        fundingSignerAddress(opts.funding.changeAddress),
    });
    const fundingUtxos =
      opts.funding.fundingUtxos ??
      (opts.funding.fundingUtxo ? [opts.funding.fundingUtxo] : []);
    if (!fundingUtxos.length)
      throw new Error("inscribe: funding needs at least one UTXO");
    const feeRate =
      opts.feeRate ?? (await this.ordinalsProvider.estimateFee(1));
    const recoveryKey = recoveryStorageKey(
      "bitcoin",
      this.subOrgId ?? "",
      this.asset.id,
    );
    if (typeof localStorage === "undefined")
      throw new Error("Durable browser recovery storage is unavailable.");
    // Reuse the existing signed pair across retries, including an uncertain response.
    const retained = localStorage.getItem(recoveryKey);
    const prepared: PreparedBitcoinPublication = retained
      ? JSON.parse(retained)
      : await this.sdk.lifecycle.prepareBitcoinPublication(this.asset, {
          fundingUtxos,
          satSigner,
          signer: inscribeSigner,
          changeAddress: opts.funding.changeAddress,
          feeRate,
        });
    localStorage.setItem(recoveryKey, JSON.stringify(prepared));
    const result = await this.sdk.lifecycle.publishPreparedToBitcoin(prepared);
    this.asset = result.asset;
    const submission = result.submission;
    this.lastSubmission = submission;
    this.inscription = {
      txid: submission.revealTxId,
      inscriptionId: submission.inscriptionId,
      satoshi: submission.satoshi,
      commitTxId: submission.commitTxId,
      feeRate,
      explorerUrl: this.tier.real
        ? btcoExplorerUrl(submission.revealTxId)
        : undefined,
    };
    const state = this.snapshot();
    if (state.inscription) {
      this.emit(
        "asset:inscribed",
        `Signed publication submitted for satoshi ${state.inscription.satoshi}; current outcome: ${this.lastSubmission?.broadcast}`,
        state.inscription,
      );
    }
    if (this.authed && opts?.funding && state.inscription && state.webvhDid) {
      try {
        const res = await fetch("/api/originals", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            did: state.webvhDid,
            title: this.assetTitle,
            resourceHash: this.assetResourceHash,
            btcoDid: state.btcoDid,
            inscriptionId: state.inscription.inscriptionId,
            commitTxId: state.inscription.commitTxId,
            revealTxId: state.inscription.txid,
            satoshi: state.inscription.satoshi,
            status: "pending",
          }),
        });
        if (!res.ok) log("originals:record-failed", res.status);
      } catch (err) {
        log("originals:record-failed", err);
      }
    }
    return state;
  }

  snapshot(): DemoAssetState {
    const asset = this.asset;
    if (!asset) throw new Error("No asset yet");
    const provenance = asset.state;
    const bindings = Object.fromEntries(
      asset.state.aliases
        .filter((alias) => alias.startsWith("did:webvh:") || alias.startsWith("did:btco:"))
        .map((alias) => [
          alias.startsWith("did:webvh:") ? "did:webvh" : "did:btco",
          alias,
        ]),
    );
    const primaryId = asset.resources[0]?.id ?? "";
    const res = latestVersion(asset.resources, primaryId) ?? {
      id: "",
      mediaType: "application/octet-stream",
      digestMultibase: "",
      content: new Uint8Array(),
      version: 0,
    };
    const metaId = asset.resources.find((r) => r.id !== primaryId)?.id;
    const meta = metaId ? latestVersion(asset.resources, metaId) : undefined;
    return {
      layer: `did:${asset.state.layer}` as LayerId,
      did: asset.id,
      webvhDid: bindings["did:webvh"],
      webvhLogUrl: this.webvhLogUrl ?? undefined,
      webvhResolved: this.webvhResolved,
      btcoDid: bindings["did:btco"],
      resource: {
        id: res.id,
        hash: digestMultibaseSha256Hex(res.digestMultibase) ?? "",
        contentType: res.mediaType,
        content: resourceView(res.content, res.mediaType),
        version: res.version ?? 1,
      },
      metadata: meta
        ? {
            id: meta.id,
            hash: digestMultibaseSha256Hex(meta.digestMultibase) ?? "",
            content: contentText(meta.content ?? new Uint8Array()),
          }
        : undefined,
      credentials: 0,
      celLog: celEntries(asset),
      inscription: this.inscription,
      provenance,
    };
  }
}

export interface AssetSource {
  content: ResourceContent;
  contentType: string;

  filename: string;
}

function asSource(source: string | AssetSource): AssetSource {
  return typeof source === "string"
    ? { content: source, contentType: "image/svg+xml", filename: "artwork.svg" }
    : source;
}

function buildMetadata(input: {
  title: string;
  style: string;
  created: string;
  artworkHash: string;
  artworkFile: string;
}): string {
  return JSON.stringify(
    {
      title: input.title,
      style: input.style,
      creator: "you",
      created: input.created,
      artwork: { file: input.artworkFile, sha256: input.artworkHash },
    },
    null,
    2,
  );
}

function createdAtOf(metadataJson: string): string {
  try {
    const created = (JSON.parse(metadataJson) as { created?: unknown }).created;
    if (typeof created === "string" && created) return created;
  } catch {}
  return new Date().toISOString();
}

interface VersionedResource {
  id: string;
  digestMultibase: string;
  mediaType: string;
  content?: Uint8Array;
  version?: number;
}

function latestVersion(
  resources: readonly VersionedResource[],
  id: string,
): VersionedResource | undefined {
  return resources
    .filter((r) => r.id === id)
    .reduce<VersionedResource | undefined>(
      (best, r) => (!best || (r.version ?? 1) > (best.version ?? 1) ? r : best),
      undefined,
    );
}

function celEntries(asset: OriginalsAsset): CelEntry[] {
  return asset.celLog.log.map(({ event, proof }) => ({
    type: event.operation.type,
    data: { ...event.operation.data },
    previousEvent: event.previousEvent,
    proof: Array.isArray(proof) ? proof : [proof],
    authorClass: "creator",
    authorKey: (Array.isArray(proof)
      ? proof[0]
      : proof
    ).verificationMethod.split("#")[0],
  }));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function demoHost(): string {
  const envHost = (import.meta as unknown as { env?: Record<string, string> })
    .env?.VITE_WEBVH_HOST;
  if (envHost) return envHost;
  if (typeof window !== "undefined" && window.location?.host)
    return window.location.host;
  return "localhost";
}
function webvhLogUrl(did: string): string {
  const parts = did.split(":"); // did:webvh:<SCID>:<domain>[:<seg>…]
  const domain = decodeURIComponent(parts[3] ?? "");
  const segs = parts.slice(4).map((s) => decodeURIComponent(s));
  const base = `https://${domain}`;
  return segs.length
    ? `${base}/${segs.join("/")}/did.jsonl`
    : `${base}/.well-known/did.jsonl`;
}
