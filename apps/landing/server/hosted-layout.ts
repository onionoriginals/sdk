/**
 * The keys a signed-in author may write to the durable host, and the content
 * type each is served with (plan 011, PR 8; layout from @originals/sdk's
 * hostedFiles, PROVISIONAL).
 *
 *   <host>/<user-slug>/did.jsonl                       the author's own did:webvh
 *   <host>/<user-slug>/o-<name>/did.jsonl              an Original's did:webvh alias
 *   <host>/<user-slug>/o-<name>/did-witness.json       its did:webvh witness file
 *   <host>/<user-slug>/o-<name>/originals/<file>       the Original's evidence package,
 *                                                      unpacked (originals-evidence.json,
 *                                                      asset/did.jsonl,
 *                                                      signers/<64 hex>/did.jsonl|did-witness.json,
 *                                                      resources/<digest>)
 *
 * P14.10, and P14.11 (PROVISIONAL, section 14): each signer
 * DID's history is under `signers/<hex sha256 of the DID>/`, and there is no
 * asset witness file, since asset logs have no witnesses (P9.8). Neither
 * `authors/` nor `asset/did-witness.json` is part of the layout.
 *
 * Every write is inside the caller's own namespace, so no shape can shadow the
 * app's static assets or another author's files. A key holds no `%` or `\`,
 * because the store decodes it once more. The server assigns every content
 * type itself: a resource is served with the media type its descriptor
 * declares in the uploaded asset log, never a header the uploader chose
 * (P9.7). The host does not verify a log uploaded here; readers do. An
 * uploaded asset log may only extend the stored one, and saves from several
 * signers go through the verifying submit route instead (shared-saves.ts).
 *
 * A signer's DID log and witness file (signers/<64 hex>/...) only grow: a
 * replacement must extend what is stored (`signerLogVerdict`,
 * `signerWitnessVerdict`), so no upload can roll back a newer DID log, and
 * with it a key removal or deactivation, that a save stored (P7.8). A signer
 * DID log is judged by verification, not bytes: it must verify as the log of
 * the DID its directory names, with the witness file the host holds for it,
 * and extend the verified prefix of the stored log. So a log with junk
 * appended is refused, and a stored log that does not verify, or verifies
 * only in part, can be replaced by a verified one that extends what of it
 * does verify (#965 review r2 #6). Upload a witnessed DID's witness file
 * before its log.
 */
import { createHash } from 'node:crypto';
import { canonicalize, type JsonValue } from '@originals/vh/json';
import { resourceDigest, verifyAuthorHistory } from '@originals/vh/originals';

const NAME = /^o-[1-9A-HJ-NP-Za-km-z]{16}$/;
const DIGEST = /^z[1-9A-HJ-NP-Za-km-z]{40,60}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST = new RegExp(`^${LABEL}(?:\\.${LABEL})*(?::\\d{1,5})?$`, 'i');
// A bare `type/subtype` (RFC 6838 restricted names), with no parameters.
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;

export type HostedKey =
  | { kind: 'identity-log' }
  | { kind: 'alias-log' | 'alias-witness' }
  | { kind: 'evidence'; contentType: string; signer?: 'log' | 'witness'; signerHex?: string }
  | { kind: 'resource'; digest: string; assetLogKey: string };

/** Classify `key` for the author whose namespace is `slug`, or null when it is not a hosted file of theirs. */
export function classifyHostedKey(key: string, slug: string): HostedKey | null {
  if (/[%\\]/.test(key)) return null;
  const [host, ns, ...rest] = key.split('/');
  if (!host || !HOST.test(host) || ns !== slug || rest.length === 0) return null;
  if (rest.length === 1 && rest[0] === 'did.jsonl') return { kind: 'identity-log' };
  const [name, ...file] = rest;
  if (!NAME.test(name)) return null;
  if (file.length === 1 && file[0] === 'did.jsonl') return { kind: 'alias-log' };
  if (file.length === 1 && file[0] === 'did-witness.json') return { kind: 'alias-witness' };
  if (file[0] !== 'originals') return null;
  const p = file.slice(1);
  const json = { kind: 'evidence' as const, contentType: 'application/json' };
  const jsonl = { kind: 'evidence' as const, contentType: 'application/jsonl' };
  if (p.length === 1 && p[0] === 'originals-evidence.json') return json;
  if (p.length === 2 && p[0] === 'asset' && p[1] === 'did.jsonl') return jsonl;
  if (p.length === 3 && p[0] === 'signers' && HEX64.test(p[1]) && p[2] === 'did.jsonl') return { ...jsonl, signer: 'log', signerHex: p[1] };
  if (p.length === 3 && p[0] === 'signers' && HEX64.test(p[1]) && p[2] === 'did-witness.json') return { ...json, signer: 'witness', signerHex: p[1] };
  if (p.length === 2 && p[0] === 'resources' && DIGEST.test(p[1])) {
    return { kind: 'resource', digest: p[1], assetLogKey: [host, ns, name, 'originals', 'asset', 'did.jsonl'].join('/') };
  }
  return null;
}

