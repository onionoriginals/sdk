import { test, expect } from 'bun:test';
import { verifyHistory, validateDocument } from '@originals/sdk/cel';
import { verifyOriginal } from './verify-original';
import manifest from '../../public/example/manifest.json';
import document from '../../public/example/cel-log.json';

test('bundled CEL 3 example authenticates its bytes and both signed histories', async () => {
  const directory = new URL('../../public/example/', import.meta.url);
  const bytes = new Uint8Array(await Bun.file(new URL('artwork.svg', directory)).arrayBuffer());
  const method = (await Bun.file(new URL('did-log.jsonl', directory)).text()).trim().split('\n').map((line) => JSON.parse(line));
  const history = verifyHistory(validateDocument(document), { expectedAssetId: manifest.dids['did:cel'] });
  expect(history.state.alias).toBe(manifest.dids['did:webvh']);
  const checks = await verifyOriginal({ did: history.state.alias, logEntries: method, celLog: validateDocument(document), resourceBytes: bytes, declaredHash: manifest.resources.find((r) => r.id === 'artwork.svg')!.hash });
  expect(checks.every((check) => check.ok)).toBe(true);
});
