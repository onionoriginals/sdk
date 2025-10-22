export interface PutOptions {
  contentType?: string;
}

export interface GetObjectResult {
  content: Uint8Array;
  contentType?: string;
}

export interface StorageAdapter {
  // Writes content at a path under a logical domain root and returns a public URL
  putObject(domain: string, path: string, content: Uint8Array | string, options?: PutOptions): Promise<string>;

  // Reads content from a path under a domain root
  getObject(domain: string, path: string): Promise<GetObjectResult | null>;

  // Checks whether a path exists
  exists(domain: string, path: string): Promise<boolean>;
}

export interface LocalStorageAdapterOptions {
  baseDir: string;
  baseUrl?: string;
}

