const D0 = 52;
const DASH = 62;

function bits(value: number, width: number): number {
  const mask = (1 << width) - 1;
  if (value > mask) {
    throw new Error(`${value} exceeds ${width}-bit field`);
  }
  return value & mask;
}

function pushWord(word: number, hdrBytes: number, stream: number[]): void {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, word, false);
  for (let i = 1; i <= hdrBytes; i++) {
    stream.push(buf[i]!);
  }
}

export function encodeFixedData(identifier: number, payload: Uint8Array, stream: number[]): void {
  const totalSize = Math.ceil((payload.length + 1) / 3) * 3;
  const hdrBytes = totalSize - payload.length;

  let word: number;
  if (hdrBytes === 1) {
    word = bits(identifier, 6) << 18;
  } else if (hdrBytes === 2) {
    word = (D0 << 18) | (bits(identifier, 6) << 12);
  } else if (hdrBytes === 3) {
    word = ((D0 + 1) << 18) | bits(identifier, 18);
  } else {
    throw new Error('invalid fixed data padding');
  }

  pushWord(word, hdrBytes, stream);
  for (const b of payload) stream.push(b);
}

export function encodeIndexedData(
  identifier: number,
  index: number,
  payload: Uint8Array,
  stream: number[],
): void {
  const totalSize = Math.ceil((payload.length + 1) / 3) * 3;
  const hdrBytes = totalSize - payload.length;
  if (hdrBytes === 1) {
    throw new Error('indexed type cannot have 1 lead byte');
  }

  let word: number;
  if (hdrBytes === 2) {
    word = (bits(identifier, 6) << 18) | (bits(index, 6) << 12);
  } else if (hdrBytes === 3) {
    word = (D0 << 18) | (bits(identifier, 6) << 12) | bits(index, 12);
  } else {
    throw new Error('invalid indexed padding');
  }

  pushWord(word, hdrBytes, stream);
  for (const b of payload) stream.push(b);
}

export function encodeVariableData(identifier: number, payload: Uint8Array, stream: number[]): void {
  const paddedSize = Math.ceil(payload.length / 3) * 3;
  const leadBytes = paddedSize - payload.length;
  const selector = D0 + 4 + leadBytes;
  const size = Math.floor(paddedSize / 3);

  if (size < 64 * 64 && identifier < 64) {
    const word = (bits(selector, 6) << 18) | (bits(identifier, 6) << 12) | bits(size, 12);
    pushWord(word, 3, stream);
  } else {
    const word = (bits(selector + 3, 6) << 18) | bits(identifier, 18);
    pushWord(word, 3, stream);
    pushWord(bits(size, 24), 3, stream);
  }

  for (let i = 0; i < leadBytes; i++) stream.push(0);
  for (const b of payload) stream.push(b);
}

export function encodeCount(identifier: number, count: number, stream: number[]): void {
  if (count < 4096) {
    const word = (DASH << 18) | (bits(identifier, 6) << 12) | bits(count, 12);
    pushWord(word, 3, stream);
  } else {
    const word1 = (DASH << 18) | (DASH << 12) | (bits(identifier, 6) << 6) | bits(count >> 24, 6);
    const word2 = bits(count, 24);
    pushWord(word1, 3, stream);
    pushWord(word2, 3, stream);
  }
}

export function bytesFromNumberStream(stream: number[]): Uint8Array {
  return Uint8Array.from(stream);
}