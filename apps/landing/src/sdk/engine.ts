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
  OrdMockProvider,
  type OriginalsAsset
} from '@originals/sdk';
import { HttpHostingStorageAdapter } from './http-hosting-adapter';
import { HttpOrdinalsProvider } from './http-ordinals-provider';
import { TurnkeySatSigner } from './turnkey-sat-signer';
import { btcTestnetEnabled } from './testnet-flag';
import type { TurnkeyBitcoinClient } from '../auth/turnkey-session';
import { sha256 } from '@noble/hashes/sha2.js';

export { btcTestnetEnabled } from './testnet-flag';

export type LayerId = 'did:cel' | 'did:webvh' | 'did:btco';

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
  };
  metadata?: {
    id: string;
    hash: string;
    content: string;
  };
  credentials: number;
  inscription?: {
    txid: string;
    inscriptionId: string;
    satoshi: string;
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
  asset: OriginalsAsset | null = null;

  constructor() {
    // Deliberately public and permanent: lets anyone (including skeptics)
    // inspect the live engine from the devtools console. Reassigned on every
    // construction so it always points at the engine currently driving the UI.
    (globalThis as Record<string, unknown>).__originalsDemo = this;
    const keys = this.keys;
    // Track B: when the deploy enables testnet4 signing, inscribe for real over
    // the /api/btc/* QuickNode proxies on Bitcoin testnet4; otherwise keep the
    // self-contained OrdMockProvider mock (regtest) unchanged.
    const testnet = btcTestnetEnabled();
    this.sdk = OriginalsSDK.create({
      network: testnet ? 'testnet' : 'regtest',
      webvhNetwork: 'magby',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: testnet ? new HttpOrdinalsProvider() : new OrdMockProvider(),
      // Real HTTP hosting at this origin — the SDK's did:webvh log becomes
      // resolvable over HTTP(S) (see http-hosting-adapter.ts).
      storageAdapter: new HttpHostingStorageAdapter(),
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

    const metadata = JSON.stringify(
      {
        title,
        medium,
        creator: 'you',
        created: new Date().toISOString(),
        artwork: { file: 'artwork.svg', sha256: svgHash }
      },
      null,
      2
    );
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

    asset.on('asset:migrated', (e: { asset: { fromLayer: string; toLayer: string } }) => {
      this.emit(
        'asset:migrated',
        `Migrated ${e.asset.fromLayer} → ${e.asset.toLayer}`,
        e
      );
    });

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
      const webvh = await this.sdk.did.createDIDWebVH({
        domain: demoHost(),
        paths: ['studio', 'you']
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
    const feeRate = opts?.feeRate ?? 7;
    if (opts?.funding) {
      // Real sat-selected path: the user's Turnkey key signs the commit.
      const satSigner = new TurnkeySatSigner({
        client: opts.funding.signingClient,
        signWith: opts.funding.changeAddress, // the user's tb1q funding address IS signWith
      });
      await this.sdk.lifecycle.inscribeOnBitcoin(this.asset, {
        fundingUtxo: opts.funding.fundingUtxo,
        satSigner,
        changeAddress: opts.funding.changeAddress,
        feeRate,
      });
    } else {
      // Mock path (unchanged): bare feeRate against OrdMockProvider.
      await this.sdk.lifecycle.inscribeOnBitcoin(this.asset, feeRate);
    }
    const state = this.snapshot();
    if (state.inscription) {
      this.emit(
        'asset:inscribed',
        `Inscribed on satoshi ${state.inscription.satoshi} — tx ${state.inscription.txid}`,
        state.inscription
      );
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
        feeRate?: number;
      }>;
    };
    const last = provenance.migrations[provenance.migrations.length - 1];
    const bindings = (asset.bindings ?? {}) as Record<string, string>;
    const res = asset.resources[0];
    const meta = asset.resources[1] as { id: string; hash: string; content?: string } | undefined;
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
        content: (res as { content?: string }).content ?? ''
      },
      metadata: meta
        ? { id: meta.id, hash: meta.hash, content: meta.content ?? '' }
        : undefined,
      credentials: asset.credentials.length,
      inscription:
        last && last.to === 'did:btco' && last.transactionId
          ? {
              txid: last.transactionId,
              inscriptionId: last.inscriptionId ?? '',
              satoshi: last.satoshi ?? '',
              feeRate: last.feeRate,
              explorerUrl: btcoExplorerUrl(last.transactionId)
            }
          : undefined,
      provenance
    };
  }
}


function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// The testnet4 block explorer link for a real inscription's reveal txid. Only
// produced when testnet is enabled — a mock/regtest txid has no public explorer.
export function btcoExplorerUrl(txid: string): string | undefined {
  if (!btcTestnetEnabled() || !txid) return undefined;
  return `https://mempool.space/testnet4/tx/${txid}`;
}

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