/** The content type the server assigns to a non-resource file. */
export function hostedContentType(k: Exclude<HostedKey, { kind: 'resource' }>): string {
  if (k.kind === 'evidence') return k.contentType;
  return k.kind === 'alias-witness' ? 'application/json' : 'application/jsonl';
}

/**
 * The media type the uploaded asset log's descriptors give `digest`, or null
 * when no entry lists it or the latest one is not a bare `type/subtype`. The
 * host does not verify the log; the public reader does. This only decides how
 * the host labels bytes it already holds.
 */
export function signedMediaType(assetLog: string, digest: string): string | null {
  let found: string | null = null;
  for (const line of assetLog.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { state?: { asset?: { resources?: Array<{ digest?: unknown; mediaType?: unknown }> } } };
      for (const r of entry.state?.asset?.resources ?? []) {
        if (r.digest === digest) found = typeof r.mediaType === 'string' && MEDIA_TYPE.test(r.mediaType) ? r.mediaType : null;
      }
    } catch {
      return null;
    }
  }
  return found;
}

/** True when `bytes` are the bytes `digest` names. */
export function bytesMatchDigest(bytes: Uint8Array, digest: string): boolean {
  return resourceDigest(bytes) === digest;
}

/** The DID a signer DID log's genesis names, when `signers/<hex>` is that DID's directory. */
function signerDidOf(text: string, hex: string): string | null {
  try {
    const first = JSON.parse(text.split('\n', 1)[0]) as { state?: { id?: unknown } };
    const did = first?.state?.id;
    return typeof did === 'string' && createHash('sha256').update(did).digest('hex') === hex ? did : null;
  } catch {
    return null;
  }
}

/** The versionIds of `log` that verify as `did`'s own log from its genesis, and whether all of it does. */
export async function verifiedSignerLog(did: string, log: string, witness: unknown, now: number): Promise<{ ids: string[]; complete: boolean }> {
  try {
    const h = await verifyAuthorHistory({ did, log, ...(witness !== undefined ? { witness } : {}) }, { now });
    return { ids: h.versions.map((v) => v.versionId), complete: !h.failure && h.versions.length > 0 };
  } catch {
    return { ids: [], complete: false }; // a method this host cannot verify a log of
  }
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Whether `next` may replace the stored signer DID log `stored` in the
 * directory `signers/<hex>` (#965 review C2, r2 #6): null when it may,
 * otherwise the refusal. `next` must verify, every line, as the log of the
 * DID whose directory it is (with `witness`, the witness file the host holds
 * for it), and its versions must begin with the versions of `stored` that
 * verify. A stored log that does not verify at all can be replaced (repair);
 * an identical log is a retry. Never a rollback (P7.8).
 */
/** The first `count` lines of a JSONL log, newline-terminated: a log's verified prefix. */
export function logPrefix(log: string, count: number): string {
  const lines = log.split('\n').filter((l) => l.trim() !== '');
  return count === 0 ? '' : `${lines.slice(0, count).join('\n')}\n`;
}

export async function signerLogVerdict(
  stored: Uint8Array | null,
  next: Uint8Array,
  hex: string,
  witness: unknown,
  now = Date.now(),
): Promise<null | 'identity_log_invalid' | 'identity_log_not_extending'> {
  const text = decodeText(next);
  const did = text === null ? null : signerDidOf(text, hex);
  if (text === null || did === null) return 'identity_log_invalid';
  const proposed = await verifiedSignerLog(did, text, witness, now);
  if (!proposed.complete) return 'identity_log_invalid';
  const storedText = stored ? decodeText(stored) : null;
  if (storedText === null) return null;
  const kept = (await verifiedSignerLog(did, storedText, witness, now)).ids;
  return kept.every((id, i) => proposed.ids[i] === id) ? null : 'identity_log_not_extending';
}

/** The witness file the host holds next to a signer DID log, parsed, or undefined. */
export function parseWitnessFile(bytes: Uint8Array | null): unknown {
  if (!bytes) return undefined;
  const text = decodeText(bytes);
  if (text === null) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return deeperThan(value, MAX_WITNESS_DEPTH) ? undefined : value; // never handed to the engine (#965 r5, finding 3)
  } catch {
    return undefined;
  }
}

type WitnessEntry = { versionId: string; proof: unknown[] };

/**
 * The nesting a witness file may have: the default depth limit of the strict
 * JSON layer in @originals/vh. A legitimate file nests a handful of levels;
 * a deeper one could overflow the stack when canonicalised (#965 r5, finding 3).
 */
export const MAX_WITNESS_DEPTH = 64;

/** True when `value` nests arrays and objects more than `max` levels deep (iterative, so it never overflows). */
export function deeperThan(value: unknown, max: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length > 0) {
    const [v, d] = stack.pop()!;
    if (typeof v !== 'object' || v === null) continue;
    if (d + 1 > max) return true;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, d + 1]);
  }
  return false;
}

