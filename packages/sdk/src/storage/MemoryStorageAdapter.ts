import { GetObjectResult, StorageAdapter } from './StorageAdapter.js';

type DomainPath = string;

// Shared across all instances by design: LifecycleManager constructs a fresh
// fallback MemoryStorageAdapter per publish, and published resources must
// remain retrievable through later instances. Use `MemoryStorageAdapter.clear()`
// for isolation between tests or tenants.
const globalStore: Map<DomainPath, Uint8Array> = new Map();

function key(domain: string, objectPath: string): string {
  const cleanPath = objectPath.replace(/^\/+/, '');
  return `${domain}::${cleanPath}`;
}

export class MemoryStorageAdapter implements StorageAdapter {
  putObject(domain: string, objectPath: string, content: Uint8Array | string): Promise<string> {
    // Copy on write: storing the caller's array would let later caller-side
    // mutation silently corrupt the "stored" bytes.
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content.slice();
    globalStore.set(key(domain, objectPath), data);
    return Promise.resolve(`mem://${domain}/${objectPath.replace(/^\/+/, '')}`);
  }

  getObject(domain: string, objectPath: string): Promise<GetObjectResult | null> {
    const stored = globalStore.get(key(domain, objectPath));
    if (!stored) return Promise.resolve(null);
    // Copy on read for the same reason as put.
    return Promise.resolve({ content: stored.slice() });
  }

  exists(domain: string, objectPath: string): Promise<boolean> {
    return Promise.resolve(globalStore.has(key(domain, objectPath)));
  }

  /** Remove every stored object (all instances share one store). */
  static clear(): void {
    globalStore.clear();
  }
}
