import { describe, test, expect, beforeAll, spyOn } from 'bun:test';
import { gzipSync, deflateSync } from 'node:zlib';
import { validateCredential } from '../../../src/utils/validation';
import { StatusListManager, MAX_DECOMPRESSED_BITSTRING_BYTES } from '../../../src/vc/StatusListManager';
import { BitstringStatusList } from '../../../src/vc/BitstringStatusList';
import { CredentialManager } from '../../../src/vc/CredentialManager';
import { MultiSigManager } from '../../../src/vc/MultiSigManager';
import { KeyManager } from '../../../src/did/KeyManager';
import { DIDManager } from '../../../src/did/DIDManager';
import type { VerifiableCredential, OriginalsConfig } from '../../../src/types';

const keyManager = new KeyManager();

// ===== Issue #264: validateCredential must accept W3C VC 2.0 credentials =====

describe('validateCredential VC 2.0 support (issue #264)', () => {
  const base = {
    type: ['VerifiableCredential'],
    issuer: 'did:peer:issuer123',
    credentialSubject: { id: 'did:peer:subject' },
  };

  test('accepts a v2-context credential with validFrom', () => {
    const vc = {
      ...base,
      '@context': ['https://www.w3.org/ns/credentials/v2', 'https://originals.build/context'],
      validFrom: new Date().toISOString(),
    } as unknown as VerifiableCredential;
    expect(validateCredential(vc)).toBe(true);
  });

  test('accepts a v2-context credential with issuanceDate', () => {
    const vc = {
      ...base,
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      issuanceDate: new Date().toISOString(),
    } as unknown as VerifiableCredential;
    expect(validateCredential(vc)).toBe(true);
  });

  test('rejects a v1-context credential (VCDM 1.1 no longer accepted, issue #300)', () => {
    const vc = {
      ...base,
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      issuanceDate: new Date().toISOString(),
    } as unknown as VerifiableCredential;
    expect(validateCredential(vc)).toBe(false);
  });

  test('rejects a credential without a v1 or v2 credentials context', () => {
    const vc = {
      ...base,
      '@context': ['https://originals.build/context'],
      issuanceDate: new Date().toISOString(),
    } as unknown as VerifiableCredential;
    expect(validateCredential(vc)).toBe(false);
  });

  test('rejects a v1-only credential that has only validFrom', () => {
    const vc = {
      ...base,
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      validFrom: new Date().toISOString(),
    } as unknown as VerifiableCredential;
    expect(validateCredential(vc)).toBe(false);
  });

  test('rejects a v2 credential with a malformed validFrom', () => {
    const vc = {
      ...base,
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      validFrom: 'not-a-date',
    } as unknown as VerifiableCredential;
    expect(validateCredential(vc)).toBe(false);
  });
});

// ===== Issue #262: bounded decompression of encodedList =====

describe('status list decompression bounds (issue #262)', () => {
  // gzip of all-zero data compresses ~1000:1, so a payload twice the cap is a
  // tiny string but would decompress past the limit.
  const bombPlain = Buffer.alloc(MAX_DECOMPRESSED_BITSTRING_BYTES * 2);

  test('StatusListManager.decodeBitstring rejects a gzip bomb', () => {
    const bomb = 'u' + gzipSync(bombPlain).toString('base64url');
    expect(() => StatusListManager.decodeBitstring(bomb)).toThrow(/limit/);
  });

  test('BitstringStatusList.decode rejects a gzip bomb', () => {
    const bomb = 'u' + gzipSync(bombPlain).toString('base64url');
    expect(() => BitstringStatusList.decode(bomb)).toThrow(/limit/);
  });

  test('BitstringStatusList.decode rejects a legacy DEFLATE bomb', () => {
    const bomb = deflateSync(bombPlain).toString('base64url');
    expect(() => BitstringStatusList.decode(bomb)).toThrow(/limit/);
  });

  test('a legitimate status list still round-trips', () => {
    const list = new BitstringStatusList();
    list.set(42);
    const decoded = BitstringStatusList.decode(list.encode());
    expect(decoded.get(42)).toBe(true);
    expect(decoded.get(41)).toBe(false);

    const encoded = StatusListManager.encodeBitstring(new Uint8Array(16384));
    expect(StatusListManager.decodeBitstring(encoded).length).toBe(16384);
  });
});

// ===== Issue #261: signature algorithm comes from the key, not local config =====

