/**
 * SDK StorageAdapter (interface A: put/get) for a SIGNED-IN user's durable
 * Originals. Mirrors http-hosting-adapter.ts, but forwards writes to
 * PUT /api/originals/host/<encoded key> with the auth cookie (credentials:
 * 'same-origin') so the server persists them under the user's JWT sub. The
 * returned URL is the resolvable HTTPS URL for that key.
 */
import { library as libraryCopy } from '../content';

function toBytes(data: Buffer | Uint8Array | string): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

/** A published Original, as the account's index records it (#976 B, G3). */
export interface AccountIndexEntry {
  did: string;
  title: string;
  alias: string;
}

/**
 * The account library a publish target can reach. `DurableHostingStorageAdapter`
 * is one. Listing is main's library (`src/sdk/library.ts`, `/me`); this only
 * records a published Original and reads the account's own evidence for it.
 */
export interface AccountIndex {
  recordOriginal(entry: AccountIndexEntry & { resourceHash: string }): Promise<void>;
  /** The account's evidence package for `did`, as `/me` imports it; null when the account has none. */
  evidence(did: string): Promise<Uint8Array | null>;
}

/** The largest evidence package read back, as `fetchLibraryEvidence` caps it. */
const MAX_EVIDENCE_BYTES = 96 * 1024 * 1024;

export class DurableHostingStorageAdapter implements AccountIndex {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts?: { baseUrl?: string; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts?.baseUrl ?? '';
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private endpoint(objectKey: string): string {
    return `${this.baseUrl}/api/originals/host/${encodeURIComponent(objectKey)}`;
  }

  async put(
    objectKey: string,
    data: Buffer | Uint8Array | string,
    options?: { contentType?: string; cacheControl?: string }
  ): Promise<string> {
    const bytes = toBytes(data);
    const res = await this.fetchImpl(this.endpoint(objectKey), {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': options?.contentType ?? 'application/octet-stream' },
      body: bytes.slice().buffer,
    });
    if (!res.ok) {
      throw new Error(`DurableHostingStorageAdapter.put failed: ${res.status} for ${objectKey}`);
    }
    return `https://${objectKey}`;
  }

  /**
   * A shared-host save (./shared-host.ts): POST the submission for the
   * Original hosted at `siteKey`. Returns the status and JSON body; the
   * caller decides what is an answer and what is an error.
   */
  async submit(siteKey: string, body: string): Promise<{ status: number; body: unknown }> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/originals/submit/${encodeURIComponent(siteKey)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  /**
   * Record a published Original in the account's index (#976 B, G3), so the
   * author's other clients can find it. The index is a list, not evidence:
   * a client restores from the host and verifies what it reads.
   */
  async recordOriginal(entry: AccountIndexEntry & { resourceHash: string }): Promise<void> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/originals`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ did: entry.did, title: entry.title, resourceHash: entry.resourceHash, alias: entry.alias }),
    });
    if (!res.ok) throw new Error(`DurableHostingStorageAdapter.recordOriginal failed: ${res.status}`);
  }

  /** The account's evidence for `did` (`GET /api/originals/evidence`, main's library data path), size-capped. */
  async evidence(did: string): Promise<Uint8Array | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/originals/evidence?did=${encodeURIComponent(did)}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 404) return null;
    // Two histories, neither chosen (P6.6; #996): said as such, as fetchLibraryEvidence says it.
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message ?? libraryCopy.diverged);
    }
    if (!res.ok) throw new Error(`DurableHostingStorageAdapter.evidence failed: ${res.status}`);
    if (Number(res.headers.get('content-length')) > MAX_EVIDENCE_BYTES) throw new Error('This recovery export is too large to open here.');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_EVIDENCE_BYTES) throw new Error('This recovery export is too large to open here.');
    return bytes;
  }

  async get(objectKey: string): Promise<{ content: Buffer; contentType: string } | null> {
    const res = await this.fetchImpl(this.endpoint(objectKey), {
      method: 'GET',
      credentials: 'same-origin',
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`DurableHostingStorageAdapter.get failed: ${res.status} for ${objectKey}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { content: buf, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
  }
}
