import { OrdinalsProvider } from '../types';

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
  feeRate: number;
}

export class OrdMockProvider implements OrdinalsProvider {
  private state: OrdMockState;

  constructor(state?: Partial<OrdMockState>) {
    this.state = {
      inscriptionsById: new Map(),
      inscriptionsBySatoshi: new Map(),
      feeRate: 5,
      ...state
    } as OrdMockState;
  }

  async getInscriptionById(id: string) {
    const rec = this.state.inscriptionsById.get(id);
    return rec ? { ...rec } : null;
  }

  async getInscriptionsBySatoshi(satoshi: string) {
    const list = this.state.inscriptionsBySatoshi.get(satoshi) || [];
    return list.map((inscriptionId) => ({ inscriptionId }));
  }

  async broadcastTransaction(_txHexOrObj: unknown): Promise<string> {
    return 'mock-broadcast-txid';
  }

  async getTransactionStatus(txid: string) {
    return { confirmed: true, blockHeight: 1, confirmations: 1 };
  }

  async estimateFee(blocks = 1): Promise<number> {
    return Math.max(1, this.state.feeRate - (blocks - 1));
  }

  async createInscription(params: { data: Buffer; contentType: string; feeRate?: number; }) {
    const inscriptionId = `insc-${Math.random().toString(36).slice(2)}`;
    const txid = `tx-${Math.random().toString(36).slice(2)}`;
    const satoshi = `sat-${Math.floor(Math.random() * 1e6)}`;
    const vout = 0;
    const record = {
      inscriptionId,
      content: params.data,
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
    return {
      inscriptionId,
      revealTxId: txid,
      commitTxId: undefined,
      satoshi,
      txid,
      vout,
      blockHeight: 1,
      content: params.data,
      contentType: params.contentType,
      feeRate: params.feeRate
    };
  }

  async transferInscription(inscriptionId: string, _toAddress: string, _options?: { feeRate?: number }) {
    const rec = this.state.inscriptionsById.get(inscriptionId);
    if (!rec) {
      return Promise.reject(new Error('inscription not found'));
    }
    const txid = `tx-${Math.random().toString(36).slice(2)}`;
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

