/**
 * MigrationStorage - Normalized persistence layer for migration-internal data
 * (checkpoints and audit records).
 *
 * The public StorageAdapter interface (and both shipped adapters,
 * MemoryStorageAdapter and LocalStorageAdapter) expose only
 * putObject/getObject/exists. CheckpointStorage and AuditLogger used to
 * duck-type storageAdapter.put/get/delete/list instead — methods no shipped
 * adapter has — so their typeof guards skipped silently and checkpoints/audit
 * records were NEVER persisted (after a crash, rollback found nothing and
 * quarantined).
 *
 * This module adapts BOTH shapes behind one tiny key/value-of-text API:
 *   - the canonical StorageAdapter (putObject/getObject) — preferred
 *   - legacy duck-typed adapters (put/get, optional delete/list) — still
 *     honored for backward compatibility with custom adapters written
 *     against the old behavior
 * without widening the public StorageAdapter interface.
 */

import { OriginalsConfig } from '../../types/index.js';

/**
 * Logical domain under which all migration-internal objects are stored.
 * Kept distinct from any real hosting domain so internal state never
 * collides with published asset content.
 */
export const MIGRATION_STORAGE_DOMAIN = 'originals-migration';

/**
 * Normalize the possible shapes a storage adapter may return
 * (GetObjectResult, Buffer/Uint8Array, or a raw string) to utf8 text.
 */
export function storedDataToString(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8');
  const content = (data as { content?: Buffer | Uint8Array | string }).content;
  if (typeof content === 'string') return content;
  if (content instanceof Uint8Array) return Buffer.from(content).toString('utf8');
  throw new Error('Unsupported storage adapter result shape');
}

interface CanonicalAdapterShape {
  putObject?: (
    domain: string,
    path: string,
    content: Uint8Array | string,
    options?: { contentType?: string }
  ) => Promise<string>;
  getObject?: (domain: string, path: string) => Promise<unknown>;
}

interface LegacyAdapterShape {
  put?: (key: string, data: Buffer | string, options?: { contentType?: string }) => Promise<unknown>;
  get?: (key: string) => Promise<unknown>;
  delete?: (key: string) => Promise<unknown>;
  list?: (prefix: string) => Promise<string[]>;
}

/**
 * Minimal text key/value view over whatever storage adapter is configured.
 */
export interface MigrationStorage {
  /** Write UTF-8 text at a key. Throws on adapter failure. */
  putText(key: string, text: string): Promise<void>;
  /** Read UTF-8 text at a key, or null when absent. */
  getText(key: string): Promise<string | null>;
  /**
   * Natively delete a key when the adapter supports it (legacy `delete`).
   * Returns false when no native delete exists — callers must then tombstone.
   */
  deleteNative(key: string): Promise<boolean>;
  /**
   * Natively list keys under a prefix when the adapter supports it (legacy
   * `list`). Returns null when unsupported — callers must then use an index.
   */
  listNative(prefix: string): Promise<string[] | null>;
}

/**
 * Resolve the configured storage adapter to a MigrationStorage, or null when
 * no adapter (or no usable adapter) is configured. The canonical
 * StorageAdapter interface takes precedence over legacy duck-typed methods.
 */
export function resolveMigrationStorage(config: OriginalsConfig): MigrationStorage | null {
  const adapter = (config as { storageAdapter?: unknown }).storageAdapter;
  if (!adapter || typeof adapter !== 'object') return null;

  const canonical = adapter as CanonicalAdapterShape;
  const legacy = adapter as LegacyAdapterShape;

  const hasCanonical =
    typeof canonical.putObject === 'function' && typeof canonical.getObject === 'function';
  const hasLegacy = typeof legacy.put === 'function' && typeof legacy.get === 'function';

  if (!hasCanonical && !hasLegacy) return null;

  return {
    async putText(key: string, text: string): Promise<void> {
      if (hasCanonical) {
        await canonical.putObject!(MIGRATION_STORAGE_DOMAIN, key, text, {
          contentType: 'application/json'
        });
        return;
      }
      await legacy.put!(key, Buffer.from(text, 'utf8'), { contentType: 'application/json' });
    },

    async getText(key: string): Promise<string | null> {
      const data = hasCanonical
        ? await canonical.getObject!(MIGRATION_STORAGE_DOMAIN, key)
        : await legacy.get!(key);
      if (data === null || data === undefined) return null;
      return storedDataToString(data);
    },

    async deleteNative(key: string): Promise<boolean> {
      // Hybrid adapters (canonical putObject/getObject PLUS a legacy delete)
      // write and read through the canonical MIGRATION_STORAGE_DOMAIN keys,
      // so the legacy raw-key delete would miss the canonical object: the
      // data would survive, no tombstone would be written, and a fresh
      // reader could "recover" deleted state. Report no native delete so
      // callers take the tombstone path — the reliable one for canonical
      // storage.
      if (hasCanonical) return false;
      if (typeof legacy.delete === 'function') {
        await legacy.delete(key);
        return true;
      }
      return false;
    },

    async listNative(prefix: string): Promise<string[] | null> {
      if (typeof legacy.list === 'function') {
        return await legacy.list(prefix);
      }
      return null;
    }
  };
}
