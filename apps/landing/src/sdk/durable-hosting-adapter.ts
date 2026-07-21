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

export class DurableHostingStorageAdapter {
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
