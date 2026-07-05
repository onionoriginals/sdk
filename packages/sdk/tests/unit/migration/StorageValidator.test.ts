/**
 * StorageValidator unit tests (issue #318)
 *
 * The validator used to duck-type `storageAdapter.putChunk` — a method that
 * NO shipped StorageAdapter has (the interface exposes only
 * putObject/getObject/exists). That produced two wrong outcomes:
 *   1. Shipped adapters (Memory/Local) got a bogus NO_CHUNKED_UPLOAD_SUPPORT
 *      warning in partial mode even though they persist objects fine.
 *   2. An adapter exposing only the phantom `putChunk` (but unable to persist
 *      anything the migration system uses) passed silently.
 *
 * The fix validates against real capabilities via resolveMigrationStorage
 * (canonical putObject/getObject, or legacy put/get), consistent with the
 * CheckpointStorage/AuditLogger fix on this branch.
 */

import { describe, test, expect } from 'bun:test';
import { StorageValidator } from '../../../src/migration/validation/StorageValidator';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import type { OriginalsConfig } from '../../../src/types';

const baseConfig: OriginalsConfig = {
  network: 'regtest',
  webvhNetwork: 'magby',
  defaultKeyType: 'Ed25519',
  enableLogging: false,
};

const baseOptions = {
  sourceDid: 'did:peer:z6MkValid123',
  targetLayer: 'webvh' as const,
  domain: 'example.com',
};

const partialMode = { chunkSize: 1024, resumable: true };

describe('StorageValidator (issue #318: phantom putChunk probe)', () => {
  test('[bug repro] shipped MemoryStorageAdapter passes partial mode with no phantom-capability warning', async () => {
    const validator = new StorageValidator({
      ...baseConfig,
      storageAdapter: new MemoryStorageAdapter(),
    });

    const result = await validator.validate({ ...baseOptions, partialMode });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    // The shipped adapter persists objects via putObject/getObject — the
    // validator must not report a missing capability that never existed on
    // the StorageAdapter interface.
    const warnCodes = result.warnings.map(w => w.code);
    expect(warnCodes).not.toContain('NO_CHUNKED_UPLOAD_SUPPORT');
  });

  test('[bug repro] adapter with only the phantom putChunk fails closed instead of passing silently', async () => {
    const validator = new StorageValidator({
      ...baseConfig,
      storageAdapter: {
        // Phantom capability the old probe keyed off — but the adapter has
        // none of the methods migration storage actually uses.
        putChunk: async () => {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });

    const result = await validator.validate({ ...baseOptions, partialMode });

    expect(result.valid).toBe(false);
    const errorCodes = result.errors.map(e => e.code);
    expect(errorCodes).toContain('STORAGE_ADAPTER_INCOMPATIBLE');
  });

  test('[fail-closed] incompatible adapter is an error even outside partial mode', async () => {
    const validator = new StorageValidator({
      ...baseConfig,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      storageAdapter: { somethingElse: true } as any,
    });

    const result = await validator.validate({ ...baseOptions });

    expect(result.valid).toBe(false);
    expect(result.errors.map(e => e.code)).toContain('STORAGE_ADAPTER_INCOMPATIBLE');
  });

  test('[fail-closed] resumable partial mode without any storage adapter is an error', async () => {
    const validator = new StorageValidator({ ...baseConfig, storageAdapter: undefined });

    const result = await validator.validate({ ...baseOptions, partialMode });

    expect(result.valid).toBe(false);
    expect(result.errors.map(e => e.code)).toContain('PARTIAL_MODE_STORAGE_REQUIRED');
    // The general no-adapter warning still surfaces alongside the error.
    expect(result.warnings.map(w => w.code)).toContain('NO_STORAGE_ADAPTER');
  });

  test('[boundary] non-resumable partial mode without an adapter stays a warning (in-memory chunking is viable)', async () => {
    const validator = new StorageValidator({ ...baseConfig, storageAdapter: undefined });

    const result = await validator.validate({
      ...baseOptions,
      partialMode: { chunkSize: 1024, resumable: false },
    });

    expect(result.valid).toBe(true);
    expect(result.warnings.map(w => w.code)).toContain('NO_STORAGE_ADAPTER');
  });

  test('[compat] legacy put/get adapter is accepted for partial mode (matches resolveMigrationStorage)', async () => {
    const validator = new StorageValidator({
      ...baseConfig,
      storageAdapter: {
        get: async () => null,
        put: async () => {},
        delete: async () => {},
        list: async () => [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });

    const result = await validator.validate({ ...baseOptions, partialMode });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings.map(w => w.code)).not.toContain('NO_CHUNKED_UPLOAD_SUPPORT');
  });

  test('[regression] no adapter and no partial mode remains a warning, not an error', async () => {
    const validator = new StorageValidator({ ...baseConfig, storageAdapter: undefined });

    const result = await validator.validate({ ...baseOptions });

    expect(result.valid).toBe(true);
    expect(result.warnings.map(w => w.code)).toContain('NO_STORAGE_ADAPTER');
  });
});
