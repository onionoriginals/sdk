import type { OrdinalsProvider } from '../../../src/adapters/types';

export class MockOrdinalsProvider implements OrdinalsProvider {
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


