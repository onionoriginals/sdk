import { OrdinalsProvider, InscriptionParts } from '../types.js';

export interface OrdMockState {
  inscriptionsById: Map<string, {
    inscriptionId: string;
    content: Buffer;
    contentType: string;
    txid: string;
    vout: number;
    satoshi?: string;
    blockHeight?: number;
    metadata?: Record<string, unknown>;
  }>;
  inscriptionsBySatoshi: Map<string, string[]>;
  ownershipBySatoshi: Map<string, { address: string; outpoint: string }>;
  feeRate: number;
}

export class OrdMockProvider implements OrdinalsProvider {
  private state: OrdMockState;

  constructor(state?: Partial<OrdMockState>) {
    this.state = {
      inscriptionsById: new Map(),
      inscriptionsBySatoshi: new Map(),
      ownershipBySatoshi: new Map(),
      feeRate: 5,
      ...state
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getInscriptionById(id: string) {
    const rec = this.state.inscriptionsById.get(id);
    if (!rec) return null;
    // Clone metadata so a reader mutating the result cannot corrupt stored state.
    return {
      ...rec,
      ...(rec.metadata !== undefined
        ? { metadata: structuredClone(rec.metadata) as Record<string, unknown> }
        : {})
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getInscriptionsBySatoshi(satoshi: string) {
    const list = this.state.inscriptionsBySatoshi.get(satoshi) || [];
    return list.map((inscriptionId) => ({ inscriptionId }));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async broadcastTransaction(_txHexOrObj: unknown): Promise<string> {
    return 'mock-broadcast-txid';
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getTransactionStatus(_txid: string) {
    return { confirmed: true, blockHeight: 1, confirmations: 1 };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async estimateFee(blocks = 1): Promise<number> {
    return Math.max(1, this.state.feeRate - (blocks - 1));
  }

  async createInscription(params: {
    data?: Buffer;
    buildContent?: (satoshi: string) => InscriptionParts | Promise<InscriptionParts>;
    contentType: string;
    feeRate?: number;
    metadata?: Record<string, unknown>;
    targetSatoshi?: string;
  }) {
    if ((params.data === undefined) === (params.buildContent === undefined)) {
      throw new Error('createInscription requires exactly one of data or buildContent');
    }
    const inscriptionId = `insc-${Math.random().toString(36).slice(2)}`;
    const txid = `tx-${Math.random().toString(36).slice(2)}`;
    // Pin the sat FIRST (mirrors real commit-phase sat assignment), then let
    // deferred content embed it.
    const satoshi = params.targetSatoshi ?? `${Math.floor(Math.random() * 1e12)}`;
    // Normalize the deferred build result: a bare Buffer (content only) or
    // `{ content, metadata }` (#407 phase 2). Deferred metadata wins over the
    // static `metadata` param.
    let content: Buffer;
    let deferredMetadata: Record<string, unknown> | undefined;
    if (params.buildContent) {
      const built = await params.buildContent(satoshi);
      if (Buffer.isBuffer(built)) {
        content = Buffer.from(built);
      } else {
        content = Buffer.from(built.content);
        deferredMetadata = built.metadata;
      }
    } else {
      content = params.data!;
    }
    const metadata = deferredMetadata ?? params.metadata;
    const vout = 0;
    // Round-trip metadata as a structural clone so a caller mutating its input
    // object after inscription cannot retroactively change the stored copy
    // (mirrors a real CBOR encode/decode boundary).
    const storedMetadata = metadata !== undefined
      ? (structuredClone(metadata) as Record<string, unknown>)
      : undefined;
    const record = {
      inscriptionId,
      content,
      contentType: params.contentType,
      txid,
      vout,
      satoshi,
      blockHeight: 1,
      ...(storedMetadata !== undefined ? { metadata: storedMetadata } : {})
    };
    this.state.inscriptionsById.set(inscriptionId, record);
    const list = this.state.inscriptionsBySatoshi.get(satoshi) || [];
    list.push(inscriptionId);
    this.state.inscriptionsBySatoshi.set(satoshi, list);
    this.state.ownershipBySatoshi.set(satoshi, { address: 'bcrt1qmockowner', outpoint: `${txid}:${vout}` });
    return {
      inscriptionId,
      revealTxId: txid,
      commitTxId: undefined,
      satoshi,
      txid,
      vout,
      blockHeight: 1,
      content,
      contentType: params.contentType,
      feeRate: params.feeRate,
      ...(storedMetadata !== undefined ? { metadata: structuredClone(storedMetadata) as Record<string, unknown> } : {})
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getSatOwnership(satoshi: string): Promise<{ address: string; outpoint: string } | null> {
    return this.state.ownershipBySatoshi.get(satoshi) ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getAnchoringsForDidCel(didCel: string): Promise<Array<{
    satoshi: string;
    inscriptionId: string;
    blockHeight?: number;
  }>> {
    const out: Array<{ satoshi: string; inscriptionId: string; blockHeight?: number }> = [];
    for (const rec of this.state.inscriptionsById.values()) {
      if (rec.satoshi === undefined) continue;
      // #407 phase 2: the DID document rides in inscription METADATA (content is
      // the asset media). Prefer metadata.didDocument; fall back to parsing the
      // content as a DID document JSON (phase-1 content-as-DID-doc inscriptions).
      let doc: unknown = (rec.metadata as { didDocument?: unknown } | undefined)?.didDocument;
      if (doc === undefined) {
        try {
          doc = JSON.parse(rec.content.toString('utf8'));
        } catch {
          continue; // non-JSON, no metadata DID doc — not an anchoring inscription
        }
      }
      const aka = (doc as { alsoKnownAs?: unknown } | null)?.alsoKnownAs;
      if (Array.isArray(aka) && aka.includes(didCel)) {
        out.push({ satoshi: rec.satoshi, inscriptionId: rec.inscriptionId, blockHeight: rec.blockHeight });
      }
    }
    return out;
  }

  async transferInscription(inscriptionId: string, toAddress: string, _options?: { feeRate?: number }) {
    const rec = this.state.inscriptionsById.get(inscriptionId);
    if (!rec) {
      return Promise.reject(new Error('inscription not found'));
    }
    const txid = `tx-${Math.random().toString(36).slice(2)}`;
    if (rec.satoshi) {
      this.state.ownershipBySatoshi.set(rec.satoshi, { address: toAddress, outpoint: `${txid}:0` });
    }
    return {
      txid,
      vin: [{ txid: rec.txid, vout: rec.vout }],
      vout: [{ value: 546, scriptPubKey: 'script' }],
      fee: 100,
      blockHeight: 1,
      confirmations: 0,
      satoshi: rec.satoshi
    };
  }
}

