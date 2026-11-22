// did:og shared-host saves over HTTP on the durable file store (P6.7, P6.2, P9.7): the hosted vector.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base64 } from '@scure/base';
import { createOgRoutes, ogFileStore } from '../src/og-routes.js';
import { entryLine, prepareNext, signEntry } from '@originals/vh/og';
import { localSigner } from '@originals/vh/crypto';

const VEC = join(import.meta.dir, '..', '..', 'vh', 'tests', 'fixtures', 'og-vectors', 'og-1.0-draft.1');
const read = (p: string) => readFileSync(join(VEC, p), 'utf8');
const ex = JSON.parse(read('hosted/exchanges.json'));
const index = JSON.parse(read('index.json'));

describe('did:og routes (T14-079, T6-030)', () => {
  test('the vector exchanges over HTTP, durably stored, and the served log and resources', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'og-host-'));
    try {
      const store = ogFileStore(dir);
      await store.createLog(index.original, read('local/asset/did.jsonl'));
      await store.putIdentity(index.author, read('local/author/did.jsonl'));
      const v1 = new Uint8Array(readFileSync(join(VEC, 'local/resources/v1.md')));
      const digest = ex.exchanges[0].request.entry && JSON.parse(read('local/asset/did.jsonl').split('\n')[0]).state.asset.resource.digest;
      await store.putResource(index.original, digest, v1);
      const routes = createOgRoutes({ store });
      const post = (body: unknown) => routes(new Request('http://h/og/saves', { method: 'POST', body: JSON.stringify(body) }), new URL('http://h/og/saves'));
      const statuses = [];
      for (const { request, response } of ex.exchanges) {
        const r = await post({ ...request, resources: request.resources.map((x: { digest: string; bytes: Uint8Array }) => ({ digest: x.digest, bytes: base64.encode(x.bytes) })) });
        statuses.push(r.status);
        expect(await r.json()).toEqual(response);
      }
      expect(statuses).toEqual([201, 409, 200]);
      // T6-030: rejected is 422: an entry on the head (entry 3) signed by a key that is not the author's.
      const head = JSON.parse(read('hosted/served/originals/asset/did.jsonl').split('\n')[2]);
      const state = { ...head.state, transitions: [], asset: { ...head.state.asset, name: 'Forged' } };
      const forged = await signEntry(prepareNext(head, { versionTime: '2026-01-05T12:00:00Z', parameters: {}, state }), head.state.author.verificationMethod, localSigner('Ed25519', new Uint8Array(32).fill(7)));
      const rejected = await post({ original: index.original, entry: entryLine(forged), resources: [], identities: [] });
      expect(rejected.status).toBe(422);
      expect(await rejected.json()).toMatchObject({ result: 'rejected', rule: 'P5.3' });
      const scid = index.original.slice(7);
      const log = await routes(new Request(`http://h/og/${scid}/did.jsonl`), new URL(`http://h/og/${scid}/did.jsonl`));
      expect(await log.text()).toBe(read('hosted/served/originals/asset/did.jsonl'));
      const res = await routes(new Request(`http://h/og/${scid}/resources/${digest}`), new URL(`http://h/og/${scid}/resources/${digest}`));
      expect(res.headers.get('content-type')).toBe('text/markdown');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(v1);
      // Durable: a new store over the same directory sees the accepted head.
      expect(await ogFileStore(dir).readLog(index.original)).toBe(read('hosted/served/originals/asset/did.jsonl'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
