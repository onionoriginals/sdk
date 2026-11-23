import { base64urlnopad as base64url } from '@scure/base';

const T_DOMAIN = 0x20;

/**
 * CESR on the wire is base64url text (UTF-8). Decode to the binary triplet stream.
 */
export function cesrToBinary(data: Uint8Array): Uint8Array {
  const first = data[0];
  if (first === undefined) {
    throw new Error('empty message');
  }
  if ((first >> 5) === 0b001) {
    return base64url.decode(new TextDecoder().decode(data));
  }
  if ((first >> 5) === 0b111) {
    return data;
  }
  throw new Error('unrecognized CESR domain');
}

export function cesrFromBinary(data: Uint8Array): Uint8Array {
  const encoded = base64url.encode(data);
  return new TextEncoder().encode(encoded);
}