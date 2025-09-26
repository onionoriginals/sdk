import type { StorageAdapter, StorageGetResult, StoragePutOptions } from '../types';

export class MemoryStorageAdapter implements StorageAdapter {
  private readonly keyToObject: Map<string, { content: Buffer; contentType: string }> = new Map();

  async put(objectKey: string, data: Buffer | string, options: StoragePutOptions = {}): Promise<string> {
    const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const contentType = options.contentType || 'application/octet-stream';
    this.keyToObject.set(objectKey, { content, contentType });
    return `memory://${objectKey}`;
  }

  async get(objectKey: string): Promise<StorageGetResult | null> {
    const entry = this.keyToObject.get(objectKey);
    if (!entry) return null;
    return { content: Buffer.from(entry.content), contentType: entry.contentType };
  }

  async delete(objectKey: string): Promise<boolean> {
    return this.keyToObject.delete(objectKey);
  }
}

