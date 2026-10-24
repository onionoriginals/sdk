import { base64 } from '@scure/base';
import { readUserWebVHDid } from '../auth/webvh';
import { DurableHostingStorageAdapter } from './durable-hosting-adapter';
import { OriginalsSDK } from '@originals/sdk/originals';
import { BrowserOriginalsStore } from './browser-store';
import { indexedDbOutbox, type OutboxEntry } from './anchoring';
import { library as libraryCopy } from '../content';

export interface LibraryItem {
  did: string;
  title: string;
  local: boolean;
  server: boolean;
  pending: boolean;
  bitcoin?: boolean;
  problem?: string;
}
export const accountOutboxName = (account?: string) => account ? `originals-anchoring-outbox:account:${account}` : 'originals-anchoring-outbox:guest';

export interface ListLibraryOptions {
  /** The engine that judges a forked anchored Original against Bitcoin (P9.16); for tests. */
  engine?: (store: BrowserOriginalsStore) => DemoEngineLike;
  /** How long a Bitcoin read may take before the fork is treated as unchecked. Default 8 s. */
  bitcoinTimeoutMs?: number;
}
/** What listLibrary needs from DemoEngine, kept structural so this module does not import the engine eagerly. */
interface DemoEngineLike {
  open(did: string): Promise<unknown>;
  verifyBitcoin(): Promise<{ fork?: unknown; bitcoinOtherBranch?: boolean; bitcoinReadError?: string }>;
}

/**
 * Where a fork in an Original with a did:btco alias stands once judged
 * against a fresh Bitcoin read. It is settled only when Bitcoin's accepted
 * head is on this copy's branch (P9.13, P9.16). A read that fails or does not
 * answer in time leaves it standing, said as unchecked: never a pass (section 7).
 */
async function forkProblem(did: string, store: BrowserOriginalsStore, options: ListLibraryOptions): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const engine = options.engine?.(store) ?? new (await import('./engine')).DemoEngine({ store });
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Bitcoin read timed out')), options.bitcoinTimeoutMs ?? 8_000); });
    const judged = await Promise.race([(async () => { await engine.open(did); return engine.verifyBitcoin(); })(), deadline]);
    if (!judged.fork) return undefined;
    if (judged.bitcoinOtherBranch) return libraryCopy.forkOtherBranch;
    return judged.bitcoinReadError ? `${libraryCopy.forkUnresolved} ${libraryCopy.forkUnchecked}` : libraryCopy.forkUnresolved;
  } catch { return `${libraryCopy.forkUnresolved} ${libraryCopy.forkUnchecked}`; }
  finally { clearTimeout(timer); }
}

