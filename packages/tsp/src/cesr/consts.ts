/** CESR integer code from a base64url fragment (TSP / KERI code table). */
export function cesrInt(x: string): number {
  const bytes = new TextEncoder().encode(x);
  let acc = 0;
  for (const ch of bytes) {
    const v =
      ch >= 65 && ch <= 90
        ? ch - 65
        : ch >= 97 && ch <= 122
          ? ch - 97 + 26
          : ch >= 48 && ch <= 57
            ? ch - 48 + 52
            : ch === 45
              ? 62
              : ch === 95
                ? 63
                : (() => {
                    throw new Error('not a base64url character');
                  })();
    acc = (acc << 6) | v;
  }
  return acc;
}

/** Fixed-width CESR typecode bytes (big-endian tail of cesrInt). */
export function cesrData(x: string, length: 3): Uint8Array {
  const val = cesrInt(x);
  if (val >= 1 << (8 * length)) {
    throw new Error('typecode too wide');
  }
  const src = new Uint8Array(8);
  new DataView(src.buffer).setBigUint64(0, BigInt(val), false);
  return src.subarray(8 - length);
}

export const TSP_VERSION: readonly [major: number, minor: number] = [1, 0];
export const YTSP = cesrData('YTSP', 3);

export const TSP_PLAINTEXT = cesrInt('B');
export const TSP_SEALEDBOX_CIPHERTEXT = cesrInt('C');
export const TSP_HPKEBASE_CIPHERTEXT = cesrInt('F');
export const TSP_VID = cesrInt('B');

export const ED25519_SIGNATURE = cesrInt('B');
export const TSP_NONCE = cesrInt('A');
export const TSP_SHA256 = cesrInt('I');
export const TSP_BLAKE2B256 = cesrInt('F');

export const TSP_WRAPPER = cesrInt('E');
export const TSP_HOP_LIST = cesrInt('J');
export const TSP_PAYLOAD = cesrInt('Z');
export const TSP_ATTACH_GRP = cesrInt('C');
export const TSP_INDEX_SIG_GRP = cesrInt('K');
export const TSP_GENERIC_STREAM = cesrInt('A');

export const XSCS = cesrData('XSCS', 3);
export const XCTL = cesrData('XCTL', 3);
export const XHOP = cesrData('XHOP', 3);
export const XPAD = cesrData('XPAD', 3);
export const XRFI = cesrData('XRFI', 3);
export const XRFA = cesrData('XRFA', 3);
export const XRFD = cesrData('XRFD', 3);

/** Dummy fill for digest SAID slot during derivation (spec 7.2.1). */
export const DIGEST_DUMMY = new Uint8Array(33).fill(0x23);