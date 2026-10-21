/**
 * Shared-host saves (P6.7): one Original's asset log, in the hosted layout
 * (hosted-layout.ts), accepting entries from any authorized signer.
 *
 *   POST /api/originals/submit/<encoded site key>
 *     site key  <host>/<user-slug>/o-<name>, the alias's #files base without its scheme
 *     body      { original, entry, resources: { <digest>: <base64> }, identities: [{ did, log, witness? }] }
 *     200       { status: "accepted" | "already-accepted", checkpoint, head }
 *     409       { status: "stale-parent", error: "stale_parent", head }
 *     400 malformed · 401 not signed in · 404 not hosted · 413 too large
 *     422 the entry does not verify against the head, or its bytes are missing or wrong
 *
 * In the order P6.7 sets:
 *
 * 1. An entry byte-identical to a line of the accepted log is already
 *    accepted: its checkpoint and the current head are returned, with no
 *    append and no conflict, however far the head has moved (P6.4).
 * 2. Otherwise the entry's parent must be the accepted head: its versionId
 *    must hash over the entry with the head's versionId (VH-Log chaining). An
 *    entry that chains to any other entry, to none, or that was changed after
 *    signing, does not extend the head and is a stale-parent conflict naming
 *    the head.
 * 3. The head log plus the entry must verify under the profile
 *    (`verifyOriginal`: VH history, author binding and, through it, any
 *    editor rule the profile has; complete identity evidence), and every
 *    resource the entry introduces must arrive with bytes matching its digest.
 *    Identity evidence is the submitted DID log of each signer where it
 *    extends the one the host holds (else the host's); a submitted log that
 *    diverges from the stored one is refused.
 * 4. Durable before visible (P6.2): new resource bytes and signer DID logs are
 *    written first (each an fsynced atomic replace), then the asset log, the
 *    commit point that publishes the new head, then the manifest naming it.
 *    The answer follows. A crash before the log write leaves only staged
 *    bytes; one after it leaves the manifest a step behind until the next
 *    save or byte-identical retry repairs it.
 *
 * The host stores the exact submitted line. It never re-signs, rebases,
 * reorders or changes a submission, and a refused one writes nothing.
 *
 * Atomicity: one in-process queue per Original serializes submissions, and
 * the head comparison and the log replace run in one synchronous step that
 * first re-reads the log, so an owner's upload in between makes the
 * submission start over rather than race. This assumes ONE server process per
 * data directory, which serve.ts enforces with its instance lock
 * (instance-lock.ts). Several instances would need a shared compare-and-swap
 * on the head: a database row or object-store conditional write keyed by the
 * Original, or a lock service, held across the compare and the log replace.
 *
 * Who may call: any signed-in account (the existing JWT model; rate limited),
 * because the signed entry, not the account, authorizes the change (P5.4,
 * P5.9). The namespace owner, and any other signed-in caller presenting a
 * valid entry, may save; accepted files stay the namespace owner's and count
 * against the owner's quota. PROVISIONAL: whether a host should require more
 * of a caller who is not the namespace owner is an open deployment question.
 */
import { parseJson, isJsonObject, type JsonObject } from '@originals/vh/json';
import { vhHash } from '@originals/vh/log';
import { resourceDigest, verifyOriginal, type AuthorDidEvidence, type OriginalsReport } from '@originals/vh/originals';
import { authorPath } from '@originals/sdk/originals';
import { json } from './router';
import { signedMediaType } from './hosted-layout';
import type { OriginalsStore } from './originals-store';

const DIGEST = /^z[1-9A-HJ-NP-Za-km-z]{40,60}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const VERSION_ID = /^(\d+)-(.+)$/;
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

export interface ParsedSubmission {
  original: string;
  /** The exact line submitted. */
  entry: string;
  parsed: JsonObject & { versionId: string };
  resources: Map<string, Uint8Array>;
  identities: AuthorDidEvidence[];
}

type Refusal = { http: number; body: Record<string, unknown> };
type Outcome = Refusal | 'again';

function refuse(http: number, error: string, extra: Record<string, unknown> = {}): Refusal {
  return { http, body: { error, ...extra } };
}

