// Ensure globalThis.crypto is available for noble libraries in Node test env
import { webcrypto } from 'node:crypto';

if (typeof globalThis.crypto === 'undefined') {
  // @ts-ignore
  globalThis.crypto = webcrypto as unknown as Crypto;
}


