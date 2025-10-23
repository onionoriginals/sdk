import type { ResourceProviderLike } from '../BtcoDidResolver';
import { OrdinalsClient } from '../../bitcoin/OrdinalsClient';

export interface OrdinalsClientProviderConfig {
  baseUrl: string;
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  timeout?: number;
}

export class OrdinalsClientProviderAdapter implements ResourceProviderLike {
  private readonly config: OrdinalsClientProviderConfig;

  constructor(private client: OrdinalsClient, configOrBaseUrl: string | OrdinalsClientProviderConfig) {
    if (typeof configOrBaseUrl === 'string') {
      this.config = { baseUrl: configOrBaseUrl };
    } else {
      this.config = configOrBaseUrl;
    }
  }

  async getSatInfo(satNumber: string): Promise<{ inscription_ids: string[] }> {
    return this.client.getSatInfo(satNumber);
  }

  async resolveInscription(inscriptionId: string): Promise<{ id: string; sat: number; content_type: string; content_url: string }> {
    const base = (this.config.baseUrl || '').replace(/\/$/, '');
    if (!base) {
      throw new Error('OrdinalsClientProviderAdapter requires a baseUrl');
    }

    try {
      // Use configurable fetch function or default to global fetch
      const fetchFn = this.config.fetchFn || fetch;
      const timeout = this.config.timeout || 10000; // 10 second default timeout

      const fetchOptions: RequestInit = {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(timeout)
      };

      const res = await fetchFn(`${base}/inscription/${inscriptionId}`, fetchOptions);
      if (!res.ok) {
        // Log warning but don't throw - allow graceful degradation
        console.warn(`Failed to resolve inscription ${inscriptionId}: HTTP ${res.status}`);
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const info: any = await res.json();
      return {
        id: info.inscription_id || inscriptionId,
        sat: typeof info.sat === 'number' ? info.sat : Number(info.sat || 0),
        content_type: info.content_type || 'text/plain',
        content_url: info.content_url || `${base}/content/${inscriptionId}`
      };
    } catch (err: any) {
      // Log error for debugging but re-throw for caller to handle
      console.warn(`Failed to resolve inscription ${inscriptionId}:`, err.message || String(err));
      throw new Error(`Failed to resolve inscription: ${inscriptionId}`);
    }
  }

  async getMetadata(inscriptionId: string): Promise<any> {
    return this.client.getMetadata(inscriptionId);
  }
}

export default OrdinalsClientProviderAdapter;

