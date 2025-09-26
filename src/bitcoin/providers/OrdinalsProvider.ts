import { OrdinalsClient } from '../OrdinalsClient';
import { withRetry } from '../../utils/retry';

export interface OrdinalsProvider {
  getSatInfo(satNumber: string): Promise<{ inscription_ids: string[] }>;
  resolveInscription(inscriptionId: string): Promise<{ id: string; sat: number; content_type: string; content_url: string }>;
  getMetadata(inscriptionId: string): Promise<any>;
  estimateFee(blocks?: number): Promise<number>;
}

export class OrdinalsClientProvider implements OrdinalsProvider {
  constructor(private client: OrdinalsClient, private options?: { retries?: number; baseUrl?: string }) {}

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
      if (!res.satoshi) throw new Error('Inscription missing satoshi');
      const sat = Number(String(res.satoshi));
      if (Number.isNaN(sat)) throw new Error('Invalid satoshi value');
      if (!res.contentType) throw new Error('Inscription missing contentType');
      const base = (this.options?.baseUrl || '').replace(/\/$/, '');
      if (!base) throw new Error('baseUrl is required to construct content_url');
      const id = res.inscriptionId;
      const content_url = `${base}/content/${id}`;
      return {
        id,
        sat,
        content_type: res.contentType,
        content_url
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

