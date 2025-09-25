export function encodeBase64UrlMultibase(bytes: Uint8Array): string {
  return 'z' + Buffer.from(bytes).toString('base64url');
}

export function decodeBase64UrlMultibase(s: string): Uint8Array {
  if (!s || s[0] !== 'z') {
    throw new Error('Invalid Multibase encoding');
  }
  return Buffer.from(s.slice(1), 'base64url');
}

