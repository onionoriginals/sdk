/**
 * Security regression tests for the attack scenarios closed by the
 * critical/high issue sweep (PR #296). Per CLAUDE.md, security-sensitive code
 * requires coverage under tests/security/ — these exercise each fix from the
 * attacker's side. Deeper behavioral coverage lives in the unit suites.
 */

import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { encode, decode } from '../../src/utils/cbor';
import { decodeBase64UrlMultibase, encodeBase64UrlMultibase } from '../../src/utils/encoding';
import { LocalStorageAdapter } from '../../src/storage/LocalStorageAdapter';
import { Verifier } from '../../src/vc/Verifier';
import { DIDManager } from '../../src/did/DIDManager';
import { StatusListManager } from '../../src/vc/StatusListManager';
import { selectUtxos as selectUtxosSimple } from '../../src/bitcoin/utxo-selection';

describe('CBOR prototype pollution (issues #236/#278)', () => {
  test('a __proto__ map key cannot reassign the decoded object prototype', () => {
    const malicious = encode({ ['__proto__']: { polluted: true }, x: 1 });
    const decoded = decode<Record<string, unknown>>(malicious);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
    // the key is preserved as an ordinary own property
    expect(Object.getOwnPropertyNames(decoded)).toContain('__proto__');
  });
});

describe('proofValue malleability (issue #250)', () => {
  test('distinct proofValue strings cannot decode to the same bytes', () => {
    const valid = encodeBase64UrlMultibase(new Uint8Array([1, 2, 3, 250]));
    for (const mutated of [valid + '!', valid + ' ', 'u' + 'ab\ncd', valid + '=']) {
      expect(() => decodeBase64UrlMultibase(mutated)).toThrow();
    }
  });
});

describe('LocalStorageAdapter path traversal (issue #251)', () => {
  test("a '..' domain cannot write outside baseDir", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-lsa-'));
    const baseDir = path.join(parent, 'storage');
    fs.mkdirSync(baseDir);
    const adapter = new LocalStorageAdapter({ baseDir });
    await expect(adapter.putObject('..', 'secret/pwned.txt', 'x'))
      .rejects.toThrow(/outside the storage directory/);
    expect(fs.existsSync(path.join(parent, 'secret'))).toBe(false);
    fs.rmSync(parent, { recursive: true, force: true });
  });
});

describe('revocation bypass via fabricated status list (issue #238)', () => {
  test('an unsigned all-zeros status list cannot clear a revoked credential', async () => {
    const dm = new DIDManager({} as never);
    const slMgr = new StatusListManager();
    const entry = slMgr.allocateStatusEntry('https://issuer.example/status/sec', 3, 'revocation');
    const credential = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: 'did:example:issuer',
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:example:holder' },
      credentialStatus: entry,
    };
    // Attacker-supplied list: right id + purpose, all zeros, NO proof
    const fabricated = slMgr.createStatusListCredential({
      id: 'https://issuer.example/status/sec',
      issuer: 'did:example:issuer',
      statusPurpose: 'revocation',
    });
    const verifier = new Verifier(dm, { statusListResolver: async () => fabricated });
    const result = await verifier.checkCredentialStatus(credential as never);
    expect(result.verified).toBe(false);
  });
});

describe('inscription-bearing UTXOs as fee inputs (issue #249)', () => {
  test('exported selector refuses to spend an inscribed UTXO even when it is the only option', () => {
    expect(() => selectUtxosSimple(
      [{ txid: 'inscribed', vout: 0, value: 1_000_000, inscriptions: ['abci0'] } as never],
      { targetAmount: 10_000 }
    )).toThrow(/inscriptions\/resources or are locked/);
  });
});

describe('did:key retirement is honored despite self-certifying synthesis (review follow-up)', () => {
  test('a registered revoked/compromised did:key VM fails closed instead of being resynthesized', async () => {
    const { createDocumentLoader, registerVerificationMethod, verificationMethodRegistry } =
      await import('../../src/vc/documentLoader');
    const { DIDManager } = await import('../../src/did/DIDManager');
    const { KeyManager } = await import('../../src/did/KeyManager');

    const km = new KeyManager();
    const key = await km.generateKeyPair('Ed25519');
    const did = `did:key:${key.publicKey}`;
    const vmId = `${did}#${key.publicKey}`;

    const dm = new DIDManager({ network: 'regtest' } as never);
    const loader = createDocumentLoader(dm);

    // Baseline: the canonical did:key fragment synthesizes fine when not retired
    const ok = await loader(vmId);
    expect((ok.document as { publicKeyMultibase?: string }).publicKeyMultibase).toBe(key.publicKey);

    // Operator marks the key compromised out-of-band
    registerVerificationMethod({ id: vmId, publicKeyMultibase: key.publicKey, compromised: '2026-01-01' });
    try {
      await expect(loader(vmId)).rejects.toThrow(/retired|revoked|compromised/i);
    } finally {
      verificationMethodRegistry.delete(vmId);
    }
  });
});

