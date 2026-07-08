import type { OrdinalsProvider } from '../../adapters/types.js';
import { OrdinalsClient } from '../OrdinalsClient.js';

export interface SignetProviderOptions {
  /** URL of the ord node (e.g. http://localhost:80 or https://signet.ordinals.com) */
  ordUrl: string;
  /** Optional Bitcoin Core RPC URL for wallet operations */
  bitcoinRpcUrl?: string;
  /**
   * Optional Bitcoin Core RPC credentials, sent as HTTP Basic auth.
   * Stock bitcoind requires RPC auth; fetch rejects URLs with embedded
   * credentials, so they must be supplied here instead of in bitcoinRpcUrl.
   */
  bitcoinRpcAuth?: { username: string; password: string };
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
  private readonly bitcoinRpcAuth?: { username: string; password: string };
  private readonly timeout: number;

  constructor(options: SignetProviderOptions) {
    this.ordUrl = options.ordUrl.replace(/\/$/, '');
    this.bitcoinRpcUrl = options.bitcoinRpcUrl;
    this.bitcoinRpcAuth = options.bitcoinRpcAuth;
    this.timeout = options.timeout ?? 10_000;
    this.client = new OrdinalsClient(this.ordUrl, 'signet');
  }

  private rpcHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.bitcoinRpcAuth) {
      const token = Buffer.from(
        `${this.bitcoinRpcAuth.username}:${this.bitcoinRpcAuth.password}`
      ).toString('base64');
      headers['Authorization'] = `Basic ${token}`;
    }
    return headers;
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
    // sendrawtransaction only accepts raw transaction hex. JSON.stringify-ing
    // an object here (issue #272) produced a guaranteed-invalid RPC parameter
    // that failed far from the cause — reject non-hex input up front instead.
    if (typeof txHexOrObj !== 'string' || !/^(?:[0-9a-fA-F]{2})+$/.test(txHexOrObj)) {
      throw new Error(
        'broadcastTransaction requires a raw transaction hex string (even-length hexadecimal)'
      );
    }
    const txHex = txHexOrObj;
    const res = await fetch(this.bitcoinRpcUrl, {
      method: 'POST',
      headers: this.rpcHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendrawtransaction',
        params: [txHex],
      }),
      signal: AbortSignal.timeout(this.timeout),
    });
    // bitcoind reports RPC-level errors with non-2xx statuses but still sends
    // a JSON body; an auth failure or proxy error may send HTML. Parse the
    // body when possible so the RPC error surfaces, and otherwise fail with
    // the HTTP status instead of an opaque JSON parse error.
    let data: { result?: unknown; error?: { message?: string } };
    try {
      data = await res.json() as { result?: unknown; error?: { message?: string } };
    } catch {
      throw new Error(`Bitcoin RPC request failed: HTTP ${res.status} ${res.statusText}`);
    }
    if (data.error) {
      throw new Error(`Bitcoin RPC error: ${data.error.message ?? JSON.stringify(data.error)}`);
    }
    if (!res.ok) {
      throw new Error(`Bitcoin RPC request failed: HTTP ${res.status} ${res.statusText}`);
    }
    // A response with neither result nor error must not become a "successful"
    // empty-string txid that downstream code records (issue #272).
    if (typeof data.result !== 'string' || data.result.length === 0) {
      throw new Error('Bitcoin RPC returned no txid for sendrawtransaction');
    }
    return data.result;
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
    // Fail loudly instead of fabricating a rate: the old fallback returned
    // `Math.max(1, blocks) * 2`, an invented value that *increased* with the
    // confirmation target (real fee curves go the other way) and silently
    // swallowed RPC errors — contradicting the fail-loud fee policy of the
    // other providers (OrdinalsClient/OrdHttpProvider/QuickNodeProvider).
    // Issue #351.
    if (!this.bitcoinRpcUrl) {
      throw new Error(
        'SignetProvider.estimateFee requires bitcoinRpcUrl to be configured. ' +
        'Configure a bitcoinRpcUrl (or a FeeOracleAdapter) instead of relying on a fabricated rate.'
      );
    }
    const res = await fetch(this.bitcoinRpcUrl, {
      method: 'POST',
      headers: this.rpcHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'estimatesmartfee',
        params: [blocks],
      }),
      signal: AbortSignal.timeout(this.timeout),
    });
    const data = await res.json() as { result?: { feerate?: number } };
    if (typeof data.result?.feerate !== 'number' || !(data.result.feerate > 0)) {
      throw new Error(
        'SignetProvider: estimatesmartfee returned no feerate. ' +
        'Configure a FeeOracleAdapter or retry with a higher block target.'
      );
    }
    // Convert BTC/kB to sat/vB
    return Math.ceil(data.result.feerate * 1e5);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
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

  // eslint-disable-next-line @typescript-eslint/require-await
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
