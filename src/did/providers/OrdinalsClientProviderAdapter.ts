import type { ResourceProviderLike } from '../BtcoDidResolver';
import { OrdinalsClient } from '../../bitcoin/OrdinalsClient';

export class OrdinalsClientProviderAdapter implements ResourceProviderLike {
  constructor(private client: OrdinalsClient, private baseUrl: string) {}

  async getSatInfo(satNumber: string): Promise<{ inscription_ids: string[] }> {
    return this.client.getSatInfo(satNumber);
  }

  async resolveInscription(inscriptionId: string): Promise<{ id: string; sat: number; content_type: string; content_url: string }> {
    const base = (this.baseUrl || '').replace(/\/$/, '');
    if (!base) {
      throw new Error('OrdinalsClientProviderAdapter requires a baseUrl');
    }

    const res = await fetch(`${base}/inscription/${inscriptionId}`, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) {
      throw new Error(`Failed to resolve inscription: ${inscriptionId}`);
    }
    const info: any = await res.json();
    return {
      id: info.inscription_id || inscriptionId,
      sat: typeof info.sat === 'number' ? info.sat : Number(info.sat || 0),
      content_type: info.content_type || 'text/plain',
      content_url: info.content_url || `${base}/content/${inscriptionId}`
    };
  }

  async getMetadata(inscriptionId: string): Promise<any> {
    return this.client.getMetadata(inscriptionId);
  }
}

export default OrdinalsClientProviderAdapter;

