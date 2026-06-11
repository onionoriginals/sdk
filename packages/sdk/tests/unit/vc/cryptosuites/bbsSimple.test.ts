import { test, expect } from 'bun:test';
import { BbsSimple } from '../../../../src/vc/cryptosuites/bbsSimple';

// These methods are deliberate unimplemented stubs (see bbsSimple.ts). The
// tests pin that they fail loudly so nobody mistakes the stub for a working
// BBS+ implementation.
test('BbsSimple.generateKeyPair throws (not implemented)', () => {
  expect(() => BbsSimple.generateKeyPair()).toThrow('not implemented');
});

test('BbsSimple.createProof rejects (not implemented)', async () => {
  await expect(
    BbsSimple.createProof({
      publicKey: new Uint8Array(),
      signature: new Uint8Array(),
      messages: [],
      disclosedIndexes: [],
    })
  ).rejects.toThrow('not implemented');
});

test('BbsSimple.verifyProof rejects (not implemented)', async () => {
  await expect(
    BbsSimple.verifyProof({
      publicKey: new Uint8Array(),
      proof: new Uint8Array(),
      disclosedMessages: [],
      disclosedIndexes: [],
      totalMessageCount: 0,
    })
  ).rejects.toThrow('not implemented');
});
