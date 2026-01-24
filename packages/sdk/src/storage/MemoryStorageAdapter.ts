import { GetObjectResult, StorageAdapter } from './StorageAdapter';

type DomainPath = string;

const globalStore: Map<DomainPath, Uint8Array> = new Map();

function key(domain: string, objectPath: string): string {
  const cleanPath = objectPath.replace(/^\/+/, '');
  return `${domain}::${cleanPath}`;
}

export class MemoryStorageAdapter implements StorageAdapter {
  putObject(domain: string, objectPath: string, content: Uint8Array | string): Promise<string> {
    const data = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    globalStore.set(key(domain, objectPath), data);
    return Promise.resolve(`mem://${domain}/${objectPath.replace(/^\/+/, '')}`);
  }

  getObject(domain: string, objectPath: string): Promise<GetObjectResult | null> {
    const stored = globalStore.get(key(domain, objectPath));
    if (!stored) return Promise.resolve(null);
    return Promise.resolve({ content: stored });
  }

  exists(domain: string, objectPath: string): Promise<boolean> {
    return Promise.resolve(globalStore.has(key(domain, objectPath)));
  }
}

