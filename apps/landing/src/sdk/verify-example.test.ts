import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { FIRST_LIGHT, FIRST_LIGHT_ZIP_BASE64 } from './example-evidence';
import { verifyExample } from './verify-example';

test('the bundled "First Light" evidence package verifies in this tab, with no key', async () => {
  const result = await verifyExample();
  expect(result.allOk).toBe(true);
  expect(result.checks.map((c) => [c.id, c.ok])).toEqual([['hash', true], ['history', true], ['author', true]]);
  expect(result.dids).toEqual({ original: FIRST_LIGHT.original, author: FIRST_LIGHT.author });
  expect(result.profile).toBe('originals:1.0');
  expect(result.title).toBe('First Light');
  expect(result.medium).toBe('Orbits');
  // A local Original is valid as of its checkpoint and never reported current (P7.10, C12-145).
  expect(result.validAsOf).toMatch(/^\d+-Qm/);
  expect(result.current).toBe(false);
});

test('the example says plainly where and when the author DID history was obtained, and that the DID may be newer (P7.8)', async () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const result = await verifyExample(now);
  expect(result.freshness).toContain(`The history of ${FIRST_LIGHT.author} was obtained from the evidence package at 2026-10-23T12:00:00.000Z; its latest version there is `);
  expect(result.freshness).toContain('The DID may have a newer version, for example one that removes a key, that this verifier has not seen.');
});

test('the generated module and the published ZIP are the same package', () => {
  const published = readFileSync(new URL('../../public/example/first-light.originals.zip', import.meta.url));
  expect(Buffer.from(FIRST_LIGHT_ZIP_BASE64, 'base64').equals(published)).toBe(true);
});

test('a tampered package does not verify', async () => {
  const bytes = Buffer.from(FIRST_LIGHT_ZIP_BASE64, 'base64');
  const { MemoryStore, OriginalsSDK, readZip, writeZip } = await import('@originals/sdk/originals');
  const files = readZip(new Uint8Array(bytes));
  const art = [...files.keys()].find((k) => k.startsWith('resources/'))!;
  files.set(art, new TextEncoder().encode('<svg/>'));
  const { report } = await OriginalsSDK.create({ store: new MemoryStore(), authors: [] }).load(writeZip(files));
  expect(report.resources.status).toBe('digest-failure');
  expect(report.current).toBe(false);
});
