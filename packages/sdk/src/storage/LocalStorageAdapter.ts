// Local adapter is optional in this environment; keeping implementation but avoid Node typings
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import * as fs from 'fs/promises';
import * as path from 'path';
import { GetObjectResult, LocalStorageAdapterOptions, StorageAdapter } from './StorageAdapter.js';

export class LocalStorageAdapter implements StorageAdapter {
  private baseDir: string;
  private baseUrl?: string;

  constructor(options: LocalStorageAdapterOptions) {
    this.baseDir = options.baseDir;
    this.baseUrl = options.baseUrl;
  }

  private sanitizeDomain(domain: string): string {
    const sanitized = domain.replace(/[^a-zA-Z0-9.-]/g, '_');
    // '.' and '-' survive sanitization, so a domain of '.' or '..' would make
    // the domain directory resolve to baseDir itself or its parent. Reject
    // dot-only segments outright.
    if (/^\.+$/.test(sanitized)) {
      throw new Error(`Invalid domain: resolves outside the storage directory: ${domain}`);
    }
    return sanitized;
  }

  private resolvePath(domain: string, objectPath: string): string {
    const safeDomain = this.sanitizeDomain(domain);
    const cleanPath = objectPath.replace(/^\/+/, '');
    const base = path.resolve(this.baseDir, safeDomain);
    // Defense in depth: the domain directory itself must be a strict child of
    // baseDir; '..' segments in a domain (which can derive from external data)
    // must not become a read/write primitive outside baseDir.
    const baseRelative = path.relative(path.resolve(this.baseDir), base);
    if (
      baseRelative === '' ||
      baseRelative === '..' ||
      baseRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(baseRelative)
    ) {
      throw new Error(`Invalid domain: resolves outside the storage directory: ${domain}`);
    }
    const fullPath = path.resolve(base, cleanPath);
    // Contain object paths inside the domain directory: '..' segments in a
    // path (which can derive from external data) must not become a read/write
    // primitive outside baseDir.
    const relative = path.relative(base, fullPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Invalid object path: resolves outside the storage directory: ${objectPath}`);
    }
    return fullPath;
  }

  private toUrl(domain: string, objectPath: string): string {
    const cleanPath = objectPath.replace(/^\/+/, '');
    if (this.baseUrl) {
      const trimmed = this.baseUrl.replace(/\/$/, '');
      // Use the same sanitized domain the file is physically stored under, so
      // the returned URL maps back to the actual object rather than a path the
      // server can't resolve.
      return `${trimmed}/${this.sanitizeDomain(domain)}/${cleanPath}`;
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

