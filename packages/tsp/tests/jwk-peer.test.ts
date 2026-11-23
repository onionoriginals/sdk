import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveVidKeys } from '../src/vid/resolve.js';

describe('JsonWebKey2020 peer DID', () => {
  test('resolves signing and encryption keys from fixture', () => {
    const raw = readFileSync(join(import.meta.dir, 'fixtures', 'alice_jwk_did.json'), 'utf8');
    const doc = JSON.parse(raw) as Parameters<typeof resolveVidKeys>[0];
    const keys = resolveVidKeys(doc);
    expect(keys.id).toContain('did:web:');
    expect(keys.transport).toBe('tcp://127.0.0.1:13371');
    expect(keys.signingPublicKey.length).toBe(32);
    expect(keys.encryptionPublicKey.length).toBe(32);
  });
});