export async function listLibrary(account?: string, fundingAddress?: string, options: ListLibraryOptions = {}): Promise<{ items: LibraryItem[]; warning?: string }> {
  const rows = new Map<string, LibraryItem>();
  // Outbox imports that conflicted: the store's own fork judgement below replaces their message.
  const conflicted = new Set<string>();
  const store = new BrowserOriginalsStore(account);
  const reader = OriginalsSDK.create({ store, authors: [] });
  const outbox = indexedDbOutbox(accountOutboxName(account));
  let warning: string | undefined;
  try {
    if (account && fundingAddress) await recoverLegacySubmissions(account, fundingAddress);
    // A crash can leave an outbox entry before the library has a visible log.
    // Its verified package recovers that log; the signed pair stays unchanged.
    for (const did of await outbox.list()) {
      const waiting = await outbox.get(did);
      if (!waiting) continue;
      try {
        const bytes = base64.decode(waiting.evidence);
        const loaded = await reader.load(bytes);
        if (loaded.report.original !== did) throw new Error('Evidence mismatch');
        const imported = await reader.import(bytes);
        if (imported.status === 'conflict') conflicted.add(did);
        if (imported.status === 'conflict') rows.set(did, { did, title: imported.original.state.name, local: true, server: false, pending: !waiting.refused, problem: 'Conflicting history is retained. No branch was chosen.' });
      } catch { rows.set(did, { did, title: 'Submission needing recovery', local: true, server: false, pending: !waiting.refused, problem: 'This pending submission has incomplete evidence. Its transaction pair has been kept.' }); }
    }
    for (const did of await store.list()) {
      const waiting = await outbox.get(did);
      // A refused pair is kept for recovery, not awaiting an answer (owner decision, 23 October 2026; P9.6).
      const pending = !!waiting && !waiting.refused;
      const refused = waiting?.refused ? libraryCopy.refusedPair(waiting.refused.message) : undefined;
      try {
        const view = await reader.get(did);
        // Divergent valid branches: no current branch, so the row is never shown as fine (P6.6, P9.16).
        // An anchored Original's fork is judged against Bitcoin first (P9.16).
        const anchored = view.state.aliases.some((a) => a.startsWith('did:btco:'));
        const fork = !view.report.fork ? undefined : anchored ? await forkProblem(did, store, options) : libraryCopy.forkUnresolved;
        const earlier = conflicted.has(did) ? undefined : rows.get(did)?.problem;
        const problem = [fork, refused, earlier].filter(Boolean).join(' ') || undefined;
        rows.set(did, { did, title: view.state.name, local: true, server: false, pending, bitcoin: !!view.report.anchoring, problem });
      } catch {
        rows.set(did, { did, title: 'Original needing recovery', local: true, server: false, pending, problem: [libraryCopy.unverifiedLocal, refused].filter(Boolean).join(' ') });
      }
    }
  } catch { warning = 'Saved work in this browser could not be read. Please retry; nothing has been removed.'; }
  if (account) {
    try {
      const response = await fetch('/api/originals', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error();
      const body = await response.json() as { originals: Array<{ did: string; title: string; availability: string; bitcoin?: boolean; problem?: string }> };
      for (const item of body.originals) {
        const local = rows.get(item.did);
        rows.set(item.did, { did: item.did, title: local?.title ?? item.title, local: !!local, server: item.availability === 'server', pending: local?.pending ?? false, bitcoin: local?.bitcoin || item.bitcoin, problem: local?.problem ?? item.problem ?? (item.availability !== 'server' ? 'This account has a record, but its evidence needs to be imported to reopen it.' : undefined) });
      }
    } catch { warning = [warning, 'Account storage could not be reached. This list may be incomplete.'].filter(Boolean).join(' '); }
  }
  return { items: [...rows.values()], warning };
}

export async function fetchLibraryEvidence(did: string): Promise<Uint8Array | null> {
  const response = await fetch(`/api/originals/evidence?did=${encodeURIComponent(did)}`, { credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 404) return null;
  // Two histories, neither chosen (P6.6): said as such, never shown as "nothing saved".
  if (response.status === 409) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? libraryCopy.diverged);
  }
  if (!response.ok) throw new Error('Your saved evidence could not be reached. Retry or import your recovery export.');
  const declared = Number(response.headers.get('content-length'));
  const max = 96 * 1024 * 1024;
  if (declared > max) throw new Error('This recovery export is too large to open here.');
  const body = response.body?.getReader();
  if (!body) throw new Error('No evidence was returned.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await body.read();
    if (next.done) break;
    size += next.value.length;
    if (size > max) { await body.cancel(); throw new Error('This recovery export is too large to open here.'); }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

/** Adopt pre-library unscoped pairs only after both the verified author and
 * deposit address bind them to this account. Unclaimed data is never deleted
 * or listed to another account. P5.3, P7.5, P9.6.
 */
export async function recoverLegacySubmissions(account: string, fundingAddress: string): Promise<void> {
  const legacy = indexedDbOutbox();
  const dids = await legacy.list();
  if (!dids.length) return;
  const identity = await readUserWebVHDid({ subOrgId: account, hosting: new DurableHostingStorageAdapter() });
  if (!identity) return;
  const scoped = indexedDbOutbox(accountOutboxName(account));
  const reader = OriginalsSDK.create({ store: new BrowserOriginalsStore(account), authors: [] });
  for (const did of dids) {
    const entry = await legacy.get(did);
    if (!entry || entry.pair.prepared.changeAddress !== fundingAddress) continue;
    try {
      const zip = base64.decode(entry.evidence);
      if (!(await legacySubmissionBelongs(entry, did, identity.did, fundingAddress))) continue;
      const existing = await scoped.get(did);
      if (existing && JSON.stringify(existing.pair) !== JSON.stringify(entry.pair)) continue;
      await reader.import(zip);
      await scoped.put(did, entry);
      await legacy.delete(did);
    } catch { /* Preserve unverified or incomplete legacy data for recovery. */ }
  }
}

/** Verification is deliberately before adoption or returning any pair. */
export async function legacySubmissionBelongs(entry: OutboxEntry, did: string, author: string, fundingAddress: string): Promise<boolean> {
  if (entry.pair.prepared.changeAddress !== fundingAddress) return false;
  try {
    const r = (await OriginalsSDK.create({ authors: [] }).load(base64.decode(entry.evidence))).report;
    return r.original === did && r.identityEvidence.author === author && r.history.status === 'valid' && r.authorBinding.status === 'valid' && r.identityEvidence.status === 'complete';
  } catch { return false; }
}
