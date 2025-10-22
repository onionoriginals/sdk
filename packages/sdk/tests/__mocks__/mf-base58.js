// Simple proxy to real multiformats if available; otherwise a minimal shim
let real;
try {
  real = require('multiformats/bases/base58');
} catch (_) {}

if (real && real.base58btc) {
  module.exports = real;
} else {
  // fallback: encode as z + base64url, decode accordingly (sufficient for tests)
  const toB64Url = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const fromB64Url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  module.exports = {
    base58btc: {
      encode: (bytes) => 'z' + toB64Url(bytes),
      decode: (str) => {
        if (!str || str[0] !== 'z') throw new Error('Invalid Multibase encoding');
        const raw = str.slice(1);
        return new Uint8Array(fromB64Url(raw));
      }
    }
  };
}

