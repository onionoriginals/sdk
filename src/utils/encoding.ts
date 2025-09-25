export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error('Invalid hex string length');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    const byteStr = clean.substring(i, i + 2);
    const value = parseInt(byteStr, 16);
    if (Number.isNaN(value)) {
      throw new Error('Invalid hex string');
    }
    out[i / 2] = value;
  }
  return out;
}

