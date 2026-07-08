import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { signAsync, getPublicKeyAsync } from '@noble/ed25519';

/**
 * Build a factory for external signers backed by real Ed25519 keys, so
 * didwebvh-ts's cryptographic validation passes. Mirrors how the auth
 * package's Turnkey signer integrates (sign + verify + getVerificationMethodId).
 */
async function makeSignerFactory() {
  const { KeyManager } = await import('../../../src/did/KeyManager');
  const { Ed25519Signer } = await import('../../../src/crypto/Signer');
  const { multikey } = await import('../../../src/crypto/Multikey');
  const { prepareDataForSigning } = await import('didwebvh-ts');

  const keyManager = new KeyManager();
  const internalSigner = new Ed25519Signer();

  async function makeSigner() {
    const keyPair = await keyManager.generateKeyPair('Ed25519');
    const vmId = `did:key:${keyPair.publicKey}`;
    const signer = {
      getVerificationMethodId: () => vmId,
      async sign(input: { document: Record<string, unknown>; proof: Record<string, unknown> }) {
        const dataToSign = await prepareDataForSigning(input.document, input.proof);
        const sig: Buffer = await internalSigner.sign(Buffer.from(dataToSign), keyPair.privateKey);
        return { proofValue: multikey.encodeMultibase(sig) };
      },
      async verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) {
        const pubMultibase = multikey.encodePublicKey(publicKey, 'Ed25519');
        return internalSigner.verify(Buffer.from(message), Buffer.from(signature), pubMultibase);
      },
    };
    return { signer, keyPair, vmId };
  }

  return { makeSigner };
}

