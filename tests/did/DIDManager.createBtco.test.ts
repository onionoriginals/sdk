import { OriginalsSDK } from '../../src';
import { multikey } from '../../src/crypto/Multikey';

describe('DIDManager.createBtcoDidDocument method', () => {
  test('creates btco DID document via manager wrapper', () => {
    const sdk = OriginalsSDK.create();
    const pub = new Uint8Array(32).fill(1);
    const doc = sdk.did.createBtcoDidDocument('123', 'mainnet', { publicKey: pub, keyType: 'Ed25519' });
    expect(doc.id).toBe('did:btco:123');
    const vm = doc.verificationMethod![0];
    expect(vm.id).toBe('did:btco:123#0');
    const decoded = multikey.decodePublicKey(vm.publicKeyMultibase);
    expect(decoded.type).toBe('Ed25519');
  });
});

