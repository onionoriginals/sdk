/** Read-only discovery of private durable anchoring evidence, independent of
 * publication/writer gates. No recovery transactions are returned (P9.6).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import type { OriginalsStore } from './originals-store';
import { OriginalsSDK, readManifest, writeZip } from '@originals/sdk/originals';
import { FileStore } from '@originals/sdk/originals/fs';

export function createAnchoringLibrary(dataDir: string, hosted?: OriginalsStore) {
  const root = join(dataDir, 'originals-anchoring');
  function userDir(sub: string) {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(sub) || sub === '..') throw new Error('BAD_KEY');
    return join(root, sub);
  }
  const keyOf = (did: string) => hex.encode(sha256(new TextEncoder().encode(did)));
  async function reader(sub: string, did: string) {
    if (!/^did:vh:[A-Za-z0-9._:%-]+$/.test(did)) return null;
    const dir = join(userDir(sub), keyOf(did));
    const found = await readFile(join(dir, 'did'), 'utf8').catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    if (found !== did) return null;
    const store = await FileStore.open(join(dir, 'store'));
    const sdk = OriginalsSDK.create({ store, authors: [] });
    return { sdk, store };
  }
  async function list(sub: string) {
    const dir = userDir(sub);
    const keys = await readdir(dir).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
    const rows: Array<{ did: string; title: string; availability: 'server' | 'incomplete'; bitcoin?: boolean; problem?: string }> = [];
    for (const key of keys.sort()) {
      if (!/^[a-f0-9]{64}$/.test(key)) continue;
      const did = await readFile(join(dir, key, 'did'), 'utf8').catch(() => null);
      if (!did || keyOf(did) !== key) continue;
      try {
        const held = await reader(sub, did);
        try {
          const view = await held!.sdk.get(did);
          rows.push({ did, title: view.state.name, availability: 'server', bitcoin: true });
        } finally { await held?.store.close(); }
      } catch {
        // A damaged record is visible, never silently dropped or labelled verified (§7).
        rows.push({ did, title: 'Original needing recovery', availability: 'incomplete', problem: 'Saved evidence could not be read. Keep your recovery export.' });
      }
    }
    // Hosted snapshots are private discovery candidates too, independent of
    // the public Explore gate. Verify them, rather than trusting summaries.
    for (const files of hosted?.evidenceFiles?.(sub) ?? []) {
      const manifest = files.get('originals-evidence.json');
      if (!manifest) continue;
      let did: string;
      try { did = readManifest(manifest).original; } catch { continue; }
      if (rows.some((r) => r.did === did)) continue;
      try {
        const loaded = await OriginalsSDK.create({ authors: [] }).load(writeZip(files));
        const r = loaded.report;
        if (r.original !== did || r.history.status !== 'valid' || r.authorBinding.status !== 'valid' || r.identityEvidence.status !== 'complete') throw new Error('Incomplete snapshot');
        rows.push({ did, title: r.state!.name, availability: 'server', bitcoin: !!r.anchoring, ...(r.resources.status !== 'available' ? { problem: 'Some resource files are unavailable. Keep your evidence export.' } : {}) });
      } catch { rows.push({ did, title: 'Original needing recovery', availability: 'incomplete', problem: 'Saved evidence could not be verified. Nothing has been removed.' }); }
    }
    return rows;
  }
  async function evidence(sub: string, did: string) {
    const held = await reader(sub, did);
    if (held) {
      try { return (await held.sdk.package(did)).bytes; }
      finally { await held.store.close(); }
    }
    for (const files of hosted?.evidenceFiles?.(sub) ?? []) {
      const manifest = files.get('originals-evidence.json');
      if (manifest && readManifest(manifest).original === did) return writeZip(files);
    }
    return null;
  }
  return { list, evidence };
}
export type AnchoringLibrary = ReturnType<typeof createAnchoringLibrary>;
