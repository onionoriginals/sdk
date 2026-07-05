// Browser shim for node `crypto`, covering the one call the demo path
// actually exercises: @aviarytech/did-peer hashes the encoded DID document
// with createHash('sha256').update(data).digest().
import { sha256 } from '@noble/hashes/sha2.js';
import { Buffer } from 'buffer';

class Hash {
  private chunks: Uint8Array[] = [];

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
    const out = Buffer.from(sha256(joined));
    return encoding === 'hex' ? out.toString('hex') : out;
  }
}

export function createHash(algorithm: string): Hash {
  if (algorithm !== 'sha256') {
    throw new Error(`crypto shim only supports sha256, got ${algorithm}`);
  }
  return new Hash();
}

export default { createHash };