describe('signer selection from key multicodec (issue #261)', () => {
  test('legacy-signed Ed25519 credential verifies under an ES256K-default verifier', async () => {
    const { privateKey, publicKey } = await keyManager.generateKeyPair('Ed25519');
    const issuerDid = `did:key:${publicKey}`;
    const vm = `${issuerDid}#${publicKey}`;

    const credential: VerifiableCredential = {
      '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
      type: ['VerifiableCredential', 'ResourceCreated'],
      issuer: issuerDid,
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:peer:subject' },
    };

    // Issuer signs on an Ed25519-default instance (no didManager -> legacy path)
    const issuerManager = new CredentialManager({ network: 'regtest', defaultKeyType: 'Ed25519' });
    const signed = await issuerManager.signCredential(credential, privateKey, vm);
    expect(signed.proof).toBeDefined();

    // Relying party verifies on the DEFAULT config (ES256K). Before the fix the
    // verifier picked ES256KSigner from its own config and rejected the
    // perfectly valid Ed25519 signature.
    const verifierManager = new CredentialManager({ network: 'regtest', defaultKeyType: 'ES256K' });
    expect(await verifierManager.verifyCredential(signed)).toBe(true);
  });

  test('signing side uses the private key type even when config disagrees', async () => {
    const { privateKey, publicKey } = await keyManager.generateKeyPair('Ed25519');
    const issuerDid = `did:key:${publicKey}`;
    const vm = `${issuerDid}#${publicKey}`;

    const credential: VerifiableCredential = {
      '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
      type: ['VerifiableCredential'],
      issuer: issuerDid,
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:peer:subject' },
    };

    // Config says ES256K but the key is Ed25519: signing must follow the key.
    const manager = new CredentialManager({ network: 'regtest', defaultKeyType: 'ES256K' });
    const signed = await manager.signCredential(credential, privateKey, vm);
    expect(await manager.verifyCredential(signed)).toBe(true);
  });

  test('multi-sig Ed25519 proofs verify under an ES256K-default verifier', async () => {
    // Multi-sig proofs are Data Integrity (eddsa-rdfc-2022) proofs: the
    // signature algorithm is fixed by the cryptosuite and the key itself, so
    // the verifier's defaultKeyType configuration cannot influence the
    // outcome (the hazard issue #261 targeted).
    const [k1, k2] = await Promise.all([
      keyManager.generateKeyPair('Ed25519'),
      keyManager.generateKeyPair('Ed25519'),
    ]);
    const vms = [k1, k2].map(k => `did:key:${k.publicKey}#${k.publicKey}`);
    const policy = { required: 2, total: 2, signerVerificationMethods: vms };

    const credential: VerifiableCredential = {
      '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
      type: ['VerifiableCredential'],
      issuer: 'did:peer:issuer',
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:peer:subject' },
    };

    const signerConfig: OriginalsConfig = { network: 'regtest', defaultKeyType: 'Ed25519' };
    const signed = await new MultiSigManager(signerConfig, new DIDManager(signerConfig)).signCredentialMultiSig(credential, {
      policy,
      privateKeys: new Map([
        [vms[0], k1.privateKey],
        [vms[1], k2.privateKey],
      ]),
    });

    const verifierConfig: OriginalsConfig = { network: 'regtest', defaultKeyType: 'ES256K' };
    const result = await new MultiSigManager(verifierConfig, new DIDManager(verifierConfig)).verifyMultiSig(signed, policy);
    expect(result.verified).toBe(true);
    expect(result.validSignatures).toBe(2);
  });
});

// ===== Issue #259: signing-side issuer-binding check must not be neutralized =====

describe('signing-side issuer binding (issue #259)', () => {
  let didManager: DIDManager;
  let privateKey: string;
  let publicKey: string;
  const signerDid = 'did:peer:signer-me';
  const vmId = `${signerDid}#key-1`;

  beforeAll(async () => {
    const pair = await keyManager.generateKeyPair('Ed25519');
    privateKey = pair.privateKey;
    publicKey = pair.publicKey;
    didManager = new DIDManager({ network: 'regtest', defaultKeyType: 'Ed25519' });
    spyOn(didManager, 'resolveDID').mockResolvedValue({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: signerDid,
      verificationMethod: [
        { id: vmId, type: 'Multikey', controller: signerDid, publicKeyMultibase: publicKey },
      ],
    } as any);
  });

  test('refuses to sign a credential claiming a foreign issuer', async () => {
    const manager = new CredentialManager(
      { network: 'regtest', defaultKeyType: 'Ed25519' },
      didManager
    );
    const impersonating: VerifiableCredential = {
      '@context': ['https://www.w3.org/ns/credentials/v2', 'https://originals.build/context'],
      type: ['VerifiableCredential'],
      issuer: 'did:peer:victim',
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:peer:subject' },
    };
    await expect(manager.signCredential(impersonating, privateKey, vmId)).rejects.toThrow(
      /does not match the verification method controller/
    );
  });

  test('still signs when the issuer controls the key', async () => {
    const manager = new CredentialManager(
      { network: 'regtest', defaultKeyType: 'Ed25519' },
      didManager
    );
    const legitimate: VerifiableCredential = {
      '@context': ['https://www.w3.org/ns/credentials/v2', 'https://originals.build/context'],
      type: ['VerifiableCredential'],
      issuer: signerDid,
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:peer:subject' },
    };
    const signed = await manager.signCredential(legitimate, privateKey, vmId);
    expect(signed.proof).toBeDefined();
    expect(signed.issuer).toBe(signerDid);
  });
});
