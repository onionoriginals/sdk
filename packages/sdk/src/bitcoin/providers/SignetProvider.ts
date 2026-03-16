import type { OrdinalsProvider } from '../../adapters/types';
import { OrdinalsClient } from '../OrdinalsClient';

export interface SignetProviderOptions {
  /** URL of the ord node (e.g. http://localhost:80 or https://signet.ordinals.com) */
  ordUrl: string;
  /** Optional Bitcoin Core RPC URL for wallet operations */
  bitcoinRpcUrl?: string;
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number;
}

/**
 * OrdinalsProvider implementation that connects to a real ord node on signet.
 *
 * Read operations (getInscriptionById, getInscriptionsBySatoshi, estimateFee,
 * getTransactionStatus) are fully supported via the ord HTTP API.
 *
 * Write operations (createInscription, transferInscription) require a funded
 * signet wallet and `ord wallet` CLI access. These methods throw with
 * instructions if bitcoinRpcUrl is not configured.
 */
export class SignetProvider implements OrdinalsProvider {
  private readonly client: OrdinalsClient;
  private readonly ordUrl: string;
  private readonly bitcoinRpcUrl?: string;
  private readonly timeout: number;

  constructor(options: SignetProviderOptions) {
    this.ordUrl = options.ordUrl.replace(/\/$/, '');
    this.bitcoinRpcUrl = options.bitcoinRpcUrl;
    this.timeout = options.timeout ?? 10_000;
    this.client = new OrdinalsClient(this.ordUrl, 'signet');
  }

  async getInscriptionById(id: string) {
    const result = await this.client.getInscriptionById(id);
    if (!result) return null;
    return {
      inscriptionId: result.inscriptionId,
      content: result.content,
      contentType: result.contentType,
      txid: result.txid,
      vout: result.vout,
      satoshi: result.satoshi,
      blockHeight: result.blockHeight,
    };
  }

  async getInscriptionsBySatoshi(satoshi: string) {
    const results = await this.client.getInscriptionsBySatoshi(satoshi);
    return results.map((r) => ({ inscriptionId: r.inscriptionId }));
  }

  async broadcastTransaction(txHexOrObj: unknown): Promise<string> {
    if (!this.bitcoinRpcUrl) {
      throw new Error(
        'broadcastTransaction requires bitcoinRpcUrl. Configure SignetProvider with a Bitcoin Core RPC URL.'
      );
    }
    const txHex = typeof txHexOrObj === 'string' ? txHexOrObj : JSON.stringify(txHexOrObj);
    const res = await fetch(this.bitcoinRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendrawtransaction',
        params: [txHex],
      }),
      signal: AbortSignal.timeout(this.timeout),
    });
    const data = await res.json() as { result?: string; error?: { message: string } };
    if (data.error) throw new Error(`Bitcoin RPC error: ${data.error.message}`);
    return data.result ?? '';
  }

  async getTransactionStatus(txid: string) {
    // Use ord's /tx/<txid> endpoint
    const url = `${this.ordUrl}/tx/${txid}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) {
      return { confirmed: false };
    }
    const data = await res.json() as Record<string, unknown>;
    return {
      confirmed: Boolean(data.confirmed ?? data.block_height),
      blockHeight: typeof data.block_height === 'number' ? data.block_height : undefined,
      confirmations: typeof data.confirmations === 'number' ? data.confirmations : undefined,
    };
  }

  async estimateFee(blocks: number = 1): Promise<number> {
    if (this.bitcoinRpcUrl) {
      try {
        const res = await fetch(this.bitcoinRpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'estimatesmartfee',
            params: [blocks],
          }),
          signal: AbortSignal.timeout(this.timeout),
        });
        const data = await res.json() as { result?: { feerate?: number } };
        if (data.result?.feerate) {
          // Convert BTC/kB to sat/vB
          return Math.ceil(data.result.feerate * 1e5);
        }
      } catch {
        // Fall through to default
      }
    }
    // Signet has low fees; return a sensible default
    return Math.max(1, blocks) * 2;
  }

  async createInscription(_params: {
    data: Buffer;
    contentType: string;
    feeRate?: number;
  }): Promise<never> {
    if (!this.bitcoinRpcUrl) {
      throw new Error(
        'createInscription requires a funded signet wallet. ' +
        'Configure SignetProvider with bitcoinRpcUrl and ensure `ord wallet` is set up. ' +
        'See docs/SIGNET_SETUP.md for instructions.'
      );
    }
    throw new Error(
      'Programmatic inscription creation is not yet supported. ' +
      'Use the `ord wallet inscribe` CLI command to create inscriptions on signet.'
    );
  }

  async transferInscription(
    _inscriptionId: string,
    _toAddress: string,
    _options?: { feeRate?: number }
  ): Promise<never> {
    if (!this.bitcoinRpcUrl) {
      throw new Error(
        'transferInscription requires a funded signet wallet. ' +
        'Configure SignetProvider with bitcoinRpcUrl and ensure `ord wallet` is set up. ' +
        'See docs/SIGNET_SETUP.md for instructions.'
      );
    }
    throw new Error(
      'Programmatic inscription transfer is not yet supported. ' +
      'Use the `ord wallet send` CLI command to transfer inscriptions on signet.'
    );
  }
}