/**
 * The entries of a witness file in the shape the engine accepts (exactly
 * `{ versionId, proof }`; anything else makes it reject the whole file), null,
 * or 'too_deep' when it nests beyond MAX_WITNESS_DEPTH.
 */
function witnessEntries(bytes: Uint8Array): WitnessEntry[] | null | 'too_deep' {
  const text = decodeText(bytes);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    if (deeperThan(value, MAX_WITNESS_DEPTH)) return 'too_deep';
    if (!Array.isArray(value)) return null;
    const ok = value.every(
      (e) =>
        typeof e === 'object' && e !== null && !Array.isArray(e) && Object.keys(e).length === 2 &&
        typeof (e as WitnessEntry).versionId === 'string' && Array.isArray((e as WitnessEntry).proof),
    );
    return ok ? (value as WitnessEntry[]) : null;
  } catch {
    return null;
  }
}

/** A proof's JCS form, so the same proof with its members in another order is the same proof. */
let unserialisable = 0;
function canonicalProof(proof: unknown): string {
  try {
    return canonicalize(proof as JsonValue);
  } catch {
    try {
      return `\u0000${JSON.stringify(proof)}`; // not JCS-serialisable: never equal to a canonical proof
    } catch {
      return `\u0001${unserialisable++}`; // not serialisable at all: equal to nothing, and never a throw
    }
  }
}

/** True when every proof of `old` is in `next` under the same versionId (canonically). */
function containsProofs(next: WitnessEntry[], old: WitnessEntry[]): boolean {
  const have = new Map<string, Set<string>>();
  for (const e of next) {
    const set = have.get(e.versionId) ?? new Set<string>();
    for (const p of e.proof) set.add(canonicalProof(p));
    have.set(e.versionId, set);
  }
  return old.every((o) => {
    const set = have.get(o.versionId);
    return set !== undefined && o.proof.every((p) => set.has(canonicalProof(p)));
  });
}

/** `stored` with `next`'s proofs added, per versionId, without canonical duplicates. */
function mergeWitness(stored: WitnessEntry[], next: WitnessEntry[]): WitnessEntry[] {
  const out = new Map<string, { proof: unknown[]; seen: Set<string> }>();
  for (const e of [...stored, ...next]) {
    const slot = out.get(e.versionId) ?? { proof: [], seen: new Set<string>() };
    for (const p of e.proof) {
      const c = canonicalProof(p);
      if (slot.seen.has(c)) continue;
      slot.seen.add(c);
      slot.proof.push(p);
    }
    out.set(e.versionId, slot);
  }
  return [...out].map(([versionId, { proof }]) => ({ versionId, proof }));
}

/**
 * What to store when `next` is uploaded as the witness file of the signer DID
 * whose directory is `signers/<hex>` (#965 review r4, finding 3), or the
 * refusal. A witness file never weakens the verification of the stored signer
 * log (P7.8), and is judged by the proofs it carries, not their bytes:
 *
 * - `next` must be a witness file the engine accepts;
 * - it is stored as uploaded when it holds every stored proof (compared by
 *   JCS), or when the stored log verifies with it at least as far as with the
 *   stored file: so a did:webvh 1.0 file pruned to the latest proof per
 *   witness is accepted once the log it approves is stored;
 * - otherwise, when it adds a proof, the host stores the stored file with
 *   `next`'s proofs added (a pruned file uploaded before the log it approves),
 *   within `maxBytes`. A file that adds nothing and would weaken is refused.
 */
export async function signerWitnessVerdict(
  storedWitness: Uint8Array | null,
  next: Uint8Array,
  storedLog: Uint8Array | null,
  hex: string,
  options: { maxBytes: number; now?: number },
): Promise<{ write: Uint8Array } | { error: 'identity_witness_not_extending' | 'identity_witness_too_large' | 'identity_witness_invalid' }> {
  const proposed = witnessEntries(next);
  if (proposed === 'too_deep') return { error: 'identity_witness_invalid' };
  if (!proposed) return { error: 'identity_witness_not_extending' };
  const storedEntries = storedWitness ? witnessEntries(storedWitness) : null;
  const old = storedEntries === 'too_deep' ? null : storedEntries;
  if (!old || containsProofs(proposed, old)) return { write: next };
  const logText = storedLog ? decodeText(storedLog) : null;
  const did = logText === null ? null : signerDidOf(logText, hex);
  if (logText !== null && did !== null) {
    const now = options.now ?? Date.now();
    const kept = (await verifiedSignerLog(did, logText, old, now)).ids;
    const withNext = (await verifiedSignerLog(did, logText, proposed, now)).ids;
    if (kept.every((id, i) => withNext[i] === id)) return { write: next };
  }
  const merged = mergeWitness(old, proposed);
  if (containsProofs(old, merged)) return { error: 'identity_witness_not_extending' }; // adds nothing
  const bytes = new TextEncoder().encode(JSON.stringify(merged));
  return bytes.length > options.maxBytes ? { error: 'identity_witness_too_large' } : { write: bytes };
}
