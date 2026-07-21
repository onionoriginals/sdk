/**
 * SDK StorageAdapter (interface A: put/get) backed by this origin's HTTP host.
 *
 * The lifecycle's hosting writes (did.jsonl, cel.json, resources) call
 * put(`${domain}/${relativePath}`, bytes, { contentType }); we forward each to
 * PUT /api/host/<encoded key>. The returned URL is the resolvable HTTPS URL for
 * that key — for did.jsonl keys it is exactly what didwebvh-ts's resolver GETs.
 */
function toBytes(data: Buffer | Uint8Array | string): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

export class HttpHostingStorageAdapter {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts?: { baseUrl?: string; fetchImpl?: typeof fetch }) {
    // '' → same-origin relative URLs (correct in the browser).
    this.baseUrl = opts?.baseUrl ?? '';
    this.fetchImpl = opts?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private endpoint(objectKey: string): string {
    return `${this.baseUrl}/api/host/${encodeURIComponent(objectKey)}`;
  }

  async put(
    objectKey: string,
    data: Buffer | Uint8Array | string,
    options?: { contentType?: string; cacheControl?: string }
  ): Promise<string> {
    const bytes = toBytes(data);
    const res = await this.fetchImpl(this.endpoint(objectKey), {
      method: 'PUT',
      headers: { 'content-type': options?.contentType ?? 'application/octet-stream' },
      // Copy into a fresh ArrayBuffer so the body is a plain BodyInit.
      body: bytes.slice().buffer,
    });
    if (!res.ok) {
      throw new Error(`HttpHostingStorageAdapter.put failed: ${res.status} for ${objectKey}`);
    }
    // The public, resolvable URL for this key (https — matches didwebvh-ts).
    return `https://${objectKey}`;
  }

  async get(objectKey: string): Promise<{ content: Buffer; contentType: string } | null> {
    const res = await this.fetchImpl(this.endpoint(objectKey), { method: 'GET' });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`HttpHostingStorageAdapter.get failed: ${res.status} for ${objectKey}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { content: buf, contentType: res.headers.get('content-type') ?? 'application/octet-stream' };
  }
}
