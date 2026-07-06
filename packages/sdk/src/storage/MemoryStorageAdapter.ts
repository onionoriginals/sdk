import { GetObjectResult, StorageAdapter } from './StorageAdapter.js';

type DomainPath = string;

// Shared across all instances by design: LifecycleManager constructs a fresh
// fallback MemoryStorageAdapter per publish, and published resources must
// remain retrievable through later instances. Use `MemoryStorageAdapter.clear()`
// for isolation between tests or tenants.
const globalStore: Map<DomainPath, Uint8Array> = new Map();

function key(domain: string, objectPath: string): string {
  const cleanPath = objectPath.replace(/^\/+/, '');
  // Encode both parts so the delimiter cannot appear inside either: with a
  // raw `${domain}::${path}` key, key('a::b','c') === key('a','b::c') and a
  // did:webvh domain containing ':' (encoded port) could collide with a path.
  return `${encodeURIComponent(domain)}::${encodeURIComponent(cleanPath)}`;
}

export class MemoryStorageAdapter implements StorageAdapter {
  putObject(domain: string, objectPath: string, content: Uint8Array | string): Promise<string> {
    // Copy on write: storing the caller's array would let later caller-side
    // mutation silently corrupt the "stored" bytes.
    // new Uint8Array(view) copies; .slice() would return a SHARED view when
    // the caller passes a Buffer (Buffer.prototype.slice overrides it).
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
    globalStore.set(key(domain, objectPath), data);
    return Promise.resolve(`mem://${domain}/${objectPath.replace(/^\/+/, '')}`);
  }

  getObject(domain: string, objectPath: string): Promise<GetObjectResult | null> {
    const stored = globalStore.get(key(domain, objectPath));
    if (!stored) return Promise.resolve(null);
    // Copy on read for the same reason as put.
    return Promise.resolve({ content: new Uint8Array(stored) });
  }

  exists(domain: string, objectPath: string): Promise<boolean> {
    return Promise.resolve(globalStore.has(key(domain, objectPath)));
  }

  /**
   * Enumerate stored object paths under a domain matching a prefix.
   *
   * Extra capability on this concrete class — deliberately NOT part of the
   * public StorageAdapter interface. The backing Map is fully enumerable, and
   * exposing that lets consumers (e.g. MigrationStorage/AuditLogger) discover
   * persisted keys natively instead of maintaining a shared mutable index
   * object, which was a cross-process read-modify-write race.
   *
   * Returned paths are the normalized paths as stored by putObject (leading
   * slashes stripped) and round-trip through getObject.
   */
  listObjects(domain: string, prefix: string): Promise<string[]> {
    const domainPrefix = `${encodeURIComponent(domain)}::`;
    const cleanPrefix = prefix.replace(/^\/+/, '');
    const results: string[] = [];
    for (const storedKey of globalStore.keys()) {
      if (!storedKey.startsWith(domainPrefix)) continue;
      const objectPath = decodeURIComponent(storedKey.slice(domainPrefix.length));
      if (objectPath.startsWith(cleanPrefix)) results.push(objectPath);
    }
    return Promise.resolve(results);
  }

  /** Remove every stored object (all instances share one store). */
  static clear(): void {
    globalStore.clear();
  }
}
