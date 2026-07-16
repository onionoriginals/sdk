/**
 * The live engine behind the landing-page demo.
 *
 * Everything here calls the real @originals/sdk — the same package a
 * developer gets from `npm install @originals/sdk`. Nothing is canned:
 * DIDs, hashes, credentials, events and provenance all come back from
 * actual SDK calls. Bitcoin operations run against OrdMockProvider, the
 * SDK's own in-memory Ordinals provider, so no wallet or node is needed.
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
  MemoryStorageAdapter,
  type OriginalsAsset
} from '@originals/sdk';
import { sha256 } from '@noble/hashes/sha2.js';

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
  asset: OriginalsAsset | null = null;

  constructor() {
    // Deliberately public and permanent: lets anyone (including skeptics)
    // inspect the live engine from the devtools console. Reassigned on every
    // construction so it always points at the engine currently driving the UI.
    (globalThis as Record<string, unknown>).__originalsDemo = this;
    const keys = this.keys;
    this.sdk = OriginalsSDK.create({
      network: 'regtest',
      webvhNetwork: 'magby',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: new OrdMockProvider(),
      storageAdapter: new MemoryStorageAdapter(),
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
      `Asset created as ${short(e.asset.id)} — a private did:cel identity, generated entirely offline`
    );
    forward(
      'resource:published',
      (e: { resource: { id: string } }) =>
        `Resource "${e.resource.id}" published to hosted storage`
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
    return this.snapshot();
  }

  /** Step 3 — inscribe on Bitcoin (OrdMockProvider; regtest semantics). */
  async inscribe(feeRate = 7): Promise<DemoAssetState> {
    if (!this.asset) throw new Error('Create an asset first');
    await this.sdk.lifecycle.inscribeOnBitcoin(this.asset, feeRate);
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
              feeRate: last.feeRate
            }
          : undefined,
      provenance
    };
  }
}


function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
