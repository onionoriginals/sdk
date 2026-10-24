/** Read-only discovery of private durable anchoring evidence, independent of
 * publication/writer gates. No recovery transactions are returned (P9.6).
 *
 * A damaged record is visible, never silently dropped or labelled verified
 * (section 7): a record that cannot be read, does not verify, holds a fork
 * (P6.6, P9.16) or disagrees with another copy of the same Original is listed
 * as an `incomplete` row with a problem, and nothing is removed.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import type { OriginalsStore } from './originals-store';
import { OriginalsSDK, readManifest, writeZip } from '@originals/sdk/originals';
import { FileStore } from '@originals/sdk/originals/fs';
import type { OriginalsReport } from '@originals/vh/originals';

export interface LibraryRow {
  did: string;
  title: string;
  availability: 'server' | 'incomplete';
  bitcoin?: boolean;
  problem?: string;
}

const PROBLEM = {
  unreadable: 'Saved evidence could not be read. Keep your recovery export.',
  misfiled: 'This account record does not match the Original it names. Nothing has been removed. Keep your recovery export.',
  unverified: 'Saved evidence could not be verified. Nothing has been removed.',
  fork: 'Fork unresolved — no current branch. This record holds two valid histories and neither was chosen. Only anchoring on Bitcoin settles a fork.',
  diverged: 'This account holds hosted copies of this Original that disagree. Neither was chosen, and nothing has been removed.',
  otherCopy: 'Another hosted copy of this Original could not be verified. Nothing has been removed.',
  resources: 'Some resource files are unavailable. Keep your evidence export.',
};

/** Why a report cannot be shown as a saved copy, or null when it can (section 7; P6.6). */
function reportProblem(r: OriginalsReport, did: string): string | null {
  if (r.original !== did || r.history.status !== 'valid' || r.authorBinding.status !== 'valid' || r.identityEvidence.status !== 'complete' || !r.state) return PROBLEM.unverified;
  if (r.fork) return PROBLEM.fork;
  return null;
}

/** A record named by its hashed key, or its position, when its own DID cannot be trusted. */
const unknownDid = (key: string) => `unknown:${key}`;
const needsRecovery = (did: string, problem: string): LibraryRow => ({ did, title: 'Original needing recovery', availability: 'incomplete', problem });

type HostedCopy = { files: Map<string, Uint8Array>; report?: OriginalsReport; problem?: string };

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

  /**
   * Every hosted snapshot root of the account, grouped by the Original it
   * names, each verified on its own. One verified copy, or several that agree
   * on the head, is the evidence; verified copies that disagree are a
   * divergence and none is returned (P6.6). `list` and `evidence` both use
   * this, so the evidence served is the copy the list verified.
   */
  async function scanHosted(sub: string): Promise<Array<{ row: LibraryRow; files: Map<string, Uint8Array> | null }>> {
    const out: Array<{ row: LibraryRow; files: Map<string, Uint8Array> | null }> = [];
    const byDid = new Map<string, HostedCopy[]>();
    let position = 0;
    for (const files of hosted?.evidenceFiles?.(sub) ?? []) {
      position++;
      const manifest = files.get('originals-evidence.json');
      if (!manifest) continue;
      let did: string;
      try { did = readManifest(manifest).original; } catch {
        out.push({ row: needsRecovery(unknownDid(`hosted-${position}`), PROBLEM.unreadable), files: null });
        continue;
      }
      const copies = byDid.get(did) ?? [];
      byDid.set(did, copies);
      try {
        const report = (await OriginalsSDK.create({ authors: [] }).load(writeZip(files))).report;
        const problem = reportProblem(report, did);
        copies.push({ files, report, ...(problem ? { problem } : {}) });
      } catch { copies.push({ files, problem: PROBLEM.unverified }); }
    }
    for (const [did, copies] of byDid) {
      const verified = copies.filter((c) => !c.problem);
      const heads = new Set(verified.map((c) => c.report!.head));
      if (verified.length === 0) {
        out.push({ row: needsRecovery(did, copies.some((c) => c.problem === PROBLEM.fork) ? PROBLEM.fork : PROBLEM.unverified), files: null });
      } else if (heads.size > 1) {
        // Never chosen by order, length or time (P6.6).
        out.push({ row: needsRecovery(did, PROBLEM.diverged), files: null });
      } else {
        const chosen = verified[0];
        const r = chosen.report!;
        const problems = [verified.length < copies.length ? PROBLEM.otherCopy : null, r.resources.status !== 'available' ? PROBLEM.resources : null].filter(Boolean);
        out.push({ row: { did, title: r.state!.name, availability: 'server', bitcoin: !!r.anchoring, ...(problems.length ? { problem: problems.join(' ') } : {}) }, files: chosen.files });
      }
    }
    return out;
  }

  async function list(sub: string): Promise<LibraryRow[]> {
    const dir = userDir(sub);
    const keys = await readdir(dir).catch((e) => { if (e.code === 'ENOENT') return []; throw e; });
    const rows: LibraryRow[] = [];
    for (const key of keys.sort()) {
      if (!/^[a-f0-9]{64}$/.test(key)) continue;
      const did = await readFile(join(dir, key, 'did'), 'utf8').catch(() => null);
      if (!did) { rows.push(needsRecovery(unknownDid(key), PROBLEM.unreadable)); continue; }
      if (keyOf(did) !== key) { rows.push(needsRecovery(unknownDid(key), PROBLEM.misfiled)); continue; }
      try {
        const held = await reader(sub, did);
        try {
          const view = await held!.sdk.get(did);
          // The same checks a hosted snapshot passes, fork included (section 7; P6.6).
          const problem = reportProblem(view.report, did);
          rows.push(problem
            ? { did, title: view.state.name, availability: 'incomplete', bitcoin: true, problem }
            : { did, title: view.state.name, availability: 'server', bitcoin: true, ...(view.report.resources.status !== 'available' ? { problem: PROBLEM.resources } : {}) });
        } finally { await held?.store.close(); }
      } catch {
        rows.push(needsRecovery(did, PROBLEM.unreadable));
      }
    }
    // Hosted snapshots are private discovery candidates too, independent of
    // the public Explore gate. Verify them, rather than trusting summaries.
    for (const { row } of await scanHosted(sub)) {
      if (!rows.some((r) => r.did === row.did)) rows.push(row);
    }
    return rows;
  }

  async function evidence(sub: string, did: string): Promise<Uint8Array | null> {
    const held = await reader(sub, did);
    if (held) {
      try { return (await held.sdk.package(did)).bytes; }
      finally { await held.store.close(); }
    }
    const found = (await scanHosted(sub)).find((h) => h.row.did === did);
    return found?.files ? writeZip(found.files) : null;
  }
  return { list, evidence };
}
export type AnchoringLibrary = ReturnType<typeof createAnchoringLibrary>;