/** Parse and shape-check a submission body, or say why it is malformed (400). */
export function parseSubmission(text: string): ParsedSubmission | Refusal {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse(400, 'bad_request');
  }
  const b = body as Record<string, unknown>;
  if (!isJsonObject(body as never) || typeof b.original !== 'string' || typeof b.entry !== 'string' || b.entry.includes('\n')) return refuse(400, 'bad_request');
  let parsed: unknown;
  try {
    parsed = parseJson(b.entry);
  } catch {
    return refuse(400, 'entry_invalid');
  }
  // The host stores and compares the exact line, so it must be the compact form every writer produces.
  if (!isJsonObject(parsed as never) || JSON.stringify(parsed) !== b.entry) return refuse(400, 'entry_not_canonical');
  const p = parsed as JsonObject;
  if (typeof p.versionId !== 'string' || !VERSION_ID.test(p.versionId)) return refuse(400, 'entry_invalid');
  const resources = new Map<string, Uint8Array>();
  const raw = b.resources ?? {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return refuse(400, 'bad_request');
  for (const [digest, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!DIGEST.test(digest) || typeof value !== 'string' || !BASE64.test(value)) return refuse(400, 'bad_request');
    const bytes = new Uint8Array(Buffer.from(value, 'base64'));
    if (Buffer.from(bytes).toString('base64') !== value) return refuse(400, 'bad_request');
    resources.set(digest, bytes);
  }
  const identities: AuthorDidEvidence[] = [];
  const ids = b.identities ?? [];
  if (!Array.isArray(ids)) return refuse(400, 'bad_request');
  for (const i of ids as Array<Record<string, unknown>>) {
    if (typeof i !== 'object' || i === null || typeof i.did !== 'string' || typeof i.log !== 'string') return refuse(400, 'bad_request');
    identities.push({ did: i.did, log: i.log, ...(i.witness !== undefined ? { witness: i.witness } : {}) });
  }
  return { original: b.original, entry: b.entry, parsed: p as ParsedSubmission['parsed'], resources, identities };
}

/** True when `entry` is the next entry after the entry whose versionId is `head` (VH-Log chaining). */
function extendsHead(entry: ParsedSubmission['parsed'], head: string): boolean {
  const id = VERSION_ID.exec(entry.versionId);
  const h = VERSION_ID.exec(head);
  if (!id || !h || Number(id[1]) !== Number(h[1]) + 1) return false;
  const { proof: _proof, ...unsigned } = entry;
  try {
    return vhHash({ ...unsigned, versionId: head }) === id[2];
  } catch {
    return false;
  }
}

