// Browser shim for node `crypto`, covering the hash algorithms the SDK's
// dependency graph can reach in the browser: @aviarytech/did-peer hashes the
// encoded DID document with createHash('sha256'); sha512 is included so any
// other bundled path that needs it fails soft instead of hard.
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { Buffer } from 'buffer';

const algorithms: Record<string, (data: Uint8Array) => Uint8Array> = {
  sha256,
  'sha-256': sha256,
  sha512,
  'sha-512': sha512
};

class Hash {
  private chunks: Uint8Array[] = [];

  constructor(private digestFn: (data: Uint8Array) => Uint8Array) {}

  update(data: string | Uint8Array): this {
    this.chunks.push(
      typeof data === 'string' ? new TextEncoder().encode(data) : data
    );
    return this;
  }

  digest(encoding?: string): Buffer | string {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      joined.set(c, offset);
      offset += c.length;
    }
    const out = Buffer.from(this.digestFn(joined));
    return encoding === 'hex' ? out.toString('hex') : out;
  }
}

export function createHash(algorithm: string): Hash {
  const digestFn = algorithms[algorithm.toLowerCase()];
  if (!digestFn) {
    throw new Error(
      `crypto shim (apps/landing/src/shims/crypto.ts): unsupported hash algorithm "${algorithm}" — supported: ${Object.keys(algorithms).join(', ')}`
    );
  }
  return new Hash(digestFn);
}

export default { createHash };
