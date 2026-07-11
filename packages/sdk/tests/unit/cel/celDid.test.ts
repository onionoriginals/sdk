import { describe, test, expect } from 'bun:test';
import * as ed25519 from '@noble/ed25519';
import { deriveDidCel, deriveDidCelFromGenesis, isDidCel, didCelMatchesLog, DID_CEL_PREFIX, createCelDidDocument, resolveDidCel } from '../../../src/cel/celDid';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { updateEventLog } from '../../../src/cel/algorithms/updateEventLog';
import { appendEvent } from '../../../src/cel/algorithms/appendEvent';
import { canonicalizeEvent } from '../../../src/cel/canonicalize';
import { PeerCelManager } from '../../../src/cel/layers/PeerCelManager';
import { multikey } from '../../../src/crypto/Multikey';
import type { DataIntegrityProof } from '../../../src/cel/types';
import { validateDIDDocument } from '../../../src/utils/validation';

const fakeSigner = async (_data: unknown): Promise<DataIntegrityProof> => ({
  type: 'DataIntegrityProof',
  cryptosuite: 'eddsa-jcs-2022',
  created: '2026-07-10T00:00:00Z',
  verificationMethod: 'did:key:z6MkfakeSigner#z6MkfakeSigner',
  proofPurpose: 'assertionMethod',
  proofValue: 'zFakeSig'
});

async function makeLog() {
  return createEventLog(
    { name: 'A', controller: 'did:key:z6MkfakeSigner', resources: [], createdAt: '2026-07-10T00:00:00Z', nonce: 'u9zzz' },
    { signer: fakeSigner, verificationMethod: 'did:key:z6MkfakeSigner#z6MkfakeSigner' }
  );
}

describe('did:cel derivation', () => {
  test('derives a stable did:cel with multihash-multibase suffix', async () => {
    const log = await makeLog();
    const did = deriveDidCel(log);
    expect(did.startsWith(DID_CEL_PREFIX)).toBe(true);
    expect(did.slice(DID_CEL_PREFIX.length).startsWith('u')).toBe(true); // base64url multibase
    expect(deriveDidCel(log)).toBe(did); // deterministic
    expect(deriveDidCelFromGenesis(log.events[0])).toBe(did);
  });

  test('INVARIANT: second event previousEvent equals the DID suffix', async () => {
    const log = await makeLog();
    const did = deriveDidCel(log);
    const updated = await updateEventLog(log, { note: 'x' }, {
      signer: fakeSigner, verificationMethod: 'did:key:z6MkfakeSigner#z6MkfakeSigner'
    });
    expect(updated.events[1].previousEvent).toBe(did.slice(DID_CEL_PREFIX.length));
    expect(didCelMatchesLog(did, updated)).toBe(true);
  });

  test('proof does not affect the DID (proof excluded from digest)', async () => {
    const log = await makeLog();
    const mutated = { ...log, events: [{ ...log.events[0], proof: [{ ...log.events[0].proof[0], proofValue: 'zDifferent' }] }] };
    expect(deriveDidCel(mutated as never)).toBe(deriveDidCel(log));
  });

  test('rejects empty logs and non-create genesis; isDidCel discriminates', async () => {
    expect(() => deriveDidCel({ events: [] })).toThrow(/empty/i);
    const log = await makeLog();
    const badGenesis = { ...log.events[0], type: 'update' as const };
    expect(() => deriveDidCelFromGenesis(badGenesis)).toThrow(/create/i);
    expect(isDidCel('did:cel:uEiAabc')).toBe(true);
    expect(isDidCel('did:peer:4zQm')).toBe(false);
    expect(didCelMatchesLog('did:cel:uEiAwrong', log)).toBe(false);
  });

  test('didCelMatchesLog returns false when the first event is not a create', async () => {
    const log = await makeLog();
    const did = deriveDidCel(log);
    const notCreate = { ...log, events: [{ ...log.events[0], type: 'update' as const }] };
    expect(didCelMatchesLog(did, notCreate as never)).toBe(false);
  });
});

