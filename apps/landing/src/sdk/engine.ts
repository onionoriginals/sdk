/**
 * The live engine behind the landing-page demo.
 *
 * Everything here calls the real @originals/sdk — the same package a
 * developer gets from `npm install @originals/sdk`. Nothing is canned:
 * DIDs, hashes, credentials, events and provenance all come back from
 * actual SDK calls. Publishing hosts the signed did:webvh log at this origin
 * over real HTTP(S) and the SDK's real resolver fetches it back. Bitcoin
 * operations still run against OrdMockProvider (no wallet or node needed).
 *
 * Every SDK event is mirrored to the browser console (prefixed
 * "[originals-sdk]") so anyone can open devtools and watch the protocol
 * work while they click through the demo.
 */
import '../shims/buffer-global';
import { short } from './format';
export { short };
import {
  OriginalsSDK,
  type OriginalsAsset
} from '@originals/sdk';
// Test doubles moved out of the root entry in plan 043 so they are not shipped
// to production consumers.
import { OrdMockProvider } from '@originals/sdk/testing';
import { HttpHostingStorageAdapter } from './http-hosting-adapter';
import { DurableHostingStorageAdapter } from './durable-hosting-adapter';
import { HttpOrdinalsProvider } from './http-ordinals-provider';
import { TurnkeySatSigner } from './turnkey-sat-signer';
import { userWebvhSlug } from '../auth/webvh';
import { btcNetwork, btcoExplorerUrl } from './network-flag';
import type { TurnkeyBitcoinClient } from '../auth/turnkey-session';
import { sha256 } from '@noble/hashes/sha2.js';

export { btcNetwork, btcRealEnabled, btcoExplorerUrl } from './network-flag';

export type LayerId = 'did:cel' | 'did:webvh' | 'did:btco';

/**
 * Identity of the engine a given auth state must use: the durable adapter +
 * per-user host path depend on (authed, subOrgId). When this string changes
 * (sign in/out, or a different account), the cached engine MUST be discarded —
 * otherwise a user who signs in after an anonymous engine was preloaded would
 * keep publishing through the ephemeral (TTL) adapter instead of their account.
 */
/** The identity an anonymous visitor's engine is keyed by. */
export const ANON_IDENTITY = 'anon';

export function engineIdentity(authed: boolean, subOrgId?: string): string {
  return authed ? `authed:${subOrgId ?? ''}` : ANON_IDENTITY;
}

export interface DemoEvent {
  /** SDK event type, e.g. 'asset:created', 'asset:migrated' */
  type: string;
  /** Wall-clock time the event was received */
  at: string;
  /** Human summary rendered in the event log */
  summary: string;
  /** Raw event payload from the SDK, for the inspector */
  payload: unknown;
}

/** One entry of the asset's CEL, narrowed to what the demo renders. */
export interface CelEntry {
  type: string;
  data: Record<string, unknown>;
  /** Multibase digest of the preceding entry; absent on the genesis event. */
  previousEvent?: string;
  proof: Array<{
    type?: string;
    cryptosuite?: string;
    proofPurpose?: string;
    verificationMethod?: string;
    proofValue?: string;
  }>;
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
    content: string;
    /** 1 at genesis; bumped by each signed `update` event. */
    version: number;
  };
  metadata?: {
    id: string;
    hash: string;
    content: string;
  };
  credentials: number;
  /**
   * The asset's Cryptographic Event Log — the signed, hash-chained record the
   * provenance above is folded from. Surfaced so the demo can show the actual
   * chain instead of the SDK's app-level emitter events.
   */
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
  'color:#f7931a;font-weight:600;font-family:ui-monospace,monospace';

function log(kind: string, detail: unknown) {
  // Deliberately console.log, not console.debug: this is the proof that the
  // demo runs the real SDK. Keep it visible at default devtools levels.
  console.log(`%c[originals-sdk] ${kind}`, consoleTag, detail);
}

export class DemoEngine {
  private sdk: ReturnType<typeof OriginalsSDK.create>;
  private keys = new Map<string, string>();
  private listeners = new Set<Listener>();
  private publisherDid: string | null = null;
  private webvhLogUrl: string | null = null;
  private webvhResolved = false;
  private readonly authed: boolean;
  private readonly subOrgId?: string;
  private assetTitle = '';
  private assetResourceHash = '';
  asset: OriginalsAsset | null = null;

