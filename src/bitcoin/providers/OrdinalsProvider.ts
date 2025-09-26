import { OrdinalsClient } from '../OrdinalsClient';
import { withRetry } from '../../utils/retry';

export interface OrdinalsProvider {
  getSatInfo(satNumber: string): Promise<{ inscription_ids: string[] }>;
  resolveInscription(inscriptionId: string): Promise<{ id: string; sat: number; content_type: string; content_url: string }>;
  getMetadata(inscriptionId: string): Promise<any>;
  estimateFee(blocks?: number): Promise<number>;
}

export class OrdinalsClientProvider implements OrdinalsProvider {
  constructor(private client: OrdinalsClient, private options?: { retries?: number }) {}

  async getSatInfo(satNumber: string): Promise<{ inscription_ids: string[] }> {
    return withRetry(() => this.client.getSatInfo(satNumber), {
      maxRetries: this.options?.retries ?? 2,
      isRetriable: () => true
    });
  }

  async resolveInscription(inscriptionId: string): Promise<{ id: string; sat: number; content_type: string; content_url: string }> {
    return withRetry(async () => {
      const res = await this.client.getInscriptionById(inscriptionId);
      if (!res) throw new Error('Inscription not found');
      return {
        id: res.inscriptionId,
        sat: Number(res.satoshi || 0),
        content_type: res.contentType || 'application/octet-stream',
        content_url: `${''}` // content url is not available from the client here; upstream callers should already have it
      };
    }, { maxRetries: this.options?.retries ?? 2, isRetriable: () => true });
  }

  async getMetadata(inscriptionId: string): Promise<any> {
    return withRetry(() => this.client.getMetadata(inscriptionId), {
      maxRetries: this.options?.retries ?? 2,
      isRetriable: () => true
    });
  }

  async estimateFee(blocks?: number): Promise<number> {
    return withRetry(() => this.client.estimateFee(blocks), {
      maxRetries: this.options?.retries ?? 2,
      isRetriable: () => true
    });
  }
}

