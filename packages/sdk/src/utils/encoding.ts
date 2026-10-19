// @scure/base rather than Buffer: this module is on the import path of nearly
// every entry point, so a Node-only dependency here makes the whole SDK
// unloadable in browsers/edge runtimes.
import {
  base58 as scureBase58,
  base64 as scureBase64,
  base64urlnopad as scureBase64UrlNoPad
} from '@scure/base';

export function encodeBase64UrlMultibase(bytes: Uint8Array): string {
  return 'u' + scureBase64UrlNoPad.encode(bytes);
}

export function decodeBase64UrlMultibase(s: string): Uint8Array {
  if (!s || s[0] !== 'u') {
    throw new Error('Invalid Multibase encoding');
  }
  const payload = s.slice(1);
  // Decoders that skip characters outside the alphabet would let distinct
  // proofValue strings decode to the same bytes (signature malleability).
  // Validate strictly instead.
  if (!/^[A-Za-z0-9_-]*$/.test(payload)) {
    throw new Error('Invalid Multibase encoding: not base64url');
  }
  return scureBase64UrlNoPad.decode(payload);
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error('Invalid hex string length');
  }
  // Reject any non-hex character up front. parseInt is lenient — parseInt('1g', 16)
  // returns 1 (it stops at the first invalid nibble), so a per-byte NaN check would
  // silently accept malformed input like '1g' or 'aa1z' and produce wrong bytes.
  if (!/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error('Invalid hex string');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    const byteStr = clean.substring(i, i + 2);
    out[i / 2] = parseInt(byteStr, 16);
  }
  return out;
}

// multibase base58-btc header
export const MULTIBASE_BASE58BTC_HEADER = 'z';
// multibase base64url header
export const MULTIBASE_BASE64URL_HEADER = 'u';
// multicodec ed25519-pub header as varint
export const MULTICODEC_ED25519_PUB_HEADER = new Uint8Array([0xed, 0x01]);
// multicodec ed25519-priv header as varint
export const MULTICODEC_ED25519_PRIV_HEADER = new Uint8Array([0x80, 0x26]);
// multicodec x25519-pub header as varint
export const MULTICODEC_X25519_PUB_HEADER = new Uint8Array([0xec, 0x01]);
// multicodec x25519-priv header as varint
export const MULTICODEC_X25519_PRIV_HEADER = new Uint8Array([0x82, 0x26]);
// multicode secp256k1-pub header as varint
export const MULTICODEC_SECP256K1_PUB_HEADER = new Uint8Array([0xe7, 0x01]);
// multicode secp256k1-priv header as varint (registry code 0x1301)
export const MULTICODEC_SECP256K1_PRIV_HEADER = new Uint8Array([0x81, 0x26]);
// multicodec bls12381g2-pub header as varint
export const MULTICODEC_BLS12381_G2_PUB_HEADER = new Uint8Array([0xeb, 0x01]);
// multicodec bls12381g2-priv header as varint
export const MULTICODEC_BLS12381_G2_PRIV_HEADER = new Uint8Array([0x8a, 0x26]);

export const base64 = {
	encode: (unencoded: string | Uint8Array): string => {
		const bytes = typeof unencoded === 'string'
			? utf8.encode(unencoded)
			: (unencoded ?? new Uint8Array());
		return scureBase64.encode(bytes);
	},
	decode: (encoded: string): Uint8Array => {
		if (!encoded) return new Uint8Array();
		// @scure/base requires canonical padding; Buffer did not. Pad rather than
		// reject so callers holding unpadded base64 keep working.
		let padded = encoded;
		while (padded.length % 4) padded += '=';
		return scureBase64.decode(padded);
	}
};

export const utf8 = {
	encode: (unencoded: string): Uint8Array => {
		return new TextEncoder().encode(unencoded)
	},
	decode: (encoded: Uint8Array): string => {
		return new TextDecoder().decode(encoded);
	}
}

export const base64url = {
	encode: (unencoded: string | Uint8Array): string => {
		const bytes = typeof unencoded === 'string'
			? utf8.encode(unencoded)
			: (unencoded ?? new Uint8Array());
		return scureBase64UrlNoPad.encode(bytes);
	},
	decode: (encoded: string): Uint8Array => {
		if (!encoded) return new Uint8Array();
		// Tolerate the padded form; the nopad decoder rejects trailing '='.
		return scureBase64UrlNoPad.decode(encoded.replace(/=+$/, ''));
	}
};

export const base58 = {
	encode: (unencoded: Uint8Array): string => {
		return scureBase58.encode(unencoded);
	},
	decode: (encoded: string): Uint8Array => {
		return scureBase58.decode(encoded);
	}
};

export const multibase = {
	encode: (val: Uint8Array, encoding: 'base58btc' | 'base64url'): string => {
		if (encoding === 'base58btc') {
			const baseEncoded = base58.encode(val);
			return MULTIBASE_BASE58BTC_HEADER + baseEncoded;
		} else if (encoding === 'base64url') {
			return MULTIBASE_BASE64URL_HEADER + base64url.encode(val);
		}
		throw new Error('Invalid multibase encoding.');
	},
	decode: (val: string): Uint8Array => {
		if (val.startsWith(MULTIBASE_BASE58BTC_HEADER)) {
			return base58.decode(val.substring(1));
		} else if (val.startsWith(MULTIBASE_BASE64URL_HEADER)) {
			return base64url.decode(val.substring(1));
		}
		throw new Error('Multibase value does not have expected header.');
	}
};

export const multikey = {
	encode: (header: Uint8Array, val: Uint8Array): string => {
		const mcBytes = new Uint8Array(header.length + val.length);
		mcBytes.set(header);
		mcBytes.set(val, header.length);
		return multibase.encode(mcBytes, 'base58btc');
	},
	decode: (header: Uint8Array, val: string): Uint8Array => {
		const mcValue = multibase.decode(val);
		for (let i = 0; i < header.length; i++) {
			if (mcValue[i] !== header[i]) {
				throw new Error('Multikey value does not have expected header.');
			}
		}
		return mcValue.slice(header.length);
	}
}
