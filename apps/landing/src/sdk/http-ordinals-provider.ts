/**
 * SDK OrdinalsProvider backed by this origin's /api/btc/* QuickNode proxies.
 *
 * The SDK's sat-selected inscribe path (inscribe-on-sat.ts) uses ONLY
 * getFirstSatOfOutput, estimateFee and broadcastTransaction; the commit/reveal
 * are built and self-signed locally (the reveal with an ephemeral key). Every
 * other OrdinalsProvider method therefore rejects by design — mirroring
 * QuickNodeProvider's "does not build/sign" contract — so a mislabeled read can
 * never silently fabricate on-chain data in the browser.
 */
import type { OrdinalsProvider } from '@originals/sdk';

export class HttpOrdinalsProvider implements OrdinalsProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts?: { baseUrl?: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts?.baseUrl ?? '';
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = '';
      try { detail = JSON.stringify(await res.json()); } catch { /* ignore */ }
      throw new Error(`HttpOrdinalsProvider ${path} failed: ${res.status} ${detail}`);
    }
    return (await res.json()) as T;
  }

  async getFirstSatOfOutput(outpoint: { txid: string; vout: number }): Promise<string> {
    const { satoshi } = await this.post<{ satoshi: string }>('/api/btc/sat', outpoint);
    return satoshi;
  }

  async estimateFee(blocks = 1): Promise<number> {
    const { feeRate } = await this.post<{ feeRate: number }>('/api/btc/fee', { blocks });
    return feeRate;
  }

  async broadcastTransaction(txHexOrObj: unknown): Promise<string> {
    if (typeof txHexOrObj !== 'string') {
      throw new Error('HttpOrdinalsProvider.broadcastTransaction requires raw tx hex');
    }
    const { txid } = await this.post<{ txid: string }>('/api/btc/broadcast', { txHex: txHexOrObj });
    return txid;
  }

  // --- Not implemented (the sat-selected inscribe path never calls these). ---
  getInscriptionById(): Promise<never> {
    return Promise.reject(new Error('HttpOrdinalsProvider.getInscriptionById is not implemented in the browser demo.'));
  }
  getInscriptionsBySatoshi(): Promise<never> {
    return Promise.reject(new Error('HttpOrdinalsProvider.getInscriptionsBySatoshi is not implemented in the browser demo.'));
  }
  getTransactionStatus(): Promise<never> {
    return Promise.reject(new Error('HttpOrdinalsProvider.getTransactionStatus is not implemented in the browser demo.'));
  }
  createInscription(): Promise<never> {
    return Promise.reject(new Error('HttpOrdinalsProvider.createInscription is not implemented: the commit/reveal are built and signed locally, then broadcast via broadcastTransaction.'));
  }
  transferInscription(): Promise<never> {
    return Promise.reject(new Error('HttpOrdinalsProvider.transferInscription is not implemented in the browser demo.'));
  }
}
