/**
 * createDIDOriginal applies the CEL WebVH path-segment rule (canonicalWebVHPaths)
 * before signing, so it never mints a DID CEL's parseAssetAlias cannot read back.
 */

import { describe, test, expect } from 'bun:test';
import { StructuredError } from '@originals/cel';
import { parseAssetAlias } from '@originals/cel/v3';
import { createDIDOriginal } from '../../../src/did/identity-operations.js';

async function makeSigner() {
  const { KeyManager } = await import('../../../src/did/KeyManager.js');
  const { Ed25519Signer } = await import('../../../src/crypto/Signer.js');
  const { multikey } = await import('@originals/cel');
  const { prepareDataForSigning } = await import('didwebvh-ts');

  const keyPair = await new KeyManager().generateKeyPair('Ed25519');
  const internalSigner = new Ed25519Signer();
  const vmId = `did:key:${keyPair.publicKey}`;
  let signCalls = 0;
  const signer = {
    getVerificationMethodId: () => vmId,
    async sign(input: { document: Record<string, unknown>; proof: Record<string, unknown> }) {
      signCalls++;
      const dataToSign = await prepareDataForSigning(input.document, input.proof);
      const sig: Buffer = await internalSigner.sign(Buffer.from(dataToSign), keyPair.privateKey);
      return { proofValue: multikey.encodeMultibase(sig) };
    },
    async verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) {
      const pubMultibase = multikey.encodePublicKey(publicKey, 'Ed25519');
      return internalSigner.verify(Buffer.from(message), Buffer.from(signature), pubMultibase);
    },
  };
  return { signer, keyPair, vmId, signCalls: () => signCalls };
}

async function create(paths: unknown) {
  const s = await makeSigner();
  const run = createDIDOriginal({
    type: 'did',
    domain: 'example.com',
    signer: s.signer as any,
    verifier: s.signer as any,
    updateKeys: [s.vmId],
    verificationMethods: [
      { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase: s.keyPair.publicKey },
    ],
    paths: paths as string[],
  });
  return { run, signCalls: s.signCalls };
}

async function expectRejected(paths: unknown, code: string): Promise<void> {
  const { run, signCalls } = await create(paths);
  let thrown: unknown;
  try {
    await run;
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(StructuredError);
  expect((thrown as StructuredError).code).toBe(code);
  expect(signCalls()).toBe(0);
}

describe('createDIDOriginal paths', () => {
  test('percent-encodes decoded segments into a DID CEL can parse back', async () => {
    const { did } = await (await create(['hello world', 'x~y', 'hello!world', 'café'])).run;
    expect(did).toEndWith(':example.com:hello%20world:x%7Ey:hello%21world:caf%C3%A9');
    expect(parseAssetAlias(did).layer).toBe('webvh');
  }, 20000);

  test('keeps a colon inside one segment', async () => {
    const { did } = await (await create(['a:b'])).run;
    expect(did).toEndWith(':example.com:a%3Ab');
  }, 20000);

  test.each(['.well-known', '.WELL-KNOWN'])(
    'rejects a leading %j with WEBVH_PATH_RESERVED before signing',
    async (first) => {
      await expectRejected([first], 'WEBVH_PATH_RESERVED');
    },
  );

  test.each([[['']], [[' hello']], [['..']], [['a/b']], [[123]], ['abc']])(
    'rejects paths %j with WEBVH_PATH_SEGMENT_INVALID before signing',
    async (paths) => {
      await expectRejected(paths, 'WEBVH_PATH_SEGMENT_INVALID');
    },
  );
});
