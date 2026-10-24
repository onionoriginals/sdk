/** Read-only discovery of private durable anchoring evidence, independent of
 * publication/writer gates. No recovery transactions are returned (P9.6).
 *
 * A damaged record is visible, never silently dropped or labelled verified
 * (section 7): a record that cannot be read, does not verify, holds a fork
 * (P6.6, P9.16) or disagrees with another copy of the same Original is listed
 * as an `incomplete` row with a problem, and nothing is removed. A fork in a
 * record whose Original has a did:btco alias is judged against a fresh read of
 * its sat: once the anchor is accepted its branch is the history (P9.16).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import type { OriginalsStore } from './originals-store';
import { OriginalsSDK, readManifest, writeZip, type OriginalView } from '@originals/sdk/originals';
import { FileStore } from '@originals/sdk/originals/fs';
import { OriginalsError } from '@originals/vh';
import type { OriginalsReport, SatEvidence } from '@originals/vh/originals';

export interface LibraryRow {
  did: string;
  title: string;
  availability: 'server' | 'incomplete';
  bitcoin?: boolean;
  problem?: string;
}

export interface AnchoringLibraryOptions {
  /** A fresh read of a did:btco alias's sat, to judge a durable record's fork against Bitcoin (P9.16). */
  bitcoin?: (alias: string) => Promise<SatEvidence[]>;
  /** How long a sat read may take before the fork is treated as unchecked. Default 8 s. */
  bitcoinTimeoutMs?: number;
  /** How long a sat read is reused for the same alias. Default 60 s. */
  bitcoinCacheMs?: number;
  /** The clock for that cache; for tests. */
  now?: () => number;
}

/** Where a durable record's fork stands once judged against Bitcoin (P6.6, P9.13, P9.16). */
type ForkVerdict = 'none' | 'settled' | 'standing' | 'unchecked' | 'other-branch';

const PROBLEM = {
  unreadable: 'Saved evidence could not be read. Keep your recovery export.',
  misfiled: 'This account record does not match the Original it names. Nothing has been removed. Keep your recovery export.',
  unverified: 'Saved evidence could not be verified. Nothing has been removed.',
  fork: 'Fork unresolved — no current branch. This record holds two valid histories and neither was chosen. Keep both exports: only anchoring a chosen branch on Bitcoin settles a fork, and this app does not offer that yet.',
  forkUnchecked: 'Bitcoin could not be read to check whether its anchor settled this fork.',
  otherBranch: 'Bitcoin accepted the other branch. This record\'s latest versions are on a branch Bitcoin dropped; neither copy has been removed. Keep both exports.',
  diverged: 'This account holds hosted copies of this Original that disagree. Neither was chosen, and nothing has been removed.',
  otherCopy: 'Another hosted copy of this Original could not be verified. Nothing has been removed.',
  resources: 'Some resource files are unavailable. Keep your evidence export.',
};

/**
 * Evidence that cannot be served as one copy: two histories, neither chosen
 * (P6.6). The route answers 409 `diverged`, so the opened view says so rather
 * than showing nothing.
 */
const diverged = (did: string, message: string) => new OriginalsError('fork', 'EVIDENCE_DIVERGED', message, { did });

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
const logOf = (c: HostedCopy) => new TextDecoder().decode(c.files.get('asset/did.jsonl') ?? new Uint8Array());

