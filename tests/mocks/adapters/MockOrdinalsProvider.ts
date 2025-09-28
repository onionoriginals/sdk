import type { OrdinalsProvider } from '../../../src/adapters/types';

export class MockOrdinalsProvider implements OrdinalsProvider {
  async createInscription(params: { data: Buffer; contentType: string; feeRate?: number }) {
    return {
      inscriptionId: 'insc-mock',
      revealTxId: 'tx-reveal-mock',
      commitTxId: 'tx-commit-mock',
      satoshi: '123',
      txid: 'tx-mock',
      vout: 0,
      blockHeight: 1,
      content: params.data,
      contentType: params.contentType,
      feeRate: params.feeRate
    };
  }

  async getInscriptionById(id: string) {
    if (!id) return null;
    return {
      inscriptionId: id,
      content: Buffer.from(''),
      contentType: 'text/plain',
      txid: 'tx-mock',
      vout: 0,
      satoshi: '123'
    };
  }

  async transferInscription(
    inscriptionId: string,
    toAddress: string,
    options?: { feeRate?: number }
  ): Promise<{
    txid: string;
    vin: Array<{ txid: string; vout: number }>;
    vout: Array<{ value: number; scriptPubKey: string; address?: string }>;
    fee: number;
    blockHeight?: number;
    confirmations?: number;
    satoshi?: string;
  }> {
    if (!inscriptionId) {
      throw new Error('inscriptionId required');
    }
    return {
      txid: 'tx-transfer-mock',
      vin: [{ txid: 'tx-prev', vout: 0 }],
      vout: [{ value: 10_000, scriptPubKey: 'script', address: toAddress }],
      fee: options?.feeRate ? Math.round(options.feeRate) : 100,
      blockHeight: 2,
      confirmations: 0,
      satoshi: '123'
    };
  }

  async getInscriptionsBySatoshi(satoshi: string) {
    if (!satoshi) return [];
    return [{ inscriptionId: 'insc-mock' }];
  }

  async broadcastTransaction(_txHexOrObj: unknown): Promise<string> {
    return 'txid-mock';
  }

  async getTransactionStatus(_txid: string): Promise<{ confirmed: boolean; blockHeight?: number; confirmations?: number }> {
    return { confirmed: false };
  }

  async estimateFee(blocks: number = 1): Promise<number> {
    return 10 * Math.max(1, blocks);
  }
}