  constructor(opts?: { authed?: boolean; subOrgId?: string }) {
    this.authed = opts?.authed ?? false;
    this.subOrgId = opts?.subOrgId;
    // Deliberately public and permanent: lets anyone (including skeptics)
    // inspect the live engine from the devtools console. Reassigned on every
    // construction so it always points at the engine currently driving the UI.
    (globalThis as Record<string, unknown>).__originalsDemo = this;
    const keys = this.keys;
    // Track B: when the deploy enables real signing (VITE_BTC_NETWORK=testnet4
    // or mainnet), inscribe for real over the /api/btc/* QuickNode proxies;
    // otherwise keep the self-contained OrdMockProvider mock (regtest).
    const netFlag = btcNetwork();
    const real = netFlag !== 'off';
    this.sdk = OriginalsSDK.create({
      network: netFlag === 'mainnet' ? 'mainnet' : netFlag === 'testnet4' ? 'testnet' : 'regtest',
      webvhNetwork: 'magby',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: real ? new HttpOrdinalsProvider() : new OrdMockProvider(),
      // Signed-in users host DURABLY (persisted under their account, PUT
      // /api/originals/host/*); anonymous users keep the ephemeral TTL host
      // (PUT /api/host/*). Both make the did:webvh log resolvable over HTTP(S).
      storageAdapter: this.authed
        ? new DurableHostingStorageAdapter()
        : new HttpHostingStorageAdapter(),
      enableLogging: false,
      keyStore: {
        async getPrivateKey(id: string) {
          return keys.get(id) ?? null;
        },
        async setPrivateKey(id: string, key: string) {
          keys.set(id, key);
        },
        getAllVerificationMethodIds() {
          return [...keys.keys()];
        }
      }
      // Cast: the SDK config's storageAdapter type refers to a second,
      // same-named StorageAdapter interface; MemoryStorageAdapter is what the
      // lifecycle actually consumes (see WebVhPublish tests).
    } as unknown as Parameters<typeof OriginalsSDK.create>[0]);

    const forward = (type: string, summarize: (e: never) => string) => {
      this.sdk.lifecycle.on(type as never, (e: never) => {
        this.emit(type, summarize(e), e);
      });
    };

    forward('asset:created', (e: { asset: { id: string } }) =>
      `Asset created as ${short(e.asset.id)} — a did:cel genesis (a signed event log), generated entirely offline in this tab`
    );
    forward(
      'resource:published',
      (e: { resource: { id: string } }) =>
        `Resource "${e.resource.id}" hosted over HTTP at this origin — its did:webvh log is now resolvable`
    );
    forward(
      'credential:issued',
      (e: { credential: { type: string[] } }) =>
        `Verifiable credential signed: ${e.credential.type.join(', ')}`
    );
    forward(
      'credential:skipped',
      (e: { reason: string }) => `Credential skipped (${e.reason})`
    );
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
      payload
    };
    for (const l of this.listeners) l(event);
  }

  /**
   * Step 1 — create a did:cel asset. The primary resource is the artwork
   * itself: a real SVG file whose exact bytes are hashed and carried through
   * the whole lifecycle. A small JSON metadata resource rides along.
   */
  async create(title: string, medium: string, artworkSvg: string): Promise<DemoAssetState> {
    const svgBytes = new TextEncoder().encode(artworkSvg);
    const svgHash = toHex(sha256(svgBytes));

    const metadata = buildMetadata({
      title,
      medium,
      created: new Date().toISOString(),
      artworkHash: svgHash
    });
    const metaBytes = new TextEncoder().encode(metadata);

    const asset = await this.sdk.lifecycle.createAsset([
      {
        id: 'artwork.svg',
        type: 'image',
        content: artworkSvg,
        contentType: 'image/svg+xml',
        hash: svgHash,
        size: svgBytes.length
      },
      {
        id: 'metadata.json',
        type: 'data',
        content: metadata,
        contentType: 'application/json',
        hash: toHex(sha256(metaBytes)),
        size: metaBytes.length
      }
    ]);
    this.asset = asset;
    this.assetTitle = title;
    this.assetResourceHash = svgHash;

    asset.on('asset:migrated', (e: { asset: { fromLayer: string; toLayer: string } }) => {
      this.emit(
        'asset:migrated',
        `Migrated ${e.asset.fromLayer} → ${e.asset.toLayer}`,
        e
      );
    });

    asset.on(
      'resource:version:created',
      (e: { resource: { id: string; fromVersion: number; toVersion: number } }) => {
        this.emit(
          'resource:version:created',
          `"${e.resource.id}" revised to v${e.resource.toVersion} — a signed update event chains the new bytes to v${e.resource.fromVersion}`,
          e
        );
      }
    );

    return this.snapshot();
  }

  /**
   * Revise the artwork — a signed `update` event appended to the asset's own
   * event log, chaining the new bytes to the version before them.
   *
   * Works at did:cel (free, offline, nothing hosted yet) AND at did:webvh: the
   * SDK hosts the new version's bytes before appending, so the published log
   * never names a resource URL that 404s. did:btco is refused here because an
   * update there is a PAID on-chain append — real sats, not a demo click.
   */
  async update(title: string, medium: string, artworkSvg: string): Promise<DemoAssetState> {
    const asset = this.asset;
    if (!asset) throw new Error('Create an asset first');
    if (asset.currentLayer === 'did:btco') {
      throw new Error(
        'Revising an inscribed asset writes a new inscription on its satoshi — a paid on-chain append, not a demo click.'
      );
    }

    const current = this.snapshot();
    const svgHash = toHex(sha256(new TextEncoder().encode(artworkSvg)));

    // The artwork is generated FROM the title, so a text edit changes these
    // bytes — that is the edit. Skip when identical: addResourceVersion refuses
    // a no-op version rather than logging one.
    if (artworkSvg !== current.resource.content) {
      await asset.addResourceVersion(
        current.resource.id,
        artworkSvg,
        'image/svg+xml',
        `Artwork regenerated for "${title}"`
      );
      this.assetResourceHash = svgHash; // the /me summary posts this on publish
    }

    // metadata.json embeds the title, the medium AND the artwork's sha-256, so
    // leaving it at v1 would have the asset's own metadata describe bytes it no
    // longer carries. Genesis `created` is preserved — it is when the asset was
    // made, not when it was last edited.
    if (current.metadata) {
      const next = buildMetadata({
        title,
        medium,
        created: createdAtOf(current.metadata.content),
        artworkHash: svgHash
      });
      if (next !== current.metadata.content) {
        await asset.addResourceVersion(
          current.metadata.id,
          next,
          'application/json',
          `Metadata follows the artwork to "${title}"`
        );
      }
    }

    this.assetTitle = title;
    return this.snapshot();
  }

  /**
   * Step 2 — publish to the web layer. Creates a real did:webvh publisher
   * identity locally (no server round-trip: the DID log is generated and
   * signed in-memory, then cached so credential signing resolves it offline).
   */
  async publish(): Promise<DemoAssetState> {
    if (!this.asset) throw new Error('Create an asset first');

    if (!this.publisherDid) {
      // Signed-in users host under their own per-user slug so no two users
      // collide on disk (and the server rejects writes outside this namespace).
      // Anonymous demo stays on the shared ephemeral (TTL) path.
      const paths =
        this.authed && this.subOrgId ? [userWebvhSlug(this.subOrgId)] : ['studio', 'you'];
      const webvh = await this.sdk.did.createDIDWebVH({
        domain: demoHost(),
        paths
      });
      const result = webvh as unknown as {
        did: string;
        didDocument: {
          id: string;
          verificationMethod?: Array<{ id: string }>;
        };
        keyPair?: { privateKey: string };
      };
      const vm = result.didDocument.verificationMethod?.[0];
      if (vm && result.keyPair) {
        const vmId = vm.id.startsWith('#') ? `${result.did}${vm.id}` : vm.id;
        await this.sdk.lifecycle.registerKey(vmId, result.keyPair.privateKey);
      }
      await this.sdk.did.cache.set(
        result.did,
        result.didDocument as never
      );
      this.publisherDid = result.did;
      this.emit(
        'did:webvh:created',
        `Publisher identity created: ${short(result.did)}`,
        result.didDocument
      );
    }

    await this.sdk.lifecycle.publishToWeb(this.asset, this.publisherDid);

    // Prove REAL resolution: publishToWeb hosts the ASSET's did:webvh log (+ cel
    // + resources) at this origin. Fetch that log back over the network via the
    // SDK's real resolver. skipCache forces a network read (not the in-memory
    // cache). Best-effort in dev (http origin can't satisfy the resolver's
    // hard-coded https), authoritative in prod. resolved=false still shows the
    // link, just no "resolved ✓" tick.
    const assetWebvhDid = ((this.asset.bindings ?? {}) as Record<string, string>)['did:webvh'];
    const logUrl = assetWebvhDid ? webvhLogUrl(assetWebvhDid) : '';
    let resolvedDoc: unknown = null;
    let resolved = false;
    if (assetWebvhDid) {
      try {
        resolvedDoc = await this.sdk.did.resolveDID(assetWebvhDid, { skipCache: true });
        resolved = !!resolvedDoc;
      } catch (err) {
        log('did:webvh:resolve-failed', err);
      }
    }
    this.webvhLogUrl = logUrl;
    this.webvhResolved = resolved;
    this.emit(
      'did:webvh:resolved',
      resolved
        ? `did:webvh log resolved over HTTPS — ${logUrl}`
        : `did:webvh log hosted at ${logUrl} (resolves over HTTPS in production)`,
      { logUrl, resolved, doc: resolvedDoc }
    );

    // Signed-in: record a durable summary under the user's account so it shows
    // up on /me. Best-effort — a failure must not break the publish UX.
    if (this.authed && assetWebvhDid) {
      try {
        const res = await fetch('/api/originals', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            did: assetWebvhDid,
            title: this.assetTitle,
            resourceHash: this.assetResourceHash,
          }),
        });
        if (!res.ok) log('originals:record-failed', res.status);
      } catch (err) {
        log('originals:record-failed', err);
      }
    }

    return this.snapshot();
  }

  /**
   * Step 3 — inscribe on Bitcoin.
   *
   * With `funding` (Track B, login-gated): a REAL testnet4 inscription. The
   * server-funded UTXO's first sat becomes the did:btco identity, the user's
   * Turnkey session key signs the commit, the reveal is self-signed by the SDK,
   * and both broadcast via the /api/btc/* QuickNode proxies. Without `funding`:
   * the self-contained OrdMockProvider mock (regtest).
   */
  async inscribe(opts?: {
    feeRate?: number;
    funding?: {
      fundingUtxo: { txid: string; vout: number; value: number; scriptPubKey?: string; address?: string };
      changeAddress: string;
      signingClient: TurnkeyBitcoinClient;
    };
  }): Promise<DemoAssetState> {
    if (!this.asset) throw new Error('Create an asset first');
    if (opts?.funding) {
      // Real sat-selected path: the user's Turnkey key signs the commit.
      const satSigner = new TurnkeySatSigner({
        client: opts.funding.signingClient,
        signWith: opts.funding.changeAddress, // the user's funding address IS signWith
      });
      await this.sdk.lifecycle.inscribeOnBitcoin(this.asset, {
        fundingUtxo: opts.funding.fundingUtxo,
        satSigner,
        changeAddress: opts.funding.changeAddress,
        // No default here: real BTC must be built at the LIVE rate. Left
        // undefined, the SDK resolves it from the provider's estimateFee
        // (the same /api/btc/fee estimate the deposit target was sized from)
        // and fails closed rather than guessing (FEE_RATE_REQUIRED).
        feeRate: opts.feeRate,
      });
    } else {
      // Mock path (unchanged): fixed demo feeRate against OrdMockProvider.
      await this.sdk.lifecycle.inscribeOnBitcoin(this.asset, opts?.feeRate ?? 7);
    }
    const state = this.snapshot();
    if (state.inscription) {
      this.emit(
        'asset:inscribed',
        `Inscribed on satoshi ${state.inscription.satoshi} — tx ${state.inscription.txid}`,
        state.inscription
      );
    }

    // Signed-in real inscription: enrich the durable /me record with the
    // did:btco state (upsert-merge by did on the server). Best-effort — a
    // failure must not break the inscribe UX; the on-chain state is the truth.
    if (this.authed && opts?.funding && state.inscription && state.webvhDid) {
      try {
        const res = await fetch('/api/originals', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            did: state.webvhDid,
            title: this.assetTitle,
            resourceHash: this.assetResourceHash,
            btcoDid: state.btcoDid,
            inscriptionId: state.inscription.inscriptionId,
            commitTxId: state.inscription.commitTxId,
            revealTxId: state.inscription.txid,
            satoshi: state.inscription.satoshi,
            status: 'pending',
          }),
        });
        if (!res.ok) log('originals:record-failed', res.status);
      } catch (err) {
        log('originals:record-failed', err);
      }
    }
    return state;
  }

  snapshot(): DemoAssetState {
    const asset = this.asset;
    if (!asset) throw new Error('No asset yet');
    const provenance = asset.getProvenance() as {
      migrations: Array<{
        to: string;
        transactionId?: string;
        inscriptionId?: string;
        satoshi?: string;
        commitTxId?: string;
        feeRate?: number;
      }>;
    };
    const last = provenance.migrations[provenance.migrations.length - 1];
    const bindings = (asset.bindings ?? {}) as Record<string, string>;
    // `resources` GROWS by append — addResourceVersion pushes v2 rather than
    // replacing v1 — so index-based reads would pin the panel to genesis
    // forever. Select the newest version of each logical resource by id.
    const primaryId = asset.resources[0].id;
    const res = latestVersion(asset.resources, primaryId)!;
    const metaId = asset.resources.find((r) => r.id !== primaryId)?.id;
    const meta = metaId ? latestVersion(asset.resources, metaId) : undefined;
    return {
      layer: asset.currentLayer as LayerId,
      did: asset.id,
      webvhDid: bindings['did:webvh'],
      webvhLogUrl: this.webvhLogUrl ?? undefined,
      webvhResolved: this.webvhResolved,
      btcoDid: bindings['did:btco'],
      resource: {
        id: res.id,
        hash: res.hash,
        contentType: res.contentType,
        content: res.content ?? '',
        version: res.version ?? 1
      },
      metadata: meta
        ? { id: meta.id, hash: meta.hash, content: meta.content ?? '' }
        : undefined,
      credentials: asset.credentials.length,
      celLog: celEntries(asset),
      inscription:
        last && last.to === 'did:btco' && last.transactionId
          ? {
              txid: last.transactionId,
              inscriptionId: last.inscriptionId ?? '',
              satoshi: last.satoshi ?? '',
              commitTxId: last.commitTxId,
              feeRate: last.feeRate,
              explorerUrl: btcoExplorerUrl(last.transactionId)
            }
          : undefined,
      provenance
    };
  }
}


