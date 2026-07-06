import type { ResourceProvider, LinkedResource, ResourceInfo, Inscription, ResourceCrawlOptions, InscriptionRefWithLocation } from './types.js';
import { StructuredError } from '../../utils/telemetry.js';

export interface OrdNodeProviderOptions {
  nodeUrl: string;
  timeout?: number;
  network?: 'mainnet' | 'testnet' | 'signet';
}

/**
 * Placeholder ResourceProvider for a self-hosted ord node.
 *
 * NOT IMPLEMENTED: this class performs no network I/O against the configured
 * node yet. It used to silently fabricate resolution results — getSatInfo
 * always returned { inscription_ids: [] }, resolveInscription returned
 * sat:0/text-plain, getOutputDetails returned value:0 with no inscriptions —
 * which made every did:btco look uninscribed while reporting success. Every
 * method now fails loudly (mirroring the OrdinalsClient hardening, #248)
 * until a real ord-node integration exists.
 */
export class OrdNodeProvider implements ResourceProvider {
  private readonly nodeUrl: string;
  private readonly timeout: number;
  private readonly network: 'mainnet' | 'testnet' | 'signet';

  constructor(options: OrdNodeProviderOptions) {
    this.nodeUrl = options.nodeUrl;
    this.timeout = options.timeout || 5000;
    this.network = options.network || 'mainnet';
  }

  private notImplemented(method: string, consequence: string): StructuredError {
    return new StructuredError(
      'ORD_NODE_NOT_IMPLEMENTED',
      `OrdNodeProvider.${method} is not implemented: ${consequence} Use a ResourceProvider backed by a real ord endpoint.`
    );
  }

  resolve(_resourceId: string): Promise<LinkedResource> {
    return Promise.reject(this.notImplemented('resolve', 'refusing to fabricate resource data.'));
  }

  resolveInscription(_inscriptionId: string): Promise<Inscription> {
    return Promise.reject(this.notImplemented('resolveInscription', 'refusing to fabricate inscription data (sat, content type).'));
  }

  resolveInfo(_resourceId: string): Promise<ResourceInfo> {
    return Promise.reject(this.notImplemented('resolveInfo', 'refusing to fabricate resource metadata.'));
  }

  resolveCollection(_did: string, _options: { type?: string; limit?: number; offset?: number } = {}): Promise<LinkedResource[]> {
    return Promise.reject(this.notImplemented('resolveCollection', 'refusing to report an empty collection as if resolved.'));
  }

  getSatInfo(_satNumber: string): Promise<{ inscription_ids: string[] }> {
    return Promise.reject(this.notImplemented('getSatInfo', 'refusing to report a satoshi as having no inscriptions.'));
  }

  getMetadata(_inscriptionId: string): Promise<unknown> {
    return Promise.reject(this.notImplemented('getMetadata', 'refusing to report missing metadata as if resolved.'));
  }

  // eslint-disable-next-line require-yield
  async *getAllResources(_options: ResourceCrawlOptions = {}): AsyncGenerator<LinkedResource[]> {
    throw this.notImplemented('getAllResources', 'refusing to report an empty resource set as if crawled.');
  }

  // eslint-disable-next-line require-yield
  async *getAllResourcesChronological(_options: ResourceCrawlOptions = {}): AsyncGenerator<LinkedResource[]> {
    throw this.notImplemented('getAllResourcesChronological', 'refusing to report an empty resource set as if crawled.');
  }

  getInscriptionLocationsByAddress(_address: string): Promise<InscriptionRefWithLocation[]> {
    return Promise.reject(this.notImplemented('getInscriptionLocationsByAddress', 'refusing to report an address as holding no inscriptions.'));
  }

  getInscriptionByNumber(_inscriptionNumber: number): Promise<Inscription> {
    return Promise.reject(this.notImplemented('getInscriptionByNumber', 'refusing to fabricate inscription data.'));
  }

  getAddressOutputs(_address: string): Promise<string[]> {
    return Promise.reject(this.notImplemented('getAddressOutputs', 'refusing to report an address as having no outputs.'));
  }

  getOutputDetails(_outpoint: string): Promise<{ value: number; script_pubkey: string; spent: boolean; inscriptions: string[] }> {
    return Promise.reject(this.notImplemented('getOutputDetails', 'refusing to fabricate output value and inscription list.'));
  }
}
