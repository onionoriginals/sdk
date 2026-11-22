// Reads the did:og vectors copied from originals-spec PR 69 (tests/fixtures/og-vectors/PIN.md)
// and derives their test keys from the published seeds.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sha256 } from '@noble/hashes/sha2.js';
import { localSigner, type ProofSigner } from '../../src/crypto/index.js';

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