export function createAnchoringLibrary(dataDir: string, hosted?: OriginalsStore, options: AnchoringLibraryOptions = {}) {
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

  /** Sat reads, reused per alias for a minute so a list does not read every sat on every load. */
  const satReads = new Map<string, { at: number; read: Promise<SatEvidence[]> }>();
  const now = options.now ?? Date.now;
  function satRead(alias: string): Promise<SatEvidence[]> {
    const cached = satReads.get(alias);
    const fresh = cached && now() - cached.at < (options.bitcoinCacheMs ?? 60_000);
    const read = fresh ? cached.read : options.bitcoin!(alias);
    if (!fresh) {
      satReads.set(alias, { at: now(), read });
      read.catch(() => satReads.delete(alias));
    }
    // A read that does not answer in time is unchecked, never a pass (section 7), and is not reused.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { satReads.delete(alias); reject(new Error('sat read timed out')); }, options.bitcoinTimeoutMs ?? 8_000);
    });
    return Promise.race([read, deadline]).finally(() => clearTimeout(timer));
  }

  /**
   * A durable record's view, with its fork judged against Bitcoin when the
   * Original names a sat. It is settled only when Bitcoin shows the anchor and
   * its accepted head is on this record's committed branch (the log is it or
   * extends it); Bitcoin accepting the other branch is not a settlement for
   * this copy (P9.13, P9.16). The Bitcoin read uses `load`, which changes
   * nothing: retained anchors are written only by the writer, under its lock.
   */
  async function judged(sdk: OriginalsSDK, did: string): Promise<{ view: OriginalView; fork: ForkVerdict }> {
    const view = await sdk.get(did);
    const alias = view.state.aliases.find((a) => a.startsWith('did:btco:'));
    if (!view.report.fork) return { view, fork: 'none' };
    if (!alias) return { view, fork: 'standing' };
    if (!options.bitcoin) return { view, fork: 'unchecked' };
    try {
      const evidence = await satRead(alias);
      const onBitcoin = (await sdk.load((await sdk.package(did)).bytes, { bitcoin: evidence })).report;
      if (onBitcoin.anchoring?.status !== 'anchored' || !onBitcoin.head) return { view, fork: 'standing' };
      const local = (await sdk.committedLog(did)).trimEnd().split('\n').map((line) => (JSON.parse(line) as { versionId: string }).versionId);
      return { view, fork: local.includes(onBitcoin.head) ? 'settled' : 'other-branch' };
    } catch { return { view, fork: 'unchecked' }; }
  }

  /** The problem a judged durable record shows, or null when it is a saved copy. */
  function durableProblem(view: OriginalView, fork: ForkVerdict, did: string): string | null {
    if (fork === 'other-branch') return PROBLEM.otherBranch;
    if (fork === 'unchecked') return `${PROBLEM.fork} ${PROBLEM.forkUnchecked}`;
    if (fork === 'standing') return PROBLEM.fork;
    return reportProblem({ ...view.report, fork: null }, did);
  }

  /**
   * Every hosted snapshot root of the account, grouped by the Original it
   * names, each verified on its own. One verified copy, or several on one
   * history (the longest is served; a prefix is only stale, P7.6), is the
   * evidence; verified copies that diverge are a divergence and none is
   * returned (P6.6). `list` and `evidence` both use this, so the evidence
   * served is the copy the list verified.
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
      const verified = copies.filter((c) => !c.problem).sort((a, b) => logOf(b).length - logOf(a).length);
      const longest = verified[0];
      if (!longest) {
        out.push({ row: needsRecovery(did, copies.some((c) => c.problem === PROBLEM.fork) ? PROBLEM.fork : PROBLEM.unverified), files: null });
      } else if (verified.some((c) => !logOf(longest).startsWith(logOf(c)))) {
        // Never chosen by order, length or time (P6.6).
        out.push({ row: needsRecovery(did, PROBLEM.diverged), files: null });
      } else {
        const r = longest.report!;
        const problems = [verified.length < copies.length ? PROBLEM.otherCopy : null, r.resources.status !== 'available' ? PROBLEM.resources : null].filter(Boolean);
        out.push({ row: { did, title: r.state!.name, availability: 'server', bitcoin: !!r.anchoring, ...(problems.length ? { problem: problems.join(' ') } : {}) }, files: longest.files });
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
          const { view, fork } = await judged(held!.sdk, did);
          // The same checks a hosted snapshot passes, fork included (section 7; P6.6).
          const problem = durableProblem(view, fork, did);
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

  /** The verified evidence for one Original; throws EVIDENCE_DIVERGED when there are two histories and neither is chosen. */
  async function evidence(sub: string, did: string): Promise<Uint8Array | null> {
    const held = await reader(sub, did);
    if (held) {
      try {
        // The same fork check as the list, before packaging one branch as the evidence (P6.6, P9.16).
        // Only when Bitcoin's head is on this record's branch is one branch the evidence (P9.13, P9.16).
        const verdict = await judged(held.sdk, did).then((j) => j.fork, () => 'none' as const);
        if (verdict === 'other-branch') throw diverged(did, PROBLEM.otherBranch);
        if (verdict === 'standing' || verdict === 'unchecked') throw diverged(did, PROBLEM.fork);
        return (await held.sdk.package(did)).bytes;
      } finally { await held.store.close(); }
    }
    const found = (await scanHosted(sub)).find((h) => h.row.did === did);
    if (found && !found.files && found.row.problem === PROBLEM.diverged) throw diverged(did, PROBLEM.diverged);
    if (found && !found.files && found.row.problem === PROBLEM.fork) throw diverged(did, PROBLEM.fork);
    return found?.files ? writeZip(found.files) : null;
  }
  return { list, evidence };
}
export type AnchoringLibrary = ReturnType<typeof createAnchoringLibrary>;
