import { gzipSync, gunzipSync, inflateSync } from 'node:zlib';
import { MAX_DECOMPRESSED_BITSTRING_BYTES } from './StatusListManager.js';

const MINIMUM_LIST_SIZE = 131072; // 16KB = 131072 bits per W3C spec recommendation

/**
 * W3C Bitstring Status List implementation.
 *
 * A compressed bitstring where each bit position represents the status of a
 * credential. A bit value of 1 means the status purpose applies (e.g. revoked
 * or suspended). A bit value of 0 means it does not.
 *
 * @see https://www.w3.org/TR/vc-bitstring-status-list/
 */
export class BitstringStatusList {
  private bits: Uint8Array;
  readonly length: number;

  /**
   * @param length - Number of bit positions in the list (must be >= 131072)
   */
  constructor(length: number = MINIMUM_LIST_SIZE) {
    if (length < MINIMUM_LIST_SIZE) {
      throw new Error(
        `Status list length must be at least ${MINIMUM_LIST_SIZE} to preserve holder privacy`
      );
    }
    this.length = length;
    this.bits = new Uint8Array(Math.ceil(length / 8));
  }

  /**
   * Set a bit position (mark credential as revoked/suspended)
   */
  set(index: number): void {
    this.validateIndex(index);
    const byteIndex = Math.floor(index / 8);
    const bitIndex = 7 - (index % 8); // MSB first per spec
    this.bits[byteIndex] |= 1 << bitIndex;
  }

  /**
   * Clear a bit position (un-suspend a credential)
   */
  clear(index: number): void {
    this.validateIndex(index);
    const byteIndex = Math.floor(index / 8);
    const bitIndex = 7 - (index % 8);
    this.bits[byteIndex] &= ~(1 << bitIndex);
  }

  /**
   * Get the value of a bit position
   * @returns true if the bit is set (credential is revoked/suspended)
   */
  get(index: number): boolean {
    this.validateIndex(index);
    const byteIndex = Math.floor(index / 8);
    const bitIndex = 7 - (index % 8);
    return (this.bits[byteIndex] & (1 << bitIndex)) !== 0;
  }

  /**
   * Encode the bitstring per the W3C Bitstring Status List specification:
   * multibase base64url ('u' prefix) of the GZIP-compressed bitstring.
   * Matches StatusListManager.encodeBitstring, so lists produced here are
   * readable by any spec-compliant consumer.
   */
  encode(): string {
    const compressed = gzipSync(Buffer.from(this.bits));
    return 'u' + base64urlEncode(compressed);
  }

  /**
   * Decode a W3C encoded bitstring ('u'-multibase base64url + GZIP).
   * Legacy values produced by earlier SDK versions (bare base64url of
   * DEFLATE data) are still accepted.
   */
  static decode(encoded: string, length?: number): BitstringStatusList {
    // Cap decompression: encodedList may come from an untrusted status list
    // credential, and unbounded gunzip/inflate of a small gzip bomb can
    // allocate gigabytes (verifier DoS).
    const limit = { maxOutputLength: MAX_DECOMPRESSED_BITSTRING_BYTES };
    let decompressed: Uint8Array;
    try {
      if (encoded.startsWith('u')) {
        decompressed = new Uint8Array(gunzipSync(base64urlDecode(encoded.slice(1)), limit));
      } else {
        // Legacy pre-spec encoding: bare base64url, raw DEFLATE stream.
        decompressed = new Uint8Array(inflateSync(base64urlDecode(encoded), limit));
      }
    } catch (err) {
      throw new Error(
        `Invalid encoded bitstring: decompression failed or exceeded the ${MAX_DECOMPRESSED_BITSTRING_BYTES}-byte limit: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    const bitLength = length ?? decompressed.length * 8;
    const list = new BitstringStatusList(
      Math.max(bitLength, MINIMUM_LIST_SIZE)
    );
    list.bits.set(decompressed.subarray(0, list.bits.length));
    return list;
  }

  private validateIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError(
        `Status list index ${index} out of range [0, ${this.length - 1}]`
      );
    }
  }
}

function base64urlEncode(data: Uint8Array): string {
  const b64 = Buffer.from(data).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array(Buffer.from(padded, 'base64'));
}
