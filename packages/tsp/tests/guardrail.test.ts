import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildMultikeyDidDocument } from '../src/vid/resolve.js';

const srcRoot = join(import.meta.dir, '..', 'src');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('did document guardrail', () => {
  test('buildMultikeyDidDocument never emits JsonWebKey2020', () => {
    const doc = buildMultikeyDidDocument({
      id: 'did:example:alice',
      transport: 'tsp://',
      signingPublicKey: new Uint8Array(32).fill(1),
      encryptionPublicKey: new Uint8Array(32).fill(2),
    });
    expect(JSON.stringify(doc)).not.toContain('JsonWebKey2020');
    for (const vm of (doc as { verificationMethod: { type: string }[] }).verificationMethod) {
      expect(vm.type).toBe('Multikey');
    }
  });

  test('our VM builders in src avoid JsonWebKey2020', () => {
    for (const file of listTsFiles(srcRoot)) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('verificationMethod') && !text.includes('buildMultikeyDidDocument')) continue;
      if (file.endsWith('resolve.ts')) {
        expect(text).toContain('buildMultikeyDidDocument');
        expect(text).not.toMatch(/type:\s*['"]JsonWebKey2020['"]/);
      }
    }
  });
});