describe('signCredential fails closed on security refusals (review follow-up)', () => {
  test('a retired verification method is not silently signed via the legacy fallback', async () => {
    const { CredentialManager } = await import('../../src/vc/CredentialManager');
    const { DIDManager } = await import('../../src/did/DIDManager');
    const { KeyManager } = await import('../../src/did/KeyManager');
    const { registerVerificationMethod, verificationMethodRegistry } = await import('../../src/vc/documentLoader');

    const km = new KeyManager();
    const key = await km.generateKeyPair('Ed25519');
    const did = `did:key:${key.publicKey}`;
    const vmId = `${did}#${key.publicKey}`;

    const dm = new DIDManager({ network: 'regtest', defaultKeyType: 'Ed25519' } as never);
    const cm = new CredentialManager({ network: 'regtest', defaultKeyType: 'Ed25519' } as never, dm);

    registerVerificationMethod({ id: vmId, publicKeyMultibase: key.publicKey, revoked: '2026-01-01' });
    try {
      const credential = {
        '@context': ['https://www.w3.org/2018/credentials/v1'],
        type: ['VerifiableCredential'],
        issuer: did,
        issuanceDate: new Date().toISOString(),
        credentialSubject: { id: 'did:example:subject' },
      };
      // The DI path refuses (retired key); this must propagate, NOT fall
      // through to the legacy signer and sign with the revoked key anyway.
      await expect(cm.signCredential(credential as never, key.privateKey, vmId))
        .rejects.toThrow(/retired|revoked|compromised/i);
    } finally {
      verificationMethodRegistry.delete(vmId);
    }
  });
});

describe('multi-sig proofs must be assertions (review follow-up)', () => {
  test('an authorized signer proof with a non-assertion proofPurpose does not count toward the threshold', async () => {
    const { MultiSigManager } = await import('../../src/vc/MultiSigManager');
    const { DIDManager } = await import('../../src/did/DIDManager');
    const { KeyManager } = await import('../../src/did/KeyManager');

    const km = new KeyManager();
    const [k1, k2] = await Promise.all([km.generateKeyPair('Ed25519'), km.generateKeyPair('Ed25519')]);
    const vms = [k1, k2].map(k => `did:key:${k.publicKey}#${k.publicKey}`);
    const config = { network: 'regtest', defaultKeyType: 'Ed25519' } as never;
    const mgr = new MultiSigManager(config, new DIDManager(config));
    const policy = { required: 2, total: 2, signerVerificationMethods: vms };

    const credential = {
      '@context': ['https://www.w3.org/2018/credentials/v1', 'https://originals.build/context'],
      type: ['VerifiableCredential'],
      issuer: 'did:peer:issuer',
      issuanceDate: new Date().toISOString(),
      credentialSubject: { id: 'did:peer:subject' },
    };
    const signed = await mgr.signCredentialMultiSig(credential as never, {
      policy,
      privateKeys: new Map([[vms[0], k1.privateKey], [vms[1], k2.privateKey]]),
    });

    // Tamper the first proof's purpose to authentication — it must no longer count
    const proofs = signed.proof as Array<Record<string, unknown>>;
    proofs[0].proofPurpose = 'authentication';

    const result = await mgr.verifyMultiSig(signed, policy);
    expect(result.verified).toBe(false); // only 1 valid assertion proof, threshold 2
  });
});

describe('multi-sig adds a securing context when one is missing (review follow-up)', () => {
  test('a credential without a data-integrity context signs and verifies (securing context added)', async () => {
    const { MultiSigManager } = await import('../../src/vc/MultiSigManager');
    const { DIDManager } = await import('../../src/did/DIDManager');
    const { KeyManager } = await import('../../src/did/KeyManager');

    const km = new KeyManager();
    const k1 = await km.generateKeyPair('Ed25519');
    const vm = `did:key:${k1.publicKey}#${k1.publicKey}`;
    const config = { network: 'regtest', defaultKeyType: 'Ed25519' } as never;
    const mgr = new MultiSigManager(config, new DIDManager(config));
    const policy = { required: 1, total: 1, signerVerificationMethods: [vm] };

    // A credential whose @context defines no securing (data-integrity) context —
    // previously threw 'Safe mode validation error' until withSecuringContext
    // appended data-integrity/v2. (The SDK is VCDM 2.0-only per #300; this uses a
    // non-securing, resolvable context to still exercise the append path.)
    const credential = {
      '@context': ['https://originals.build/context'],
      type: ['VerifiableCredential'],
      issuer: 'did:peer:issuer',
      validFrom: new Date().toISOString(),
      credentialSubject: { id: 'did:peer:subject' },
    };
    const signed = await mgr.signCredentialMultiSig(credential as never, {
      policy,
      privateKeys: new Map([[vm, k1.privateKey]]),
    });
    expect(signed['@context']).toContain('https://w3id.org/security/data-integrity/v2');
    const result = await mgr.verifyMultiSig(signed, policy);
    expect(result.verified).toBe(true);
  });
});
