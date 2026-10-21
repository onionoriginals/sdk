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
 * 3. Cheap checks come first, before any signer DID log is verified (C7,
 *    r4 #4): the entry carries one proof, by the signer it names, who is the
 *    author or holds a grant in the head's state (422 signer_not_authorized);
 *    the stored or submitted signer DID log, read without verifying it, shows
 *    the named version and key (422 identity_missing or
 *    signer_version_unavailable otherwise, r2 #8); and the proof verifies
 *    with that key (422 proof_invalid).
 *    Identity evidence for each signer is then the DID log the host would
 *    use: the verified prefix of the one it holds, or a submitted log that
 *    verifies, every line, as that DID's own log and extends that verified
 *    prefix (it also replaces a stored log that does not verify, the repair
 *    path). A submitted log that does not verify is refused (422
 *    identity_log_invalid), one that diverges too (422
 *    identity_evidence_conflict). A submitted witness file is used, and
 *    stored with the log, only when the log does not verify with the stored
 *    file and verifies completely with the submitted one, so a did:webvh 1.0
 *    file pruned to the latest proof per witness is accepted; a file that
 *    would not be written is not judged. It counts in the identity byte cap
 *    (08d review r2 #6, #7, r4 #3). The verified log must again show the
 *    named version and key, with the proof verifying. Then
 *    the head log plus the entry must verify under the profile
 *    (`verifyOriginal`: VH history, author binding and, through it, any
 *    editor rule the profile has; complete identity evidence), and every
 *    resource the entry introduces must arrive with bytes matching its
 *    digest.
 * 4. The candidate head must be current apart from freshness: an entry by a
 *    key the signer's latest DID state no longer lists (P7.9), by a
 *    deactivated DID (P6.5, P5.18), or that leaves the Original otherwise not
 *    current, can never be current and is refused (422 entry_not_current).
 *    Freshness the host cannot establish is not a refusal.
 * 5. Durable before visible (P6.2): new resource bytes and signer DID logs are
 *    written first (each an fsynced atomic replace), then the asset log, the
 *    commit point that publishes the new head, then the manifest naming it.
 *    Once the log is written the save is accepted, whatever happens to the
 *    manifest: a manifest a step behind is repaired by the next request for
 *    the Original. Resource bytes are served only once the accepted log lists
 *    them (originals-store.ts), so a save that fails before the log write
 *    publishes nothing.
 *
 * Bounds (PROVISIONAL): the body is read with a byte counter (body.ts); at
 * most MAX_IDENTITIES signer DID logs of MAX_IDENTITY_BYTES each and
 * ORIGINALS_LIMITS.resources resources per submission; at most MAX_QUEUED
 * submissions waiting per Original (503 busy past that).
 *
 * The host stores the exact submitted line. It never re-signs, rebases,
 * reorders or changes a submission, and a refused one writes nothing.
 *
 * Atomicity: one in-process queue per Original serializes submissions, and
 * the head comparison and the log replace run in one synchronous step that
 * first re-reads the log, and the signer DID logs and resources verification
 * used, so an owner's upload in between makes the submission start over
 * rather than race (P1). This assumes ONE server process per
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
import { verifyProof, type DataIntegrityProof } from '@originals/vh/crypto';
import { parseJson, isJsonObject, type JsonObject } from '@originals/vh/json';
import { vhHash } from '@originals/vh/log';
import { ORIGINALS_LIMITS, resourceDigest, verifyOriginal, type AuthorDidEvidence, type OriginalsReport } from '@originals/vh/originals';
import { authorPath } from '@originals/sdk/originals';
import { json } from './router';
import { logPrefix, parseWitnessFile, signedMediaType, verifiedSignerLog } from './hosted-layout';
import type { OriginalsStore } from './originals-store';

const DIGEST = /^z[1-9A-HJ-NP-Za-km-z]{40,60}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const VERSION_ID = /^(\d+)-(.+)$/;
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

/** PROVISIONAL bounds on one submission and on the queue for one Original. */
export const SUBMISSION_LIMITS = Object.freeze({
  /** The author and every editor a state can grant (P5.15, P7.7). */
  identities: ORIGINALS_LIMITS.editors + 1,
  identityBytes: 2 * 1024 * 1024,
  resources: ORIGINALS_LIMITS.resources,
  queued: 8,
});

/** Reasons that only say the host cannot establish freshness; any other keeps the head from being current. */
const FRESHNESS_ONLY = new Set(['asset-freshness-not-established', 'author-freshness-not-established', 'editor-freshness-not-established']);

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
  if (Object.keys(raw as Record<string, unknown>).length > SUBMISSION_LIMITS.resources) return refuse(400, 'too_many_resources');
  for (const [digest, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!DIGEST.test(digest) || typeof value !== 'string' || !BASE64.test(value)) return refuse(400, 'bad_request');
    const bytes = new Uint8Array(Buffer.from(value, 'base64'));
    if (Buffer.from(bytes).toString('base64') !== value) return refuse(400, 'bad_request');
    resources.set(digest, bytes);
  }
  const identities: AuthorDidEvidence[] = [];
  const ids = b.identities ?? [];
  if (!Array.isArray(ids)) return refuse(400, 'bad_request');
  if (ids.length > SUBMISSION_LIMITS.identities) return refuse(400, 'too_many_identities');
  for (const i of ids as Array<Record<string, unknown>>) {
    if (typeof i !== 'object' || i === null || typeof i.did !== 'string' || typeof i.log !== 'string') return refuse(400, 'bad_request');
    // The log and its witness file count together (#08d review r2 #7).
    const witnessBytes = i.witness === undefined ? 0 : encoder.encode(JSON.stringify(i.witness)).length;
    if (encoder.encode(i.log).length + witnessBytes > SUBMISSION_LIMITS.identityBytes) return refuse(413, 'identity_too_large', { did: i.did });
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

/**
 * The proof check that needs no history verification (C7): the signer's key
 * at the version the entry names, read from `log`, verifies the entry's one
 * proof. Undefined when `log` does not show that version or key, which full
 * verification then decides; false when the key is there and the proof does
 * not verify with it, which full verification would refuse too.
 */
function proofVerifies(entry: JsonObject, signer: { verificationMethod: string; versionId: string }, log: string): boolean | undefined {
  const proofs = entry.proof;
  if (!Array.isArray(proofs) || proofs.length !== 1 || !isJsonObject(proofs[0])) return false;
  const proof = proofs[0] as unknown as DataIntegrityProof;
  if (proof.verificationMethod !== signer.verificationMethod) return false;
  let document: Record<string, unknown> | undefined;
  for (const line of log.split('\n')) {
    if (!line.trim()) continue;
    try {
      const version = JSON.parse(line) as { versionId?: unknown; state?: unknown };
      if (version.versionId === signer.versionId && isJsonObject(version.state as never)) document = version.state as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  if (!document || typeof document.id !== 'string') return undefined;
  const docId = document.id;
  const methods = [document.verificationMethod, document.assertionMethod].flatMap((list) => (Array.isArray(list) ? list : []));
  const vm = methods.find((m) => isJsonObject(m as never) && typeof (m as { id?: unknown }).id === 'string' &&
    ((m as { id: string }).id === signer.verificationMethod || `${docId}${(m as { id: string }).id}` === signer.verificationMethod)) as { publicKeyMultibase?: unknown } | undefined;
  if (!vm || typeof vm.publicKeyMultibase !== 'string') return undefined;
  try {
    return verifyProof(entry, proof, vm.publicKeyMultibase);
  } catch {
    return undefined;
  }
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
  const waiting = new Map<string, number>();

  /** Run `fn` after every earlier submission for the same Original has finished; undefined when too many wait. */
  function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> | undefined {
    const count = waiting.get(key) ?? 0;
    if (count >= SUBMISSION_LIMITS.queued) return undefined;
    waiting.set(key, count + 1);
    const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn).finally(() => {
      const left = (waiting.get(key) ?? 1) - 1;
      if (left > 0) waiting.set(key, left);
      else waiting.delete(key);
    });
    const tail = run.catch(() => undefined);
    queues.set(key, tail);
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
  }

  /** A manifest write that fails is repaired later: the log is the commit point (C6). */
  function tryWriteManifest(owner: string, siteKey: string, original: string, head: string, report?: OriginalsReport): void {
    try {
      writeManifest(owner, siteKey, original, head, report);
    } catch {
      // The next request for this Original writes it again.
    }
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
    // A manifest left a step behind by an earlier save is repaired first (C6).
    tryWriteManifest(owner, siteKey, s.original, head);

    // 1. Byte-identical to an accepted entry: its checkpoint and the current head (P6.4).
    if (lines.includes(s.entry)) {
      return { http: 200, body: { status: 'already-accepted', checkpoint: s.parsed.versionId, head } };
    }
    // 2. Only an entry whose parent is the head; never rebased (P6.7).
    if (!extendsHead(s.parsed, head)) return refuse(409, 'stale_parent', { status: 'stale-parent', head });

    // 3a. Cheap checks before any signer DID log is verified (C7; #08d review r4 #4): the signer is the
    // author or granted in the head's state, and its key at the named version, in the stored or the
    // submitted signer log read without verifying it, verifies the one proof. Full verification would
    // refuse an entry failing either, so nobody can make the host verify a log for one.
    const headState = lineState(lines[lines.length - 1]) as { author?: { did?: unknown }; asset?: { editors?: Array<{ did?: unknown }> } } | undefined;
    const state = lineState(s.entry) as { author?: { did?: unknown; verificationMethod?: unknown; versionId?: unknown }; editor?: { did?: unknown; verificationMethod?: unknown; versionId?: unknown } } | undefined;
    const signer = state?.editor ?? state?.author;
    if (!signer || typeof signer.did !== 'string' || typeof signer.verificationMethod !== 'string' || typeof signer.versionId !== 'string') return refuse(422, 'entry_invalid');
    const authorized = state?.editor ? (headState?.asset?.editors ?? []).some((g) => g.did === signer.did) : signer.did === headState?.author?.did;
    if (!authorized) return refuse(422, 'signer_not_authorized', { did: signer.did });
    {
      const storedSigner = store.readHosted(`${siteKey}/originals/${authorPath(signer.did)}/did.jsonl`);
      const unverified = [s.identities.find((i) => i.did === signer.did)?.log, storedSigner ? text(storedSigner) : null].filter((l): l is string => typeof l === 'string');
      if (unverified.length === 0) return refuse(422, 'identity_missing', { did: signer.did });
      const checked = unverified.map((log) => proofVerifies(s.parsed, { verificationMethod: signer.verificationMethod as string, versionId: signer.versionId as string }, log));
      if (!checked.includes(true)) {
        if (checked.every((c) => c === undefined)) return refuse(422, 'signer_version_unavailable', { did: signer.did, versionId: signer.versionId });
        return refuse(422, 'proof_invalid');
      }
    }

    // 3. Verify under the profile against the head.
    const candidate = [...lines, s.entry];
    const identities: AuthorDidEvidence[] = [];
    /** Submitted signer DID logs verification used, to store; a witness file only where verification needed it. */
    const keepIdentities: Array<{ did: string; log: string; witness?: unknown }> = [];
    // What verification used, to compare again in the append step (P1).
    const usedFiles = new Map<string, Uint8Array | null>();
    const now = deps.now();
    for (const did of signerDids(candidate)) {
      const base = `${siteKey}/originals/${authorPath(did)}`;
      const storedBytes = store.readHosted(`${base}/did.jsonl`);
      const stored = storedBytes ? text(storedBytes) : null;
      const witnessBytes = store.readHosted(`${base}/did-witness.json`);
      usedFiles.set(`${base}/did.jsonl`, storedBytes);
      usedFiles.set(`${base}/did-witness.json`, witnessBytes);
      const storedWitness = parseWitnessFile(witnessBytes);
      // Only what of the stored log verifies counts (#965/#08d review r2 #6): junk after it is not evidence.
      const held = stored === null ? { ids: [] as string[], complete: false } : await verifiedSignerLog(did, stored, storedWitness, now);
      const heldEvidence: AuthorDidEvidence | undefined =
        stored !== null && held.ids.length > 0 ? { did, log: logPrefix(stored, held.ids.length), ...(storedWitness !== undefined ? { witness: storedWitness } : {}) } : undefined;
      const submitted = s.identities.find((i) => i.did === did) as (AuthorDidEvidence & { log: string }) | undefined;
      if (submitted) {
        // The submitted log is judged with the stored witness file first; the submitted file is used,
        // and stored, only when the log needs it and verifies with it completely (r2 #7, r4 #3). So a
        // did:webvh 1.0 file pruned to the latest proof per witness is accepted, proofs are judged by
        // verification rather than their bytes, and a file that would not be written is not judged.
        // The stored log is replaced by the submitted one with it, which extends what of the stored
        // log verified, so the stored file's proofs are never needed again.
        const withStored = await verifiedSignerLog(did, submitted.log, storedWitness, now);
        const needsWitness = !withStored.complete && submitted.witness !== undefined;
        const proposed = needsWitness ? await verifiedSignerLog(did, submitted.log, submitted.witness, now) : withStored;
        if (!proposed.complete) return refuse(422, 'identity_log_invalid', { did });
        const witness = needsWitness ? submitted.witness : storedWitness;
        const extendsHeld = held.ids.every((id, i) => proposed.ids[i] === id);
        if (!extendsHeld && !proposed.ids.every((id, i) => held.ids[i] === id)) return refuse(422, 'identity_evidence_conflict', { did });
        if (extendsHeld && (proposed.ids.length > held.ids.length || !held.complete)) {
          identities.push({ did, log: submitted.log, ...(witness !== undefined ? { witness } : {}) });
          keepIdentities.push({ did, log: submitted.log, ...(needsWitness ? { witness: submitted.witness } : {}) });
          continue;
        }
        // The submitted log is what the host holds, or a prefix of it: the host's is used.
      }
      if (heldEvidence) identities.push(heldEvidence);
    }
    // 3b. The signer DID log verification uses must show the named version and key (#08d review r2 #8).
    const signerLog = identities.find((i) => i.did === signer.did)?.log;
    if (typeof signerLog !== 'string') return refuse(422, 'identity_missing', { did: signer.did });
    const verifies = proofVerifies(s.parsed, { verificationMethod: signer.verificationMethod, versionId: signer.versionId }, signerLog);
    if (verifies === undefined) return refuse(422, 'signer_version_unavailable', { did: signer.did, versionId: signer.versionId });
    if (verifies === false) return refuse(422, 'proof_invalid');

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
    // 4. Never accept a head that can never be current (P7.9, P6.5, P5.18); freshness alone is no refusal.
    const blocking = report.reasons.filter((r) => !FRESHNESS_ONLY.has(r));
    if (blocking.length > 0) return refuse(422, 'entry_not_current', { reasons: blocking });

    // 5. One synchronous step: compare the head, the signer DID logs and the resources verification
    // used again (P1), then store durably and publish (P6.2).
    if (!sameBytes(store.readHosted(assetKey), logBytes)) return 'again';
    for (const [key, used] of usedFiles) {
      const now = store.readHosted(key);
      if (now === null ? used !== null : used === null || !sameBytes(now, used)) return 'again';
    }
    for (const digest of added) {
      if (!newBytes.has(digest) && !store.readHosted(`${siteKey}/originals/resources/${digest}`)) return 'again';
    }
    for (const [digest, bytes] of newBytes) {
      store.saveBytes(owner, `${siteKey}/originals/resources/${digest}`, bytes, signedMediaType(s.entry, digest) ?? 'application/octet-stream');
    }
    for (const identity of keepIdentities) {
      const base = `${siteKey}/originals/${authorPath(identity.did)}`;
      store.saveBytes(owner, `${base}/did.jsonl`, encoder.encode(identity.log), 'application/jsonl');
      if (identity.witness !== undefined) store.saveBytes(owner, `${base}/did-witness.json`, encoder.encode(JSON.stringify(identity.witness)), 'application/json');
    }
    store.saveBytes(owner, assetKey, encoder.encode(`${candidate.join('\n')}\n`), 'application/jsonl');
    // The log write was the commit point: from here the save is accepted (C6).
    tryWriteManifest(owner, siteKey, s.original, s.parsed.versionId, report);
    return { http: 200, body: { status: 'accepted', checkpoint: s.parsed.versionId, head: s.parsed.versionId } };
  }

  /** Accept, recognise or refuse one submission for the Original hosted at `siteKey`. */
  function submit(siteKey: string, s: ParsedSubmission): Promise<Response> {
    const queued = serialized(siteKey, async () => {
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
    return queued ?? Promise.resolve(json({ error: 'busy' }, 503, { 'Retry-After': '1' }));
  }

  return { submit };
}
