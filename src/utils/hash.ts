export async function sha256Bytes(input: string | Uint8Array): Promise<Uint8Array> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await (globalThis.crypto as any).subtle.digest('SHA-256', data);
  return new Uint8Array(digest);
}

