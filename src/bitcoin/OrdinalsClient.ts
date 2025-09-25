import { OrdinalsInscription, BitcoinTransaction } from '../types';

export class OrdinalsClient {
  constructor(
    private rpcUrl: string,
    private network: 'mainnet' | 'testnet' | 'regtest'
  ) {}

  async getInscriptionById(id: string): Promise<OrdinalsInscription | null> {
    return {
      satoshi: '123',
      inscriptionId: id,
      content: Buffer.from(''),
      contentType: 'text/plain',
      txid: 'txid',
      vout: 0
    };
  }

  async getInscriptionsBySatoshi(satoshi: string): Promise<OrdinalsInscription[]> {
    return [
      {
        satoshi,
        inscriptionId: 'insc-' + satoshi,
        content: Buffer.from(''),
        contentType: 'text/plain',
        txid: 'txid',
        vout: 0
      }
    ];
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
    // Simulate that a satoshi may have zero or one inscription id linked
    const has = Boolean(satoshi && satoshi !== '0');
    return { inscription_ids: has ? [`insc-${satoshi}`] : [] };
  }

  async resolveInscription(identifier: string): Promise<OrdinalsInscription | null> {
    // Accept either an inscription id or a satoshi number and resolve to an inscription
    if (!identifier) return null;
    const isInscId = identifier.startsWith('insc-');
    const satoshi = isInscId ? identifier.replace(/^insc-/, '') : identifier;
    return {
      satoshi,
      inscriptionId: `insc-${satoshi}`,
      content: Buffer.from(''),
      contentType: 'text/plain',
      txid: 'txid',
      vout: 0
    };
  }

  async getMetadata(inscriptionId: string): Promise<Record<string, unknown> | null> {
    // For tests we simply return a deterministic object keyed by the id
    if (!inscriptionId) return null;
    return { id: inscriptionId, type: 'BTCO.DID', network: this.network } as Record<string, unknown>;
  }
}


