const D0 = 52;
const DASH = 62;

function mask(n: number): number {
  return (1 << n) - 1;
}

function extractTriplet(quadlet: Uint8Array): number {
  return (quadlet[0]! << 16) | (quadlet[1]! << 8) | quadlet[2]!;
}

function headerMatch(input: Uint8Array, target: Uint8Array): boolean {
  if (input.length !== target.length) return false;
  for (let i = 0; i < input.length; i++) {
    if (input[i] !== target[i]) return false;
  }
  return true;
}

function bits(value: number, width: number): number {
  return value & mask(width);
}

function wordBytes(word: number, hdrBytes: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, word, false);
  return buf.subarray(1, 1 + hdrBytes);
}

export function decodeFixedData(
  identifier: number,
  stream: Uint8Array,
  nbytes: number,
): { value: Uint8Array; rest: Uint8Array } | null {
  const totalSize = Math.ceil((nbytes + 1) / 3) * 3;
  const hdrBytes = totalSize - nbytes;

  let word: number;
  if (hdrBytes === 1) {
    word = bits(identifier, 6) << 18;
  } else if (hdrBytes === 2) {
    word = (D0 << 18) | (bits(identifier, 6) << 12);
  } else if (hdrBytes === 3) {
    word = ((D0 + 1) << 18) | bits(identifier, 18);
  } else {
    return null;
  }

  const hdr = stream.subarray(0, hdrBytes);
  if (!headerMatch(hdr, wordBytes(word, hdrBytes))) {
    return null;
  }
  if (stream.length < totalSize) return null;
  const value = stream.subarray(hdrBytes, totalSize);
  if (value.length !== nbytes) return null;
  return { value, rest: stream.subarray(totalSize) };
}

export function decodeVariableDataIndex(
  identifier: number,
  stream: Uint8Array,
  pos: number,
): { range: [number, number]; next: number } | null {
  const slice = stream.subarray(pos);
  if (slice.length < 3) return null;
  const input = extractTriplet(slice.subarray(0, 3));
  const selector = input >> 18;

  let foundId: number;
  let size: number;
  let offset: number;

  if (selector === D0 + 4 || selector === D0 + 5 || selector === D0 + 6) {
    foundId = (input >> 12) & mask(6);
    size = input & mask(12);
    offset = selector - (D0 + 4);
  } else if (selector === D0 + 7 || selector === D0 + 8 || selector === D0 + 9) {
    if (slice.length < 6) return null;
    foundId = input & mask(18);
    size = extractTriplet(slice.subarray(3, 6));
    offset = selector - (D0 + 4);
  } else {
    return null;
  }

  if (foundId !== identifier) return null;

  const dataBegin = offset + 3;
  const dataEnd = Math.ceil((offset + 1) / 3) * 3 + 3 * size;
  if (slice.length < dataEnd) return null;

  const codeLen = selector >= D0 + 7 ? 6 : 3;
  const padding = slice.subarray(codeLen, dataBegin);
  for (const b of padding) {
    if (b !== 0) return null;
  }

  const originStart = pos + dataBegin;
  const originEnd = pos + dataEnd;
  return { range: [originStart, originEnd], next: originEnd };
}

export function decodeVariableData(
  identifier: number,
  stream: Uint8Array,
): { value: Uint8Array; rest: Uint8Array } | null {
  const found = decodeVariableDataIndex(identifier, stream, 0);
  if (!found) return null;
  return {
    value: stream.subarray(found.range[0], found.range[1]),
    rest: stream.subarray(found.next),
  };
}

export function decodeIndexedData(
  identifier: number,
  stream: Uint8Array,
  nbytes: number,
): { index: number; value: Uint8Array; rest: Uint8Array } | null {
  const totalSize = Math.ceil((nbytes + 1) / 3) * 3;
  const hdrBytes = totalSize - nbytes;
  if (stream.length < 3) return null;

  const input = extractTriplet(stream.subarray(0, 3));
  let index: number;
  let word: number;

  if (hdrBytes === 2) {
    index = (input >> 12) & mask(6);
    word = (bits(identifier, 6) << 18) | (bits(index, 6) << 12);
  } else if (hdrBytes === 3) {
    index = input & mask(12);
    word = (D0 << 18) | (bits(identifier, 6) << 12) | bits(index, 12);
  } else {
    return null;
  }

  const hdr = stream.subarray(0, hdrBytes);
  if (!headerMatch(hdr, wordBytes(word, hdrBytes))) {
    return null;
  }
  if (stream.length < totalSize) return null;
  return {
    index,
    value: stream.subarray(hdrBytes, totalSize),
    rest: stream.subarray(totalSize),
  };
}

export function decodeCount(
  identifier: number,
  stream: Uint8Array,
): { count: number; rest: Uint8Array } | null {
  if (stream.length < 3) return null;
  const word = extractTriplet(stream.subarray(0, 3));
  const index = word & mask(12);
  const expected = (DASH << 18) | (bits(identifier, 6) << 12) | bits(index, 12);
  const expectedLong = (DASH << 18) | (DASH << 12) | (bits(identifier, 6) << 6) | bits(index & 0x3f, 6);

  if (word === expected) {
    return { count: index, rest: stream.subarray(3) };
  }
  if (word === expectedLong) {
    if (stream.length < 6) return null;
    const next = extractTriplet(stream.subarray(3, 6));
    return { count: ((index & 0x3f) << 24) | next, rest: stream.subarray(6) };
  }
  return null;
}