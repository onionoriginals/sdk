import { OrdinalsInscription, BitcoinTransaction } from '../types';
import { emitTelemetry } from '../utils/telemetry';
import { decode as decodeCbor } from '../utils/cbor';
import { hexToBytes } from '../utils/encoding';

export class OrdinalsClient {
  constructor(
    private rpcUrl: string,
    private network: 'mainnet' | 'testnet' | 'regtest' | 'signet'
  ) {}

  async getInscriptionById(id: string): Promise<OrdinalsInscription | null> {
    if (!id) return null;
    return this.resolveInscription(id);
  }

  async getInscriptionsBySatoshi(satoshi: string): Promise<OrdinalsInscription[]> {
    const info = await this.getSatInfo(satoshi);
    if (!info.inscription_ids.length) return [];
    const inscriptions = await Promise.all(info.inscription_ids.map(id => this.resolveInscription(id)));
    return inscriptions.filter((x): x is OrdinalsInscription => x !== null);
  }

  async broadcastTransaction(tx: BitcoinTransaction): Promise<string> {
    return tx.txid || 'txid';
  }

  async getTransactionStatus(txid: string): Promise<{
    confirmed: boolean;
    blockHeight?: number;
    confirmations?: number;
  }> {
    return { confirmed: false };
  }

  async estimateFee(blocks: number = 1): Promise<number> {
    return Math.max(1, blocks) * 10;
  }

  // Added provider-like helper methods commonly expected by higher-level resolvers
  // Minimal placeholder implementations suitable for unit testing

  async getSatInfo(satoshi: string): Promise<{ inscription_ids: string[] }> {
    const data = await this.fetchJson<any>(`/sat/${satoshi}`);
    if (!data) return { inscription_ids: [] };
    // Support both {inscription_ids: []} and {data: {inscription_ids: []}} shapes via fetchJson
    const inscriptionIds = Array.isArray(data.inscription_ids) ? data.inscription_ids : [];
    return { inscription_ids: inscriptionIds };
  }

  async resolveInscription(identifier: string): Promise<OrdinalsInscription | null> {
    if (!identifier) return null;
    const info = await this.fetchJson<any>(`/inscription/${identifier}`);
    if (!info) return null;

    // Fetch content bytes
    const contentUrl = info.content_url || `${this.rpcUrl}/content/${identifier}`;
    const contentRes = await fetch(contentUrl);
    if (!contentRes.ok) throw new Error(`Failed to fetch inscription content: ${contentRes.status}`);
    const contentArrayBuf = await contentRes.arrayBuffer();
    const content = Buffer.from(new Uint8Array(contentArrayBuf));

    // owner_output may be 'txid:vout'
    let txid = 'unknown';
    let vout = 0;
    if (typeof info.owner_output === 'string' && info.owner_output.includes(':')) {
      const [tid, v] = info.owner_output.split(':');
      txid = tid;
      vout = Number(v) || 0;
    }

    // sat number provided as number or string
    const satoshi = String(info.sat ?? '');

    const inscription: OrdinalsInscription = {
      satoshi,
      inscriptionId: info.inscription_id || identifier,
      content,
      contentType: info.content_type || 'application/octet-stream',
      txid,
      vout,
      blockHeight: info.block_height
    };

    return inscription;
  }

  async getMetadata(inscriptionId: string): Promise<Record<string, unknown> | null> {
    if (!inscriptionId) return null;
    const base = this.rpcUrl.replace(/\/$/, '');
    const res = await fetch(`${base}/r/metadata/${inscriptionId}`, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) {
      return null;
    }
    let text = (await res.text()).trim();
    if (text.startsWith('"') && text.endsWith('"')) {
      try {
        text = JSON.parse(text);
      } catch (_) {}
    }
    try {
      const bytes = hexToBytes(text);
      return decodeCbor<Record<string, unknown>>(bytes);
    } catch (_) {
      return null;
    }
  }

  private async fetchJson<T>(path: string): Promise<T | null> {
    const url = `${this.rpcUrl.replace(/\/$/, '')}${path}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const body: any = await res.json();
    // Accept { data: T } or T
    return (body && typeof body === 'object' && 'data' in body) ? (body as any).data as T : (body as T);
  }
}


