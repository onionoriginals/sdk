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
 *                                                      asset/did.jsonl, asset/did-witness.json,
 *                                                      authors/<64 hex>/did.jsonl|did-witness.json,
 *                                                      resources/<digest>)
 *
 * Every write is inside the caller's own namespace, so no shape can shadow the
 * app's static assets or another author's files. A key holds no `%` or `\`,
 * because the store decodes it once more. The server assigns every content
 * type itself: a resource is served with the media type its descriptor
 * declares in the uploaded asset log, never a header the uploader chose
 * (P9.7). The host does not verify that log; readers do.
 *
 * A signer's DID log and witness file (authors/<64 hex>/...) only grow: a
 * replacement must extend what is stored (`signerLogVerdict`,
 * `extendsSignerWitness`), so no upload can roll back a newer DID log, and
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
  if (p.length === 2 && p[0] === 'asset' && p[1] === 'did-witness.json') return json;
  if (p.length === 3 && p[0] === 'authors' && HEX64.test(p[1]) && p[2] === 'did.jsonl') return { ...jsonl, signer: 'log', signerHex: p[1] };
  if (p.length === 3 && p[0] === 'authors' && HEX64.test(p[1]) && p[2] === 'did-witness.json') return { ...json, signer: 'witness', signerHex: p[1] };
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

/** The DID a signer DID log's genesis names, when `authors/<hex>` is that DID's directory. */
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
async function verifiedSignerLog(did: string, log: string, witness: unknown, now: number): Promise<{ ids: string[]; complete: boolean }> {
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
 * directory `authors/<hex>` (#965 review C2, r2 #6): null when it may,
 * otherwise the refusal. `next` must verify, every line, as the log of the
 * DID whose directory it is (with `witness`, the witness file the host holds
 * for it), and its versions must begin with the versions of `stored` that
 * verify. A stored log that does not verify at all can be replaced (repair);
 * an identical log is a retry. Never a rollback (P7.8).
 */
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
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

type WitnessEntry = { versionId: string; proof: unknown[] };

function witnessEntries(bytes: Uint8Array): WitnessEntry[] | null {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    if (!Array.isArray(value)) return null;
    const ok = value.every((e) => typeof e === 'object' && e !== null && typeof (e as WitnessEntry).versionId === 'string' && Array.isArray((e as WitnessEntry).proof));
    return ok ? (value as WitnessEntry[]) : null;
  } catch {
    return null;
  }
}

/**
 * True when `next` may replace the stored signer witness file `stored`:
 * every stored proof is still there, under the same versionId. A stored file
 * that is not a witness file can be replaced by one that is.
 */
export function extendsSignerWitness(stored: Uint8Array, next: Uint8Array): boolean {
  const old = witnessEntries(stored);
  const proposed = witnessEntries(next);
  if (!proposed) return false;
  if (!old) return true;
  return old.every((o) => {
    const match = proposed.find((p) => p.versionId === o.versionId);
    if (!match) return false;
    const have = new Set(match.proof.map((x) => JSON.stringify(x)));
    return o.proof.every((x) => have.has(JSON.stringify(x)));
  });
}