function lineState(line: string): Record<string, unknown> | undefined {
  try {
    const entry = JSON.parse(line) as { state?: unknown };
    return typeof entry.state === 'object' && entry.state !== null ? (entry.state as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Every DID that signs the log's entries: the author, and an editor where an entry names one (P5.16). */
function signerDids(lines: string[]): string[] {
  const dids = new Set<string>();
  for (const line of lines) {
    const state = lineState(line);
    for (const ref of [state?.author, state?.editor]) {
      const did = (ref as { did?: unknown } | undefined)?.did;
      if (typeof did === 'string') dids.add(did);
    }
  }
  return [...dids];
}

function text(bytes: Uint8Array): string | null {
  try {
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  return a !== null && b !== null && a.length === b.length && a.every((x, i) => x === b[i]);
}

export function createSharedSaves(deps: { store: OriginalsStore; now: () => number }) {
  const { store } = deps;
  const queues = new Map<string, Promise<unknown>>();

  /** Run `fn` after every earlier submission for the same Original has finished. */
  function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
  }

  /** Keep the hosted manifest naming the accepted head (P9.1). */
  function writeManifest(owner: string, siteKey: string, original: string, head: string, report?: OriginalsReport): void {
    const key = `${siteKey}/originals/originals-evidence.json`;
    let manifest: Record<string, unknown> | null = null;
    const existing = store.readHosted(key);
    try {
      const value = existing ? (JSON.parse(text(existing) ?? '') as unknown) : null;
      if (isJsonObject(value as never)) manifest = value as Record<string, unknown>;
    } catch {
      manifest = null;
    }
    if (!report && manifest?.checkpoint === head && manifest?.head === head) return;
    const missing: unknown[] = report
      ? report.resources.missing.map((v) => ({ kind: 'resource', resource: v.resource, version: v.version, digest: v.digest, versionId: v.versionId }))
      : Array.isArray(manifest?.missing) ? manifest.missing : [];
    const next = {
      format: 'originals-evidence/0.1',
      profile: 'originals:1.0',
      original,
      checkpoint: head,
      head,
      completeness: report ? (missing.length === 0 ? 'complete' : 'partial') : (manifest?.completeness ?? 'partial'),
      missing,
    };
    store.saveBytes(owner, key, encoder.encode(`${JSON.stringify(next, null, 2)}\n`), 'application/json');
  }

  async function attempt(siteKey: string, s: ParsedSubmission): Promise<Outcome> {
    const assetKey = `${siteKey}/originals/asset/did.jsonl`;
    const owner = store.ownerOf(assetKey);
    const logBytes = store.readHosted(assetKey);
    const logText = logBytes ? text(logBytes) : null;
    if (!owner || logText === null || logText.trim() === '') return refuse(404, 'not_hosted');
    const lines = logText.trimEnd().split('\n');
    let head: string;
    let original: unknown;
    try {
      head = (JSON.parse(lines[lines.length - 1]) as { versionId: string }).versionId;
      original = (JSON.parse(lines[0]) as { state?: { id?: unknown } }).state?.id;
    } catch {
      return refuse(409, 'hosted_log_invalid');
    }
    if (typeof head !== 'string' || s.original !== original) return refuse(400, 'original_mismatch');

    // 1. Byte-identical to an accepted entry: its checkpoint and the current head (P6.4).
    if (lines.includes(s.entry)) {
      writeManifest(owner, siteKey, s.original, head);
      return { http: 200, body: { status: 'already-accepted', checkpoint: s.parsed.versionId, head } };
    }
    // 2. Only an entry whose parent is the head; never rebased (P6.7).
    if (!extendsHead(s.parsed, head)) return refuse(409, 'stale_parent', { status: 'stale-parent', head });

    // 3. Verify under the profile against the head.
    const candidate = [...lines, s.entry];
    const identities: AuthorDidEvidence[] = [];
    const keepIdentities: AuthorDidEvidence[] = [];
    for (const did of signerDids(candidate)) {
      const base = `${siteKey}/originals/${authorPath(did)}`;
      const storedBytes = store.readHosted(`${base}/did.jsonl`);
      const stored = storedBytes ? text(storedBytes) : null;
      const witnessBytes = store.readHosted(`${base}/did-witness.json`);
      const submitted = s.identities.find((i) => i.did === did) as (AuthorDidEvidence & { log: string }) | undefined;
      if (submitted && (stored === null || (submitted.log.startsWith(stored) && submitted.log !== stored))) {
        identities.push(submitted);
        keepIdentities.push(submitted);
      } else if (stored !== null && (!submitted || stored.startsWith(submitted.log))) {
        let witness: unknown;
        try {
          witness = witnessBytes ? JSON.parse(text(witnessBytes) ?? '') : undefined;
        } catch {
          witness = undefined;
        }
        identities.push({ did, log: stored, ...(witness !== undefined ? { witness } : {}) });
      } else if (submitted) {
        return refuse(422, 'identity_evidence_conflict', { did });
      }
    }
    const entryState = lineState(s.entry) as { transitions?: Array<{ to?: unknown }> } | undefined;
    const added = new Set((entryState?.transitions ?? []).map((t) => t.to).filter((d): d is string => typeof d === 'string'));
    for (const [digest, bytes] of s.resources) {
      if (!added.has(digest)) return refuse(422, 'resource_not_in_entry', { digest });
      if (resourceDigest(bytes) !== digest) return refuse(422, 'digest_mismatch', { digest });
    }
    const newBytes = new Map<string, Uint8Array>();
    for (const digest of added) {
      if (!DIGEST.test(digest)) return refuse(422, 'entry_invalid');
      if (store.readHosted(`${siteKey}/originals/resources/${digest}`)) continue;
      const bytes = s.resources.get(digest);
      if (!bytes) return refuse(422, 'resource_missing', { digest });
      newBytes.set(digest, bytes);
    }
    const bytesOf = (digest: string) => newBytes.get(digest) ?? (DIGEST.test(digest) ? store.readHosted(`${siteKey}/originals/resources/${digest}`) ?? undefined : undefined);
    const report = await verifyOriginal({ log: `${candidate.join('\n')}\n`, authors: identities, bytes: bytesOf, now: deps.now() });
    const ok =
      report.history.status === 'valid' && report.history.entries === candidate.length &&
      report.authorBinding.status === 'valid' && report.identityEvidence.status === 'complete' &&
      report.head === s.parsed.versionId &&
      report.resources.versions.filter((v) => v.versionId === s.parsed.versionId).every((v) => v.bytes === 'verified');
    if (!ok) return refuse(422, 'entry_invalid', { reasons: report.reasons, failure: report.history.failure ?? null });

    // 4. One synchronous step: compare the head again, then store durably and publish (P6.2).
    if (!sameBytes(store.readHosted(assetKey), logBytes)) return 'again';
    for (const [digest, bytes] of newBytes) {
      store.saveBytes(owner, `${siteKey}/originals/resources/${digest}`, bytes, signedMediaType(s.entry, digest) ?? 'application/octet-stream');
    }
    for (const identity of keepIdentities) {
      const base = `${siteKey}/originals/${authorPath(identity.did)}`;
      store.saveBytes(owner, `${base}/did.jsonl`, encoder.encode(identity.log as string), 'application/jsonl');
      if (identity.witness !== undefined) store.saveBytes(owner, `${base}/did-witness.json`, encoder.encode(JSON.stringify(identity.witness)), 'application/json');
    }
    store.saveBytes(owner, assetKey, encoder.encode(`${candidate.join('\n')}\n`), 'application/jsonl');
    writeManifest(owner, siteKey, s.original, s.parsed.versionId, report);
    return { http: 200, body: { status: 'accepted', checkpoint: s.parsed.versionId, head: s.parsed.versionId } };
  }

  /** Accept, recognise or refuse one submission for the Original hosted at `siteKey`. */
  function submit(siteKey: string, s: ParsedSubmission): Promise<Response> {
    return serialized(siteKey, async () => {
      for (let i = 0; i < 3; i++) {
        let outcome: Outcome;
        try {
          outcome = await attempt(siteKey, s);
        } catch (e) {
          const msg = (e as Error).message;
          if (msg === 'STORE_FULL') return json({ error: 'store_full' }, 507);
          return json({ error: 'store_error', message: msg }, 500);
        }
        if (outcome === 'again') continue;
        return json(outcome.body, outcome.http);
      }
      return json({ error: 'busy' }, 503, { 'Retry-After': '1' });
    });
  }

  return { submit };
}
