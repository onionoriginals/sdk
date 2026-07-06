// Must be imported before '@originals/sdk': the SDK (like much of the
// Bitcoin ecosystem) expects a global Buffer at module-evaluation time.
import { Buffer } from 'buffer';

// The `buffer` browser polyfill doesn't implement the 'base64url' encoding
// (Node has it natively), and the SDK uses it for multibase resource URLs.
// Teach the polyfill both directions by round-tripping through base64.
const proto = Buffer.prototype as {
  toString(encoding?: string, start?: number, end?: number): string;
};
const originalToString = proto.toString;
proto.toString = function (encoding?: string, start?: number, end?: number) {
  if (encoding === 'base64url') {
    return originalToString
      .call(this, 'base64', start, end)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }
  return originalToString.call(this, encoding, start, end);
};

const originalFrom = Buffer.from.bind(Buffer);
(Buffer as { from: typeof Buffer.from }).from = ((
  value: never,
  encodingOrOffset?: never,
  length?: never
) => {
  if (typeof value === 'string' && (encodingOrOffset as unknown) === 'base64url') {
    const base64 = (value as string).replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return originalFrom(padded, 'base64');
  }
  return originalFrom(value, encodingOrOffset, length);
}) as typeof Buffer.from;

if (!(globalThis as Record<string, unknown>).Buffer) {
  (globalThis as Record<string, unknown>).Buffer = Buffer;
}
