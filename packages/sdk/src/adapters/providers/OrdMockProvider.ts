import { OrdinalsProvider } from '../types.js';

export interface OrdMockState {
  inscriptionsById: Map<string, {
    inscriptionId: string;
    content: Buffer;
    contentType: string;
    txid: string;
    vout: number;
    satoshi?: string;
    blockHeight?: number;
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
    return rec ? { ...rec } : null;
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
    buildContent?: (satoshi: string) => Buffer | Promise<Buffer>;
    contentType: string;
    feeRate?: number;
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
    const content = params.buildContent
      ? Buffer.from(await params.buildContent(satoshi))
      : params.data!;
    const vout = 0;
    const record = {
      inscriptionId,
      content,
      contentType: params.contentType,
      txid,
      vout,
      satoshi,
      blockHeight: 1
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
      feeRate: params.feeRate
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getSatOwnership(satoshi: string): Promise<{ address: string; outpoint: string } | null> {
    return this.state.ownershipBySatoshi.get(satoshi) ?? null;
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

