import type { ResourceProvider, LinkedResource, ResourceInfo, Inscription, ResourceCrawlOptions } from './types';

export interface OrdNodeProviderOptions {
  nodeUrl: string;
  timeout?: number;
  network?: 'mainnet' | 'testnet' | 'signet';
}

export class OrdNodeProvider implements ResourceProvider {
  private readonly nodeUrl: string;
  private readonly timeout: number;
  private readonly network: 'mainnet' | 'testnet' | 'signet';

  constructor(options: OrdNodeProviderOptions) {
    this.nodeUrl = options.nodeUrl;
    this.timeout = options.timeout || 5000;
    this.network = options.network || 'mainnet';
  }

  async resolve(resourceId: string): Promise<LinkedResource> {
    return {
      id: resourceId,
      type: 'Unknown',
      contentType: 'application/octet-stream',
      content_url: `${this.nodeUrl}/content/${resourceId}`
    };
  }

  async resolveInscription(inscriptionId: string): Promise<Inscription> {
    return {
      id: inscriptionId,
      sat: 0,
      content_type: 'text/plain',
      content_url: `${this.nodeUrl}/content/${inscriptionId}`
    };
  }

  async resolveInfo(resourceId: string): Promise<ResourceInfo> {
    return {
      id: resourceId,
      type: 'Unknown',
      contentType: 'application/octet-stream',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      content_url: `${this.nodeUrl}/content/${resourceId}`
    };
  }

  async resolveCollection(did: string, _options: { type?: string; limit?: number; offset?: number } = {}): Promise<LinkedResource[]> {
    return [];
  }

  async getSatInfo(_satNumber: string): Promise<{ inscription_ids: string[] }> {
    return { inscription_ids: [] };
  }

  async getMetadata(_inscriptionId: string): Promise<any> {
    return null;
  }

  async *getAllResources(_options: ResourceCrawlOptions = {}): AsyncGenerator<LinkedResource[]> {
    // no-op generator yields nothing
    return;
  }

  async *getAllResourcesChronological(_options: ResourceCrawlOptions = {}): AsyncGenerator<LinkedResource[]> {
    // no-op generator yields nothing
    return;
  }

  async getInscriptionLocationsByAddress(_address: string): Promise<{ id: string; location: string }[]> {
    return [];
  }

  async getInscriptionByNumber(_inscriptionNumber: number): Promise<Inscription> {
    return {
      id: '0',
      sat: 0,
      content_type: 'text/plain',
      content_url: `${this.nodeUrl}/content/0`
    };
  }

  async getAddressOutputs(_address: string): Promise<string[]> {
    return [];
  }

  async getOutputDetails(_outpoint: string): Promise<{ value: number; script_pubkey: string; spent: boolean; inscriptions: string[] }> {
    return { value: 0, script_pubkey: '', spent: false, inscriptions: [] };
  }
}

