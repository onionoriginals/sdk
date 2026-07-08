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

  /**
   * OPTIONAL prefix enumeration hook (issue #329). Returns every stored path
   * under `domain` whose key starts with `prefix` (paths are the same bare key
   * strings passed to putObject/getObject).
   *
   * This is additive and non-breaking: adapters that omit it keep working.
   * The migration audit log (AuditLogger) prefers this native enumeration and
   * only falls back to a shared, single-process-safe `index.json` for opaque
   * custom adapters that implement neither `listObjects` nor a legacy `list`.
   * Implement it on custom adapters to make audit/checkpoint discovery
   * race-free across processes — each record already lives at a unique
   * immutable key, so enumeration needs no shared read-modify-write object.
   *
   * The shipped MemoryStorageAdapter and LocalStorageAdapter implement this.
   */
  listObjects?(domain: string, prefix: string): Promise<string[]>;
}

export interface LocalStorageAdapterOptions {
  baseDir: string;
  baseUrl?: string;
}

