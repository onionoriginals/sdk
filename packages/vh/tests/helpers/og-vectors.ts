// Reads the did:og vectors copied from originals-spec PR 69 (tests/fixtures/og-vectors/PIN.md)
// and derives their test keys from the published seeds.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { localSigner, type ProofSigner } from '../../src/crypto/index.js';
import { resourceDigest } from '../../src/og/log.js';

export const VECTORS = join(import.meta.dir, '..', 'fixtures', 'og-vectors');
export const OG = join(VECTORS, 'og-1.0-draft.1');

export const vbytes = (p: string): Uint8Array => new Uint8Array(readFileSync(join(OG, p)));
export const vtext = (p: string): string => readFileSync(join(OG, p), 'utf8');
export const vjson = <T = any>(p: string): T => JSON.parse(vtext(p)) as T;
export const pbytes = (p: string): Uint8Array => new Uint8Array(readFileSync(join(VECTORS, 'prior-format', p)));
export const pjson = <T = any>(p: string): T => JSON.parse(readFileSync(join(VECTORS, 'prior-format', p), 'utf8')) as T;

/** The vector key with this label: secret SHA-256("originals-spec test vector seed: <label>"). */
export function vectorKey(label: string): ProofSigner {
  return localSigner('Ed25519', sha256(new TextEncoder().encode(`originals-spec test vector seed: ${label}`)));
}

/** Every file under a vector directory, by path relative to it. */
export function vtree(dir: string): Record<string, Uint8Array> {
  const root = join(OG, dir);
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  return Object.fromEntries(walk(root).map((p) => [relative(root, p), new Uint8Array(readFileSync(p))]));
}

export const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
export const utf8 = (s: string) => new TextEncoder().encode(s);

/** A vector's evidence-set.json, with each input's bytes read from the vector (P7.17). */
export function vectorEvidence(dir: string): import('../../src/og/index.js').EvidenceSet {
  const e = vjson(`${dir}/evidence-set.json`);
  return {
    original: e.original, checkpoint: e.checkpoint, network: e.network, tip: e.tip, depth: e.depth,
    signerHistories: e.signerHistories,
    // Each input with the digest the evidence set states for it (P7.17); index reads are supplied separately.
    inputs: e.inputs.map((i: { kind: string; source: string; digest: string }) => (i.source.startsWith('index:') ? { kind: i.kind, source: i.source, bytes: new Uint8Array() } : { kind: i.kind, source: i.source, digest: i.digest, bytes: vbytes(i.source) })),
  } as never;
}

/**
 * The bitcoin vector's evidence set (P9.18, T14-102): exactly its evidence-set.json, the sat-read input
 * and the inscription inputs; chain.json only says where each envelope's bytes are.
 */
export function bitcoinEvidence(): import('../../src/og/index.js').EvidenceSet {
  const e = vectorEvidence('bitcoin');
  const where = new Map(vjson('bitcoin/chain.json').inscriptions.map((x: any) => [`index:${x.id}`, `bitcoin/${x.envelope}`]));
  e.inputs = e.inputs.map((i: any) => (i.kind === 'inscription' ? { ...i, digest: vjson('bitcoin/evidence-set.json').inputs.find((x: any) => x.source === i.source).digest, bytes: vbytes(where.get(i.source) as string) } : i));
  return e;
}

/**
 * D22 (22 November 2026): the copied bitcoin vector predates D22, and its inscriptions still carry the
 * author's history in a `signers` member, which a reader now ignores. Until the vectors are regenerated,
 * these tests supply the vector author's log as a resolved signer history (the same log as
 * `local/author/did.jsonl`), and `resolvedExpected` patches the expected report to match: one more
 * evidence input, and the signer label's source, obtained time and freshness.
 */
export const VECTOR_AUTHOR_LOG = 'local/author/did.jsonl';
export const VECTOR_AUTHOR_OBTAINED = '2026-11-22T00:00:00Z';

export function bitcoinEvidenceResolved(): import('../../src/og/index.js').EvidenceSet {
  const e = bitcoinEvidence();
  const did = vjson('index.json').author as string;
  e.inputs = [...e.inputs, { kind: 'signer-history', source: VECTOR_AUTHOR_LOG, did, bytes: vbytes(VECTOR_AUTHOR_LOG) }];
  e.signerHistories = [{ did, source: VECTOR_AUTHOR_LOG, obtained: VECTOR_AUTHOR_OBTAINED }];
  return e;
}

export function resolvedExpected(want: any): any {
  return {
    ...want,
    evidence: { ...want.evidence, inputs: [...want.evidence.inputs, { kind: 'signer-history', source: VECTOR_AUTHOR_LOG, digest: resourceDigest(vbytes(VECTOR_AUTHOR_LOG)) }] },
    signers: want.signers.map((s: any) => ({ ...s, source: VECTOR_AUTHOR_LOG, obtained: VECTOR_AUTHOR_OBTAINED, freshness: 'not-established' })),
  };
}

/** Replace the evidence set's sat-read with an edited copy (its digest dropped, since the bytes change). */
export function withSatRead(e: import('../../src/og/index.js').EvidenceSet, edit: (r: any) => void): import('../../src/og/index.js').EvidenceSet {
  return {
    ...e,
    inputs: e.inputs.map((i: any) => {
      if (i.kind !== 'sat-read') return i;
      const r = JSON.parse(new TextDecoder().decode(i.bytes));
      edit(r);
      return { kind: i.kind, source: i.source, bytes: new TextEncoder().encode(JSON.stringify(r)) };
    }),
  };
}

/** The prior-format fixture as an evidence set: its two reveal transactions' raw bytes, as mempool.space served them (hex decoded). */
export function priorEvidence(): import('../../src/og/index.js').EvidenceSet {
  const chain = pjson('chain.json');
  return {
    original: null as never, checkpoint: null, network: 'mainnet', tip: null, depth: null,
    inputs: chain.inscriptions.map((x: any) => ({ kind: 'transaction', source: `mempool.space:${x.revealTxid}`, bytes: new Uint8Array(Buffer.from(new TextDecoder().decode(pbytes(x.transaction)).trim(), 'hex')) })),
  };
}
