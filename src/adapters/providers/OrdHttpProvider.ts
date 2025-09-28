/* istanbul ignore file */
import type { OrdinalsProvider } from '../types';

interface HttpProviderOptions {
  baseUrl: string;
}

function buildUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const res = await (globalThis as any).fetch(url, {
    headers: {
      'Accept': 'application/json'
    }
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export class OrdHttpProvider implements OrdinalsProvider {
  private readonly baseUrl: string;

  constructor(options: HttpProviderOptions) {
    if (!options?.baseUrl) {
      throw new Error('OrdHttpProvider requires baseUrl');
    }
    this.baseUrl = options.baseUrl;
  }

  async getInscriptionById(id: string) {
    if (!id) return null;
    const data = await fetchJson<any>(buildUrl(this.baseUrl, `/inscription/${id}`));
    if (!data) return null;
    // Expecting a shape similar to Ordinals indexers; adapt minimally
    const ownerOutput: string | undefined = data.owner_output;
    let txid = data.txid || 'unknown';
    let vout = typeof data.vout === 'number' ? data.vout : 0;
    if (ownerOutput && ownerOutput.includes(':')) {
      const [tid, v] = ownerOutput.split(':');
      txid = tid;
      vout = Number(v) || 0;
    }

    const contentType = data.content_type || 'application/octet-stream';
    const contentUrl = data.content_url || buildUrl(this.baseUrl, `/content/${id}`);
    const contentRes = await (globalThis as any).fetch(contentUrl);
    if (!contentRes.ok) return null;
    const buf = (globalThis as any).Buffer
      ? (globalThis as any).Buffer.from(new Uint8Array(await contentRes.arrayBuffer()))
      : new Uint8Array(await contentRes.arrayBuffer()) as any;

    return {
      inscriptionId: data.inscription_id || id,
      content: buf,
      contentType,
      txid,
      vout,
      satoshi: String(data.sat ?? ''),
      blockHeight: data.block_height
    };
  }

  async getInscriptionsBySatoshi(satoshi: string) {
    if (!satoshi) return [];
    const data = await fetchJson<any>(buildUrl(this.baseUrl, `/sat/${satoshi}`));
    const ids: string[] = Array.isArray(data?.inscription_ids) ? data.inscription_ids : [];
    return ids.map((inscriptionId) => ({ inscriptionId }));
  }

  async broadcastTransaction(_txHexOrObj: unknown): Promise<string> {
    // For example purposes only, return a placeholder
    return 'broadcast-txid';
  }

  async getTransactionStatus(_txid: string) {
    return { confirmed: false };
  }

  async estimateFee(blocks: number = 1): Promise<number> {
    // Basic fallback: some providers expose fee estimates; for example purposes, return linear estimate
    return 5 * Math.max(1, blocks);
  }

  async createInscription(params: { data: any; contentType: string; feeRate?: number; }) {
    // Example placeholder: a real implementation would POST to a service
    // Here we return a deterministic mock-like result to avoid network coupling in code
    const inscriptionId = `insc-${Math.random().toString(36).slice(2)}`;
    const txid = `tx-${Math.random().toString(36).slice(2)}`;
    return {
      inscriptionId,
      revealTxId: txid,
      txid,
      vout: 0,
      blockHeight: undefined,
      content: params.data,
      contentType: params.contentType,
      feeRate: params.feeRate
    };
  }

  async transferInscription(inscriptionId: string, _toAddress: string, _options?: { feeRate?: number }) {
    if (!inscriptionId) throw new Error('inscriptionId required');
    const txid = `tx-${Math.random().toString(36).slice(2)}`;
    return {
      txid,
      vin: [{ txid: 'prev', vout: 0 }],
      vout: [{ value: 546, scriptPubKey: 'script' }],
      fee: 100,
      confirmations: 0
    };
  }
}

export async function createOrdinalsProviderFromEnv(): Promise<OrdinalsProvider> {
  const useLive = String(((globalThis as any).process?.env?.USE_LIVE_ORD_PROVIDER) || '').toLowerCase() === 'true';
  if (useLive) {
    const baseUrl = ((globalThis as any).process?.env?.ORD_PROVIDER_BASE_URL) || 'https://ord.example.com/api';
    return new OrdHttpProvider({ baseUrl });
  }
  const mod = await import('./OrdMockProvider');
  return new mod.OrdMockProvider();
}