describe('createCelDidDocument', () => {
  const did = 'did:cel:uEiAabc123';
  const pubKey = 'z6MkfakePublicKey';

  test('produces a Multikey #key-0 VM with authentication/assertionMethod/alsoKnownAs', () => {
    const doc = createCelDidDocument(did, pubKey);

    expect(doc['@context']).toEqual([
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/multikey/v1',
    ]);
    expect(doc.id).toBe(did);
    expect(doc.verificationMethod).toEqual([
      {
        id: `${did}#key-0`,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase: pubKey,
      },
    ]);
    expect(doc.authentication).toEqual([`${did}#key-0`]);
    expect(doc.assertionMethod).toEqual([`${did}#key-0`]);
    expect(doc.alsoKnownAs).toEqual([`did:key:${pubKey}`]);
  });

  test('the produced document passes validateDIDDocument', () => {
    const doc = createCelDidDocument(did, pubKey);
    expect(validateDIDDocument(doc)).toBe(true);
  });
});

describe('resolveDidCel (#Phase2 Task 8)', () => {
  // Real Ed25519 signing so verifyEventLog's cryptographic path is exercised.
  function realKey() {
    const priv = crypto.getRandomValues(new Uint8Array(32));
    let pubMb: string | undefined;
    const getPubMb = async () => {
      if (!pubMb) pubMb = multikey.encodePublicKey(await ed25519.getPublicKeyAsync(priv), 'Ed25519');
      return pubMb;
    };
    const signer = async (data: unknown): Promise<DataIntegrityProof> => {
      const mb = await getPubMb();
      const sig = await ed25519.signAsync(canonicalizeEvent(data), priv);
      return {
        type: 'DataIntegrityProof',
        cryptosuite: 'eddsa-jcs-2022',
        created: '2026-07-10T00:00:00Z',
        verificationMethod: `did:key:${mb}#${mb}`,
        proofPurpose: 'assertionMethod',
        proofValue: multikey.encodeMultibase(new Uint8Array(sig)),
      };
    };
    return { signer, getPubMb };
  }

  async function makeVerifiedLog() {
    const { signer, getPubMb } = realKey();
    const { log, did } = await new PeerCelManager(signer).create('Asset', []);
    return { log, did, signer, pubMb: await getPubMb() };
  }

  test('verified log resolves to a DID document for the genesis controller', async () => {
    const { log, did, pubMb } = await makeVerifiedLog();
    const doc = await resolveDidCel(did, log);
    expect(doc).not.toBeNull();
    expect(doc!.id).toBe(did);
    expect(doc!.verificationMethod?.[0]?.publicKeyMultibase).toBe(pubMb);
    expect(validateDIDDocument(doc!)).toBe(true);
  });

  test('a DID the log does not back resolves to null', async () => {
    const { log } = await makeVerifiedLog();
    const { did: otherDid } = await makeVerifiedLog();
    expect(await resolveDidCel(otherDid, log)).toBeNull();
  });

  test('a tampered log resolves to null', async () => {
    const { log, did } = await makeVerifiedLog();
    const tampered = {
      ...log,
      events: [{ ...log.events[0], data: { ...(log.events[0].data as object), name: 'tampered' } }],
    };
    expect(await resolveDidCel(did, tampered)).toBeNull();
  });

  test('a non-did:cel identifier resolves to null', async () => {
    const { log } = await makeVerifiedLog();
    expect(await resolveDidCel('did:peer:4zQmWhatever', log)).toBeNull();
  });

  test('rotateKey hands the resolved document to the NEW controller key', async () => {
    const { log, did, signer } = await makeVerifiedLog();
    const { getPubMb: getNewPubMb } = realKey();
    const newPubMb = await getNewPubMb();
    const rotated = await appendEvent(
      log,
      'rotateKey',
      { newController: `did:key:${newPubMb}`, rotatedAt: '2026-07-10T00:01:00Z' },
      { signer, verificationMethod: 'ignored' }
    );
    const doc = await resolveDidCel(did, rotated);
    expect(doc).not.toBeNull();
    expect(doc!.verificationMethod?.[0]?.publicKeyMultibase).toBe(newPubMb);
    expect(doc!.alsoKnownAs).toEqual([`did:key:${newPubMb}`]);
  });
});
