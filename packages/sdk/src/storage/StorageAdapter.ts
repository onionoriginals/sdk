export interface PutOptions {
  contentType?: string;
}

export interface GetObjectResult {
  content: Uint8Array;
  contentType?: string;
}

export interface StorageAdapter {
  // Writes content at a path under a logical domain root and returns a public URL.
  //
  // The returned URL is a locator this adapter can itself read back through
  // getObject/exists — it is NOT automatically the WebVH permanent hosted URL.
  // HostedAssets.publish() (packages/sdk/src/v3/hosted.ts) requires this to
  // equal exactly `https://${domain}/${path}` for a hosted publish to
  // succeed; an adapter whose locator uses another scheme (e.g.
  // MemoryStorageAdapter's `mem://`) or a different path shape is a valid
  // general-purpose StorageAdapter but cannot satisfy hosted publication
  // without wrapping (see HostedMemoryStorageAdapter, and
  // LocalStorageAdapterOptions.originDomain) — see issue #780.
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
  /**
   * Domain-origin mode for a single-tenant local host (issue #780). When set,
   * `baseUrl` is treated as exactly this domain's public origin: the returned
   * URL is `${baseUrl}/${path}` with no repeated domain path segment (the
   * default multi-tenant behavior appends `${domain}` under `baseUrl`, which
   * duplicates the domain when `baseUrl` already points at that domain's own
   * origin). Every `putObject`/`getObject`/`exists`/`listObjects` call must
   * then use this exact domain, or the call throws `STORAGE_DOMAIN_MISMATCH`
   * rather than silently mapping a different domain's files onto this
   * adapter's one advertised origin. Files are also stored directly under
   * `baseDir` with no per-domain subdirectory (unlike the default
   * multi-tenant layout), so the physical layout matches the URL: pointing
   * any static file server's document root at `baseDir` serves exactly the
   * paths this adapter advertises.
   */
  originDomain?: string;
}