/**
 * The asset's metadata resource. One builder for genesis and every revision —
 * two shapes here would let an edit silently change a field it never meant to.
 */
function buildMetadata(input: {
  title: string;
  medium: string;
  created: string;
  artworkHash: string;
}): string {
  return JSON.stringify(
    {
      title: input.title,
      medium: input.medium,
      creator: 'you',
      created: input.created,
      artwork: { file: 'artwork.svg', sha256: input.artworkHash }
    },
    null,
    2
  );
}

/** Genesis `created` read back off the current metadata; now if unreadable. */
function createdAtOf(metadataJson: string): string {
  try {
    const created = (JSON.parse(metadataJson) as { created?: unknown }).created;
    if (typeof created === 'string' && created) return created;
  } catch {
    // A hand-edited or truncated blob must not break the edit.
  }
  return new Date().toISOString();
}

interface VersionedResource {
  id: string;
  hash: string;
  contentType: string;
  content?: string;
  version?: number;
}

/** The newest version of one logical resource (v1 when nothing was revised). */
function latestVersion(
  resources: readonly VersionedResource[],
  id: string
): VersionedResource | undefined {
  return resources
    .filter((r) => r.id === id)
    .reduce<VersionedResource | undefined>(
      (best, r) => (!best || (r.version ?? 1) > (best.version ?? 1) ? r : best),
      undefined
    );
}

