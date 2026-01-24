// Local adapter is optional in this environment; keeping implementation but avoid Node typings
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import * as fs from 'fs/promises';
import * as path from 'path';
import { GetObjectResult, LocalStorageAdapterOptions, StorageAdapter } from './StorageAdapter';

export class LocalStorageAdapter implements StorageAdapter {
  private baseDir: string;
  private baseUrl?: string;

  constructor(options: LocalStorageAdapterOptions) {
    this.baseDir = options.baseDir;
    this.baseUrl = options.baseUrl;
  }

  private resolvePath(domain: string, objectPath: string): string {
    const safeDomain = domain.replace(/[^a-zA-Z0-9.-]/g, '_');
    const cleanPath = objectPath.replace(/^\/+/, '');
    return path.join(this.baseDir, safeDomain, cleanPath);
  }

  private toUrl(domain: string, objectPath: string): string {
    const cleanPath = objectPath.replace(/^\/+/, '');
    if (this.baseUrl) {
      const trimmed = this.baseUrl.replace(/\/$/, '');
      return `${trimmed}/${domain}/${cleanPath}`;
    }
    return `file://${this.resolvePath(domain, cleanPath)}`;
  }

  async putObject(domain: string, objectPath: string, content: Uint8Array | string): Promise<string> {
    const fullPath = this.resolvePath(domain, objectPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    const data = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content);
    await fs.writeFile(fullPath, data);
    return this.toUrl(domain, objectPath);
  }

  async getObject(domain: string, objectPath: string): Promise<GetObjectResult | null> {
    const fullPath = this.resolvePath(domain, objectPath);
    try {
      const content = await fs.readFile(fullPath);
      return { content: new Uint8Array(content) };
    } catch (e: unknown) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      const error = e as any;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (error && error.code === 'ENOENT') return null;
      throw e;
    }
  }

  async exists(domain: string, objectPath: string): Promise<boolean> {
    const fullPath = this.resolvePath(domain, objectPath);
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }
}

