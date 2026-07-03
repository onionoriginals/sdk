import b58 from 'b58';

export function encodeBase64UrlMultibase(bytes: Uint8Array): string {
  return 'u' + Buffer.from(bytes).toString('base64url');
}

export function decodeBase64UrlMultibase(s: string): Uint8Array {
  if (!s || s[0] !== 'u') {
    throw new Error('Invalid Multibase encoding');
  }
  const payload = s.slice(1);
  // Buffer.from(..., 'base64url') silently skips characters outside the
  // alphabet, so distinct proofValue strings would decode to the same bytes
  // (signature malleability). Validate strictly instead.
  if (!/^[A-Za-z0-9_-]*$/.test(payload)) {
    throw new Error('Invalid Multibase encoding: not base64url');
  }
  return Uint8Array.from(Buffer.from(payload, 'base64url'));
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
		return Buffer.from(unencoded || '').toString('base64');
	},
	decode: (encoded: string): Uint8Array => {
		// Copy instead of wrapping `.buffer`: on Node, small Buffers are views
		// into a shared pool, so wrapping the backing ArrayBuffer without
		// byteOffset/byteLength returns unrelated pool memory.
		return Uint8Array.from(Buffer.from(encoded || '', 'base64'));
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
		const encoded = base64.encode(unencoded);
		return encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
	},
	decode: (encoded: string): Uint8Array => {
		let padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
		while (padded.length % 4) padded += '=';
		return base64.decode(padded);
	}
};

// Type assertion for b58 library which doesn't have proper types
interface B58Module {
  encode: (unencoded: Uint8Array) => string;
  decode: (encoded: string) => Uint8Array;
}

const b58Typed = b58 as unknown as B58Module;

export const base58 = {
	encode: (unencoded: Uint8Array): string => {
		return b58Typed.encode(unencoded);
	},
	decode: (encoded: string): Uint8Array => {
		return b58Typed.decode(encoded);
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
