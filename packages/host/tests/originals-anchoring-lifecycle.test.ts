/**
 * The anchoring module's stores across a process's life (2026-11-05): a store
 * that cannot be opened is a 503 refusal, not a thrown 500, and does not end
 * a sweep pass; `close()` closes every store it opened, which removes their
 * `.lock` files, so a redeploy over the same volume does not strand them.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { createOriginalsAnchoring, type OriginalsAnchoringDeps } from '../src/originals-anchoring.js';

const SUB = 'sub-1';
const DID = 'did:vh:QmTxkqzBHMdeDZRfSLHX1u6EjPNn3DMiG1LLtkE2HKfEiN';
const OTHER = 'did:vh:QmOtherOriginalOtherOriginalOtherOriginalOther1';
const FOREIGN_LOCK = JSON.stringify({ pid: 18, host: '42eee9bb9202', token: 't', start: '1' });

async function setup(dids: string[], lockedDid?: string, onMoney?: (event: string) => void) {
  const dataDir = mkdtempSync(join(tmpdir(), 'anchoring-lifecycle-'));
  const dirs: Record<string, string> = {};
  for (const did of dids) {
    const dir = join(dataDir, 'originals-anchoring', SUB, hex.encode(sha256(new TextEncoder().encode(did))));
    await mkdir(join(dir, 'store'), { recursive: true });
    await writeFile(join(dir, 'did'), did);
    if (did === lockedDid) await writeFile(join(dir, 'store', '.lock'), FOREIGN_LOCK);
    dirs[did] = dir;
  }
  const money: string[] = [];
  // No Bitcoin read is reached: every store here is empty or unopenable.
  const anchoring = createOriginalsAnchoring({
    dataDir, provider: {} as OriginalsAnchoringDeps['provider'], clock: {} as OriginalsAnchoringDeps['clock'],
    index: 'test', money: (event: string) => { money.push(event); onMoney?.(event); },
  } as OriginalsAnchoringDeps);
  return { dataDir, dirs, anchoring, money };
}

const quiet = async <T>(fn: () => Promise<T>) => {
  const warn = console.warn; console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
};

describe('a store that cannot be opened', () => {
  test('status is a 503 STORE_LOCKED refusal that names no server path', async () => {
    const { dataDir, anchoring } = await setup([DID], DID);
    const result = await quiet(() => anchoring.status(SUB, DID));
    expect(result).toMatchObject({ ok: false, httpStatus: 503, error: 'status_unavailable', code: 'STORE_LOCKED', category: 'unavailable-bytes' });
    expect(JSON.stringify(result)).not.toContain(dataDir);
    expect(JSON.stringify(result)).not.toContain('42eee9bb9202');
  });

  test('recorded is a 503 refusal too, not a throw', async () => {
    const { anchoring } = await setup([DID], DID);
    const pair = { versionId: '1-x', prepared: { version: 1, signedCommitHex: '', revealTxHex: '', commitTxId: 'c', revealTxId: 'r', inscriptionId: 'i', satoshi: '1', changeAddress: 'a', fundingUtxos: [{}] } };
    const result = await quiet(() => anchoring.recorded(SUB, DID, pair as never));
    expect(result).toMatchObject({ ok: false, httpStatus: 503, code: 'STORE_LOCKED' });
  });

  test('a sweep counts it as one failure and goes on to the next Original', async () => {
    const { anchoring, money } = await setup([DID, OTHER], DID);
    const pass = await quiet(() => anchoring.sweep());
    expect(pass.examined).toBe(2);
    expect(pass.failed).toBe(2); // the locked one, and the empty one catchUp cannot read
    expect(money.filter((m) => m === 'originals_anchor_sweep_failed')).toHaveLength(2);
  });
});

describe('close()', () => {
  test('closes every opened store, removing its lock, and refuses work after', async () => {
    const { dirs, anchoring } = await setup([DID]);
    await quiet(() => anchoring.status(SUB, DID)); // opens and holds the store
    expect(existsSync(join(dirs[DID], 'store', '.lock'))).toBe(true);
    await anchoring.close();
    expect(existsSync(join(dirs[DID], 'store', '.lock'))).toBe(false);
    expect(await anchoring.status(SUB, DID)).toMatchObject({ ok: false, httpStatus: 503, error: 'shutting_down' });
    expect(await anchoring.sweep()).toEqual({ examined: 0, resumed: 0, failed: 0 });
    await expect(anchoring.close()).resolves.toBeUndefined(); // idempotent
  });

  test('waits for work already queued on an Original before closing its store', async () => {
    let anchoring!: Awaited<ReturnType<typeof setup>>['anchoring'];
    let lockPath = '';
    let closed: Promise<void> | undefined;
    let lockWhileQueued = false;
    // The sweep writes its money line from inside the Original's queued work:
    // close() is asked for from there, while that work is still running.
    const ctx = await setup([DID], undefined, () => {
      closed ??= anchoring.close();
      lockWhileQueued = existsSync(lockPath);
    });
    anchoring = ctx.anchoring;
    lockPath = join(ctx.dirs[DID], 'store', '.lock');
    await quiet(() => anchoring.sweep());
    expect(closed).toBeDefined();
    expect(lockWhileQueued).toBe(true); // the store stayed open for the work in progress
    await closed;
    expect(existsSync(lockPath)).toBe(false);
  });
});
