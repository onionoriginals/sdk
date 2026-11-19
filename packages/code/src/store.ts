/**
 * Content-addressed object stores (plan 049 §3, phase 1). Objects are kept by
 * digest, so a blob or tree shared by many versions is stored once. A store
 * checks bytes against their digest when they are put (P4.3), and never holds
 * bytes under another digest.
 */
import { objectDigestAsync, type ObjectSource } from "./objects.js";
import { codeError } from "./errors.js";

export interface ObjectStore {
  get(digest: string): Promise<Uint8Array | undefined>;
  has(digest: string): Promise<boolean>;
  /** Store bytes under their digest; bytes that do not match it are refused (OBJECT_DIGEST_MISMATCH). Idempotent. */
  put(digest: string, bytes: Uint8Array): Promise<void>;
}

/** Refuse bytes whose digest is not `digest` (P4.3). */
export async function checkObject(digest: string, bytes: Uint8Array): Promise<void> {
  const actual = await objectDigestAsync(bytes);
  if (actual !== digest) codeError("invalid-evidence", "OBJECT_DIGEST_MISMATCH", `object bytes hash to ${actual}, not ${digest}`, { digest, actual });
}

/** An in-memory store. It keeps private copies and hands out copies. */
export class MemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, Uint8Array>();

  get size(): number {
    return this.objects.size;
  }

  /** Total bytes held. */
  get bytes(): number {
    let n = 0;
    for (const b of this.objects.values()) n += b.length;
    return n;
  }

  digests(): string[] {
    return [...this.objects.keys()].sort();
  }

  get(digest: string): Promise<Uint8Array | undefined> {
    const b = this.objects.get(digest);
    return Promise.resolve(b ? b.slice() : undefined);
  }

  has(digest: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(digest));
  }

  async put(digest: string, bytes: Uint8Array): Promise<void> {
    if (this.objects.has(digest)) return;
    const copy = bytes.slice();
    await checkObject(digest, copy);
    this.objects.set(digest, copy);
  }
}

/** The `ObjectSource` view of stores tried in order. */
export function sourceOf(...stores: Array<Pick<ObjectStore, "get">>): ObjectSource {
  return async (digest) => {
    for (const s of stores) {
      const b = await s.get(digest);
      if (b) return b;
    }
    return undefined;
  };
}
