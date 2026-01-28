export async function sha256Bytes(input: string | Uint8Array): Promise<Uint8Array> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  // Type assertion for subtle crypto which exists in modern environments
  const subtle = globalThis.crypto?.subtle as SubtleCrypto | undefined;
  if (!subtle) {
    throw new Error('SubtleCrypto not available in this environment');
  }
  // Use type assertion to handle Uint8Array<ArrayBufferLike> compatibility with SubtleCrypto
  const digest = await subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return new Uint8Array(digest);
}

