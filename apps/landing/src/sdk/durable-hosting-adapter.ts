/**
 * SDK StorageAdapter (interface A: put/get) for a SIGNED-IN user's durable
 * Originals. Mirrors http-hosting-adapter.ts, but forwards writes to
 * PUT /api/originals/host/<encoded key> with the auth cookie (credentials:
 * 'same-origin') so the server persists them under the user's JWT sub. The
 * returned URL is the resolvable HTTPS URL for that key.
 */
function toBytes(data: Buffer | Uint8Array | string): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

/** A published Original in the signed-in account's index. */
export interface AccountIndexEntry {
  did: string;
  title: string;
  alias: string;
}

/** The account index a publish target can keep. `DurableHostingStorageAdapter` is one. */
export interface AccountIndex {
  recordOriginal(entry: AccountIndexEntry & { resourceHash: string }): Promise<void>;
  listOriginals(): Promise<AccountIndexEntry[]>;
}

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

  /** The account's published Originals that carry an alias. */
  async listOriginals(): Promise<AccountIndexEntry[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/originals`, { method: 'GET', credentials: 'same-origin' });
    if (!res.ok) throw new Error(`DurableHostingStorageAdapter.listOriginals failed: ${res.status}`);
    const body = (await res.json()) as { originals?: Array<{ did?: unknown; title?: unknown; alias?: unknown }> };
    return (body.originals ?? []).flatMap((o) =>
      typeof o.did === 'string' && typeof o.title === 'string' && typeof o.alias === 'string' ? [{ did: o.did, title: o.title, alias: o.alias }] : [],
    );
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
