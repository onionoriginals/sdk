export interface LinkedResource {
  id: string;
  type: string;
  contentType: string;
  content_url: string;
}

export interface Inscription {
  id: string;
  sat: number;
  content_type: string;
  content_url: string;
  number?: number;
  height?: number;
  timestamp?: number;
}

export interface ResourceInfo {
  id: string;
  type: string;
  contentType: string;
  createdAt?: string;
  updatedAt?: string;
  content_url: string;
}

export interface ResourceProvider {
  resolve(resourceId: string): Promise<LinkedResource>;
  resolveInscription(inscriptionId: string): Promise<Inscription>;
  resolveInfo(resourceId: string): Promise<ResourceInfo>;
  resolveCollection(did: string, options: { type?: string; limit?: number; offset?: number }): Promise<LinkedResource[]>;
  getSatInfo(satNumber: string): Promise<{ inscription_ids: string[] }>;
  getMetadata(inscriptionId: string): Promise<any>;
  getAllResources(options?: ResourceCrawlOptions): AsyncGenerator<LinkedResource[]>;
  getAllResourcesChronological(options?: ResourceCrawlOptions): AsyncGenerator<LinkedResource[]>;
  getInscriptionLocationsByAddress(address: string): Promise<InscriptionRefWithLocation[]>;
  getInscriptionByNumber(inscriptionNumber: number): Promise<Inscription>;
  getAddressOutputs(address: string): Promise<string[]>;
  getOutputDetails(outpoint: string): Promise<{ value: number; script_pubkey: string; spent: boolean; inscriptions: string[] }>;
}

export interface ResourceCrawlOptions {
  batchSize?: number;
  startFrom?: number;
  maxResources?: number;
  filter?: (resource: LinkedResource) => boolean;
}

export interface ResourceBatch {
  resources: LinkedResource[];
  nextCursor?: number;
  hasMore: boolean;
}

export interface InscriptionRefWithLocation {
  id: string;
  location: string;
}

