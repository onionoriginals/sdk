import { describe, test, expect } from 'bun:test';
import { deriveDidCel, deriveDidCelFromGenesis, isDidCel, didCelMatchesLog, DID_CEL_PREFIX, createCelDidDocument } from '../../../src/cel/celDid';
import { createEventLog } from '../../../src/cel/algorithms/createEventLog';
import { updateEventLog } from '../../../src/cel/algorithms/updateEventLog';
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
