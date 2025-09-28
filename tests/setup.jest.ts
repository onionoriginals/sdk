// Ensure globalThis.crypto is available for noble libraries in Node test env
import { webcrypto } from 'node:crypto';
import * as ed25519 from '@noble/ed25519';
import { createHash } from 'node:crypto';

// Ensure Jest matchers are properly extended
import 'jest';

if (typeof globalThis.crypto === 'undefined') {
  // @ts-ignore
  globalThis.crypto = webcrypto as unknown as Crypto;
}

// Configure noble ed25519 to use sha512 via Node crypto
// @ts-ignore
ed25519.etc.sha512Sync = (...msgs: Uint8Array[]) => {
  const hasher = createHash('sha512');
  for (const m of msgs) hasher.update(Buffer.from(m));
  return new Uint8Array(hasher.digest());
};