describe('OriginalsSDK', () => {
  test('create() returns instance with managers and defaults', () => {
    const sdk = OriginalsSDK.create();
    expect(sdk).toBeInstanceOf(OriginalsSDK);
    expect(sdk.did).toBeDefined();
    expect(sdk.credentials).toBeDefined();
    expect(sdk.lifecycle).toBeDefined();
    expect(sdk.bitcoin).toBeDefined();
  });

  test('create() accepts config overrides', () => {
    const sdk = OriginalsSDK.create({ network: 'regtest', enableLogging: true });
    expect(sdk).toBeInstanceOf(OriginalsSDK);
  });

  test('create() derives the Bitcoin network from webvhNetwork when network is not explicit', () => {
    // Regression: choosing a webvhNetwork tier but leaving network unset left
    // network defaulting to 'mainnet', so Bitcoin ops ran on mainnet while
    // did:btco creation used the tier's network — a fund-loss footgun.
    const magby = OriginalsSDK.create({ webvhNetwork: 'magby' });
    expect((magby as any).config.network).toBe('regtest');

    const cleffa = OriginalsSDK.create({ webvhNetwork: 'cleffa' });
    expect((cleffa as any).config.network).toBe('signet');

    const pichu = OriginalsSDK.create({ webvhNetwork: 'pichu' });
    expect((pichu as any).config.network).toBe('mainnet');

    // An explicit network is preserved (not overridden by the tier mapping).
    const explicit = OriginalsSDK.create({ network: 'signet', webvhNetwork: 'magby' });
    expect((explicit as any).config.network).toBe('signet');
  });

  test('create() derives the webvhNetwork tier from an explicit network (#294)', () => {
    // Regression: create({ network: 'regtest' }) with no tier used to leave
    // webvhNetwork defaulting to 'pichu' (the PRODUCTION domain) while doing
    // regtest Bitcoin. The tier must be derived from the network instead.
    const reg = OriginalsSDK.create({ network: 'regtest' });
    expect((reg as any).config.webvhNetwork).toBe('magby');
    expect((reg as any).config.network).toBe('regtest');

    const sig = OriginalsSDK.create({ network: 'signet' });
    expect((sig as any).config.webvhNetwork).toBe('cleffa');

    const main = OriginalsSDK.create({ network: 'mainnet' });
    expect((main as any).config.webvhNetwork).toBe('pichu');

    // An explicit webvhNetwork still wins over the reverse derivation.
    const explicitTier = OriginalsSDK.create({ network: 'regtest', webvhNetwork: 'pichu' });
    expect((explicitTier as any).config.webvhNetwork).toBe('pichu');
  });

  test('constructor honors config.keyStore (issue #277)', () => {
    // Regression: OriginalsConfig declares keyStore, but the constructor only
    // forwarded its second parameter — config.keyStore was silently ignored
    // and signing later failed with KEYSTORE_REQUIRED, far from the cause.
    const store = {
      getPrivateKey: async () => null,
      setPrivateKey: async () => {}
    };
    const sdk = new OriginalsSDK({ network: 'mainnet', defaultKeyType: 'ES256K', keyStore: store });
    expect((sdk.lifecycle as any).keyStore).toBe(store);
  });

  test('constructor keyStore parameter takes precedence over config.keyStore', () => {
    const configStore = {
      getPrivateKey: async () => null,
      setPrivateKey: async () => {}
    };
    const paramStore = {
      getPrivateKey: async () => null,
      setPrivateKey: async () => {}
    };
    const sdk = new OriginalsSDK(
      { network: 'mainnet', defaultKeyType: 'ES256K', keyStore: configStore },
      paramStore
    );
    expect((sdk.lifecycle as any).keyStore).toBe(paramStore);
  });

  test('constructor throws error when config is null', () => {
    expect(() => new OriginalsSDK(null as any)).toThrow('Configuration object is required');
  });

  test('constructor throws error when config is not an object', () => {
    expect(() => new OriginalsSDK('invalid' as any)).toThrow('Configuration object is required');
  });

  test('constructor throws error when network is invalid', () => {
    expect(() => new OriginalsSDK({ network: 'invalid' as any, defaultKeyType: 'ES256K' }))
      .toThrow('Invalid network: must be mainnet, regtest, or signet');
  });

  test('constructor throws error when network is missing', () => {
    expect(() => new OriginalsSDK({ defaultKeyType: 'ES256K' } as any))
      .toThrow('Invalid network: must be mainnet, regtest, or signet');
  });

  test('constructor throws error when defaultKeyType is invalid', () => {
    expect(() => new OriginalsSDK({ network: 'mainnet', defaultKeyType: 'invalid' as any }))
      .toThrow('Invalid defaultKeyType: must be ES256K, Ed25519, or ES256');
  });

  test('constructor throws error when defaultKeyType is missing', () => {
    expect(() => new OriginalsSDK({ network: 'mainnet' } as any))
      .toThrow('Invalid defaultKeyType: must be ES256K, Ed25519, or ES256');
  });

  describe('validateBitcoinConfig', () => {
    test('does not throw when ordinalsProvider is configured', () => {
      const mockProvider = {
        getInscription: mock(() => Promise.resolve({ id: 'test', content: new Uint8Array() })),
        getBalance: mock(() => Promise.resolve(1000)),
        getUtxos: mock(() => Promise.resolve([])),
        inscribe: mock(() => Promise.resolve({ txid: 'test', vout: 0 })),
        broadcastTx: mock(() => Promise.resolve('txid')),
        estimateFee: mock(() => Promise.resolve(10)),
      };

      const sdk = OriginalsSDK.create({ ordinalsProvider: mockProvider });
      expect(() => sdk.validateBitcoinConfig()).not.toThrow();
    });

    test('throws StructuredError when ordinalsProvider is not configured', () => {
      const sdk = OriginalsSDK.create();
      expect(() => sdk.validateBitcoinConfig()).toThrow('Bitcoin operations require an ordinalsProvider');
    });
  });

  describe('verifyDIDSignature', () => {
    let privateKey: Uint8Array;
    let publicKey32: Uint8Array;
    let publicKey33: Uint8Array;
    const message = new TextEncoder().encode('test message');

    beforeEach(async () => {
      privateKey = new Uint8Array(32).fill(1);
      publicKey32 = await getPublicKeyAsync(privateKey);
      publicKey33 = new Uint8Array(33);
      publicKey33[0] = 0x00;
      publicKey33.set(publicKey32, 1);
    });

    test('verifies valid signature with 32-byte public key', async () => {
      const signature = await signAsync(message, privateKey);
      const result = await OriginalsSDK.verifyDIDSignature(signature, message, publicKey32);
      expect(result).toBe(true);
    });

    test('rejects a 33-byte public key instead of guessing at a prefix (issue #352)', async () => {
      // 33 bytes is the shape of a compressed secp256k1 key, not a "prefixed
      // Ed25519 key" (Ed25519 multicodec prefixes are 2 bytes → 34 bytes).
      // Stripping one byte verified against garbage; it must throw instead.
      const signature = await signAsync(message, privateKey);
      await expect(OriginalsSDK.verifyDIDSignature(signature, message, publicKey33))
        .rejects.toThrow('Invalid Ed25519 public key length: 33');
    });

    test('returns false for invalid signature', async () => {
      const signature = await signAsync(message, privateKey);
      const wrongMessage = new TextEncoder().encode('wrong message');
      const result = await OriginalsSDK.verifyDIDSignature(signature, wrongMessage, publicKey32);
      expect(result).toBe(false);
    });

    test('throws error for invalid public key length', async () => {
      const signature = await signAsync(message, privateKey);
      const invalidKey = new Uint8Array(16);
      await expect(OriginalsSDK.verifyDIDSignature(signature, message, invalidKey))
        .rejects.toThrow('Invalid Ed25519 public key length: 16');
    });

    test('returns false on verification error', async () => {
      const invalidSignature = new Uint8Array(32); // Invalid signature
      const result = await OriginalsSDK.verifyDIDSignature(invalidSignature, message, publicKey32);
      expect(result).toBe(false);
    });
  });

  describe('prepareDIDDataForSigning', () => {
    test('calls didwebvh-ts prepareDataForSigning', async () => {
      const document = { id: 'did:webvh:example.com' };
      const proof = { type: 'DataIntegrityProof' };

      // This test verifies the method exists and delegates to didwebvh-ts
      const result = await OriginalsSDK.prepareDIDDataForSigning(document, proof);
      expect(result).toBeInstanceOf(Uint8Array);
    });
  });

  describe('createOriginal', () => {
    test('throws error for unsupported type', async () => {
      const options = {
        type: 'invalid' as any,
        domain: 'example.com',
      };

      await expect(OriginalsSDK.createOriginal(options))
        .rejects.toThrow('Unsupported Original type: invalid');
    });

    test('createDIDOriginal accepts legacy did:key-prefixed updateKeys (didwebvh-ts 2.8 requires bare multikeys)', async () => {
      // Regression: didwebvh-ts 2.8.0 authorizes update proofs against bare
      // multikey updateKeys ("z6Mk..."). External-signer integrations (e.g. the
      // auth package's Turnkey signer) pass signer.getVerificationMethodId()
      // ("did:key:z6Mk...") as an updateKey; without normalization createDID
      // fails with "Key did:key:... is not authorized to update."
      const { makeSigner } = await makeSignerFactory();
      const { signer, keyPair, vmId } = await makeSigner();

      const result = await OriginalsSDK.createDIDOriginal({
        type: 'did',
        domain: 'example.com',
        signer: signer as any,
        verifier: signer as any,
        updateKeys: [vmId], // legacy prefixed form, as the auth package passes
        verificationMethods: [
          { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase: keyPair.publicKey },
        ],
      });

      expect(result.did).toMatch(/^did:webvh:/);
      // The log's updateKeys must be stored in the bare multikey (spec) form.
      expect(result.meta.updateKeys).toEqual([keyPair.publicKey]);
    }, 20000);

    test('createDIDOriginal forwards nextKeyHashes and supports a full pre-rotation chain', async () => {
      // Regression: createDIDOriginal silently dropped nextKeyHashes (and other
      // declared options), so callers requesting pre-rotation got none.
      const { computeNextKeyHash } = await import('../../../src/did/WebVHManager');
      const { makeSigner } = await makeSignerFactory();

      const active = await makeSigner();
      const next = await makeSigner();
      const nextKeyHashes = [computeNextKeyHash(next.keyPair.publicKey)];

      const created = await OriginalsSDK.createDIDOriginal({
        type: 'did',
        domain: 'example.com',
        signer: active.signer as any,
        verifier: active.signer as any,
        updateKeys: [active.keyPair.publicKey],
        nextKeyHashes,
        portable: true,
        verificationMethods: [
          { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase: active.keyPair.publicKey },
        ],
      });

      expect(created.meta.nextKeyHashes).toEqual(nextKeyHashes);
      expect(created.meta.prerotation).toBe(true);
      expect(created.meta.portable).toBe(true);

      // The committed hash must actually authorize the next rotation:
      // rotate to the pre-committed key (signed by it, per didwebvh-ts).
      const updated = await OriginalsSDK.updateDIDOriginal({
        type: 'did',
        log: created.log,
        signer: next.signer as any,
        verifier: next.signer as any,
        updateKeys: [next.keyPair.publicKey],
        nextKeyHashes: [],
        verificationMethods: [
          { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase: next.keyPair.publicKey },
        ],
      });

      expect(updated.log.length).toBe(created.log.length + 1);
      expect(updated.meta.updateKeys).toEqual([next.keyPair.publicKey]);
    }, 20000);

    test('createDIDOriginal rejects legacy did:key updateKeys combined with nextKeyHashes', async () => {
      // nextKeyHashes commit to the exact updateKey string; normalizing the
      // updateKeys while keeping caller-computed hashes would corrupt the
      // pre-rotation chain at the NEXT rotation. Fail fast instead.
      const { makeSigner } = await makeSignerFactory();
      const active = await makeSigner();

      await expect(OriginalsSDK.createDIDOriginal({
        type: 'did',
        domain: 'example.com',
        signer: active.signer as any,
        verifier: active.signer as any,
        updateKeys: [`did:key:${active.keyPair.publicKey}`],
        nextKeyHashes: ['QmSomeCommittedHash'],
        verificationMethods: [
          { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase: active.keyPair.publicKey },
        ],
      })).rejects.toThrow(/bare multikey form/);
    });

    test('updateDIDOriginal rejects legacy did:key updateKeys combined with nextKeyHashes', async () => {
      const { makeSigner } = await makeSignerFactory();
      const active = await makeSigner();

      const created = await OriginalsSDK.createDIDOriginal({
        type: 'did',
        domain: 'example.com',
        signer: active.signer as any,
        verifier: active.signer as any,
        updateKeys: [active.keyPair.publicKey],
        verificationMethods: [
          { id: '#key-0', type: 'Multikey', controller: '', publicKeyMultibase: active.keyPair.publicKey },
        ],
      });

      await expect(OriginalsSDK.updateDIDOriginal({
        type: 'did',
        log: created.log,
        signer: active.signer as any,
        verifier: active.signer as any,
        updateKeys: [`did:key:${active.keyPair.publicKey}`],
        nextKeyHashes: ['QmSomeCommittedHash'],
      })).rejects.toThrow(/bare multikey form/);
    }, 20000);
  });

  describe('updateOriginal', () => {
    test('throws error for unsupported type', async () => {
      const options = {
        type: 'invalid' as any,
        log: [],
      };

      await expect(OriginalsSDK.updateOriginal(options))
        .rejects.toThrow('Unsupported Original type');
    });
  });
});


