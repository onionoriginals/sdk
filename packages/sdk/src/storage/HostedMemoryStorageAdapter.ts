import { GetObjectResult, PutOptions, StorageAdapter } from './StorageAdapter.js';

/**
 * In-memory `StorageAdapter` whose `putObject()` asserts the canonical
 * `https://${domain}/${path}` URL that `HostedAssets.publish()` requires,
 * instead of `MemoryStorageAdapter`'s opaque `mem://` locator (see #780:
 * neither shipped adapter's returned URL matched the permanent hosted path,
 * so hosted publication could never succeed with either of them out of the
 * box). Use this adapter for tests and local development that exercise
 * `publishToWeb`/`prepareWebPublication` end-to-end; `MemoryStorageAdapter`
 * remains correct for every other in-memory storage use where its `mem://`
 * locator is not compared against a public URL.
 *
 * Storage is private to each instance (unlike `MemoryStorageAdapter`'s
 * intentionally shared global store) — hosted-publication tests already
 * reuse one adapter instance across the publishing and resolving SDK, so no
 * implicit cross-instance sharing is needed here.
 */
export class HostedMemoryStorageAdapter implements StorageAdapter {
  private readonly store = new Map<string, { content: Uint8Array; contentType?: string }>();

  private key(domain: string, objectPath: string): string {
    const cleanPath = objectPath.replace(/^\/+/, '');
    return `${encodeURIComponent(domain)}::${encodeURIComponent(cleanPath)}`;
  }

  putObject(domain: string, objectPath: string, content: Uint8Array | string, options?: PutOptions): Promise<string> {
    const cleanPath = objectPath.replace(/^\/+/, '');
    // Copy on write, matching MemoryStorageAdapter: storing the caller's
    // array would let later caller-side mutation silently corrupt the bytes.
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
    this.store.set(this.key(domain, objectPath), { content: data, contentType: options?.contentType });
    return Promise.resolve(`https://${domain}/${cleanPath}`);
  }

  getObject(domain: string, objectPath: string): Promise<GetObjectResult | null> {
    const stored = this.store.get(this.key(domain, objectPath));
    if (!stored) return Promise.resolve(null);
    return Promise.resolve({ content: new Uint8Array(stored.content), contentType: stored.contentType });
  }

  exists(domain: string, objectPath: string): Promise<boolean> {
    return Promise.resolve(this.store.has(this.key(domain, objectPath)));
  }

  /** Enumerate stored object paths under a domain matching a prefix; mirrors MemoryStorageAdapter.listObjects. */
  listObjects(domain: string, prefix: string): Promise<string[]> {
    const domainPrefix = `${encodeURIComponent(domain)}::`;
    const cleanPrefix = prefix.replace(/^\/+/, '');
    const results: string[] = [];
    for (const storedKey of this.store.keys()) {
      if (!storedKey.startsWith(domainPrefix)) continue;
      const objectPath = decodeURIComponent(storedKey.slice(domainPrefix.length));
      if (objectPath.startsWith(cleanPrefix)) results.push(objectPath);
    }
    return Promise.resolve(results);
  }

  /** Remove every stored object from this instance. */
  clear(): void {
    this.store.clear();
  }
}
