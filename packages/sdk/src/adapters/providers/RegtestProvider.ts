import type { OrdinalsProvider } from '../types.js';
import { enumerateAnchoringsOnSat } from '../anchoring-enumeration.js';
import { decode as decodeCbor } from '@originals/cel/cbor';
import { hexToBytes } from '@originals/cel/encoding';

export interface RegtestProviderOptions {
  ordUrl: string;
  rpcUrl: string;
  /** Bitcoin Core cookie contents (user:password), supplied by the local host. */
  rpcAuth: string;
  /** Explicit local test rate; this is not an estimate of public-chain demand. */
  feeRate?: number;
}

export interface RegtestOutput {
  address: string | null;
  indexed: boolean;
  inscriptions: string[];
  sat_ranges: Array<[number, number]> | null;
  script_pubkey: string;
  spent: boolean;
  value: number;
  confirmations: number;
}

const OUTPOINT = /^[0-9a-f]{64}:\d+$/;
const TXID = /^[0-9a-f]{64}$/;
const INSCRIPTION = /^[0-9a-f]{64}i\d+$/;
const SAT = /^\d+$/;

/** Real local ord reads and Core RPC, used with the SDK's own transaction builders. */
export class RegtestProvider implements OrdinalsProvider {
  private readonly ordUrl: string;
  private readonly rpcUrl: string;
  private readonly rpcAuth: string;
  private readonly feeRate: number;