/**
 * Read the asset's CEL defensively: it is the source of provenance truth, but a
 * demo panel must never be the thing that breaks a lifecycle step, so an
 * unexpected shape degrades to an empty chain rather than throwing.
 */
function celEntries(asset: unknown): CelEntry[] {
  const log = (asset as { celLog?: { events?: unknown } }).celLog;
  const events = log?.events;
  if (!Array.isArray(events)) return [];
  return events.map((e) => {
    const entry = (e ?? {}) as Record<string, unknown>;
    return {
      type: typeof entry.type === 'string' ? entry.type : 'unknown',
      data: (entry.data ?? {}) as Record<string, unknown>,
      previousEvent:
        typeof entry.previousEvent === 'string' ? entry.previousEvent : undefined,
      proof: Array.isArray(entry.proof) ? (entry.proof as CelEntry['proof']) : []
    };
  });
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// btcoExplorerUrl moved to ./network-flag (re-exported above) so light page
// chunks can link explorers without pulling in this heavy engine module.

// The origin host we host did:webvh logs under. In the browser this is the
// live origin; VITE_WEBVH_HOST overrides it for the deployed host or tests.
function demoHost(): string {
  const envHost = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_WEBVH_HOST;
  if (envHost) return envHost;
  if (typeof window !== 'undefined' && window.location?.host) return window.location.host;
  return 'localhost';
}

// Mirrors didwebvh-ts getFileUrl: pathed DID → https://<host>/<segs>/did.jsonl,
// domain-root DID → https://<host>/.well-known/did.jsonl. This is the exact URL
// the resolver GETs (protocol is always https).
function webvhLogUrl(did: string): string {
  const parts = did.split(':'); // did:webvh:<SCID>:<domain>[:<seg>…]
  const domain = decodeURIComponent(parts[3] ?? '');
  const segs = parts.slice(4).map((s) => decodeURIComponent(s));
  const base = `https://${domain}`;
  return segs.length ? `${base}/${segs.join('/')}/did.jsonl` : `${base}/.well-known/did.jsonl`;
}