  constructor(options: RegtestProviderOptions) {
    const local = (value: string) => {
      const url = new URL(value);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) {
        throw new Error('RegtestProvider requires explicit HTTP loopback endpoints');
      }
      return url.href.replace(/\/+$/, '');
    };
    this.ordUrl = local(options.ordUrl);
    this.rpcUrl = local(options.rpcUrl);
    this.rpcAuth = options.rpcAuth;
    this.feeRate = options.feeRate ?? 2;
    if (!Number.isFinite(this.feeRate) || this.feeRate <= 0 || this.feeRate > 100) throw new Error('Invalid regtest fee rate');
  }

  private async bytes(url: string, init?: RequestInit): Promise<Uint8Array | null> {
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Regtest HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Regtest response has no body');
    const parts: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 5 * 1024 * 1024) { await reader.cancel(); throw new Error('Regtest response exceeds 5 MiB'); }
      parts.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return bytes;
  }

  private async ord<T>(path: string): Promise<T | null> {
    const bytes = await this.bytes(this.ordUrl + path, { headers: { accept: 'application/json' } });
    return bytes === null ? null : JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  private async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const bytes = await this.bytes(this.rpcUrl, {
      method: 'POST', headers: { authorization: `Basic ${btoa(this.rpcAuth)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'originals', method, params }),
    });
    if (!bytes) throw new Error(`Regtest RPC endpoint missing: ${method}`);
    const body = JSON.parse(new TextDecoder().decode(bytes)) as { result: T; error?: { code: number; message: string } };
    if (body.error) throw Object.assign(new Error(`${method}: ${body.error.message}`), { code: body.error.code });
    return body.result;
  }

  async assertNetwork(): Promise<void> {
    const core = await this.rpc<{ chain: string }>('getblockchaininfo');
    if (core.chain !== 'regtest') throw new Error('Bitcoin Core must report regtest');
    const ord = await this.ord<{ chain: string; sat_index: boolean; address_index: boolean; unrecoverably_reorged?: boolean }>('/status');
    if (ord?.chain !== 'regtest' || !ord.sat_index || !ord.address_index || ord.unrecoverably_reorged) throw new Error('ord must have healthy regtest sat and address indexes');
  }

  private async assertIndexedTip(): Promise<void> {
    await this.assertNetwork();
    const tip = await this.rpc<{ blocks: number; bestblockhash: string }>('getblockchaininfo');
    const status = await this.ord<{ height: number }>('/status');
    // ord serves this endpoint as plain text, including with an Accept: JSON header.
    const hash = await this.bytes(`${this.ordUrl}/blockhash/${tip.blocks}`);
    if (status?.height !== tip.blocks || !hash || new TextDecoder().decode(hash).trim() !== tip.bestblockhash) {
      throw new Error('ord has not indexed the current Bitcoin Core tip');
    }
  }

  async broadcastTransaction(raw: unknown): Promise<string> {
    await this.assertNetwork();
    if (typeof raw !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(raw)) throw new Error('Raw transaction hex required');
    return this.rpc<string>('sendrawtransaction', [raw]);
  }

  async estimateFee(): Promise<number> { await this.assertNetwork(); return this.feeRate; }

  async getTransactionStatus(txid: string): Promise<{ confirmed: boolean; confirmations: number; blockHeight?: number }> {
    if (!TXID.test(txid)) throw new Error('Invalid transaction id');
    await this.assertNetwork();
    try {
      const tx = await this.rpc<{ confirmations?: number; blockhash?: string }>('getrawtransaction', [txid, true]);
      const confirmations = Math.max(0, tx.confirmations ?? 0);
      if (!confirmations || !tx.blockhash) return { confirmed: false, confirmations: 0 };
      const header = await this.rpc<{ height: number; confirmations: number }>('getblockheader', [tx.blockhash]);
      if (header.confirmations < 1) return { confirmed: false, confirmations: 0 };
      return { confirmed: true, confirmations, blockHeight: header.height };
    } catch (error) {
      if ((error as { code?: number }).code === -5) return { confirmed: false, confirmations: 0 };
      throw error;
    }
  }

  async getRawTransaction(txid: string): Promise<string> {
    if (!TXID.test(txid)) throw new Error('Invalid transaction id');
    await this.assertNetwork();
    return this.rpc<string>('getrawtransaction', [txid, false]);
  }

  async getOutputDetails(outpoint: string): Promise<RegtestOutput> {
    if (!OUTPOINT.test(outpoint)) throw new Error('Invalid outpoint');
    await this.assertIndexedTip();
    const output = await this.ord<RegtestOutput>(`/output/${outpoint}`);
    if (!output?.indexed || !Array.isArray(output.inscriptions) || !Number.isSafeInteger(output.value) || output.value < 0) throw new Error('Output unavailable or not indexed');
    return output;
  }

  async getFirstSatOfOutput(output: { txid: string; vout: number }): Promise<string> {
    await this.assertNetwork();
    const result = await this.getOutputDetails(`${output.txid}:${output.vout}`);
    const sat = result.sat_ranges?.[0]?.[0];
    if (result.spent || !Number.isSafeInteger(sat) || sat! < 0) throw new Error('Unspent output sat ranges unavailable');
    return String(sat);
  }

  async getInscriptionsBySatoshi(satoshi: string): Promise<Array<{ inscriptionId: string }>> {
    if (!SAT.test(satoshi)) throw new Error('Invalid satoshi');
    await this.assertIndexedTip();
    const sat = await this.ord<{ inscriptions: string[] }>(`/sat/${satoshi}`);
    if (!sat || !Array.isArray(sat.inscriptions)) throw new Error('Sat index unavailable');
    const inscriptions = await Promise.all(sat.inscriptions.map(async id => {
      if (!INSCRIPTION.test(id)) throw new Error('Invalid inscription id from ord');
      const info = await this.ord<{ number: number }>(`/inscription/${id}`);
      if (!info || !Number.isSafeInteger(info.number)) throw new Error('Listed inscription unavailable');
      return { inscriptionId: id, number: info.number };
    }));
    return inscriptions.sort((a, b) => a.number - b.number).map(({ inscriptionId }) => ({ inscriptionId }));
  }

  async getInscriptionById(id: string) {
    if (!INSCRIPTION.test(id)) throw new Error('Invalid inscription id');
    await this.assertIndexedTip();
    const info = await this.ord<{ id: string; sat: number | null; height: number; content_type: string | null }>(`/inscription/${id}`);
    if (!info) return null;
    if (info.id !== id || !Number.isSafeInteger(info.sat) || !Number.isSafeInteger(info.height)) throw new Error('Incomplete inscription data');
    const content = await this.bytes(`${this.ordUrl}/content/${id}`);
    if (!content) throw new Error('Listed inscription content unavailable');
    const metadataHex = await this.ord<string>(`/r/metadata/${id}`);
    const metadata = metadataHex === null ? undefined : decodeCbor<Record<string, unknown>>(hexToBytes(metadataHex));
    return { inscriptionId: id, content, contentType: info.content_type ?? 'application/octet-stream',
      txid: id.split('i')[0], vout: 0, satoshi: String(info.sat), blockHeight: info.height,
      ...(metadata === undefined ? {} : { metadata }) };
  }

  async getSatOwnership(satoshi: string): Promise<{ address: string; outpoint: string } | null> {
    if (!SAT.test(satoshi)) throw new Error('Invalid satoshi');
    await this.assertIndexedTip();
    const sat = await this.ord<{ address: string | null; satpoint: string | null }>(`/sat/${satoshi}`);
    if (!sat) throw new Error('Sat index unavailable');
    if (!sat.address || !sat.satpoint) return null;
    return { address: sat.address, outpoint: sat.satpoint.split(':').slice(0, 2).join(':') };
  }

  async getAddressUtxos(address: string) {
    if (!/^bcrt1[ac-hj-np-z02-9]+$/.test(address)) throw new Error('Expected a regtest bech32 address');
    await this.assertIndexedTip();
    const info = await this.ord<{ outputs: string[] }>(`/address/${address}`);
    if (!info || !Array.isArray(info.outputs)) throw new Error('Address index unavailable');
    const outputs = await Promise.all(info.outputs.map(async outpoint => {
      const output = await this.getOutputDetails(outpoint);
      const [txid, index] = outpoint.split(':');
      return { txid, vout: Number(index), value: output.value, scriptPubKey: output.script_pubkey,
        status: { confirmed: output.confirmations > 0 }, spent: output.spent };
    }));
    return outputs.filter(output => !output.spent);
  }

  getAnchoringsForDidCel(didCel: string, options?: { satoshi?: string }) {
    return enumerateAnchoringsOnSat(this, didCel, options?.satoshi, 'RegtestProvider');
  }

  createInscription(): Promise<never> { return Promise.reject(new Error('Use the SDK sat-selected transaction builder')); }
  transferInscription(): Promise<never> { return Promise.reject(new Error('Use the SDK signed transfer transaction builder')); }
}
