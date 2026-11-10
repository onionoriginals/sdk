/**
 * The SDK's client half of the shared-host wire format (`encodeSubmission`,
 * `@originals/sdk/originals`) is exactly what this host's submit route
 * parses (`parseSubmission`; P6.7): the same entry line, resource bytes and
 * identity histories, for a real signed candidate.
 */
import { describe, expect, test } from 'bun:test';
import { localSigner } from '@originals/vh/crypto';
import { createLog, serializeLog, signWith } from '@originals/vh/log';
import { MemoryStore, OriginalsSDK, encodeSubmission, keySigner, type Submission } from '@originals/sdk/originals';
import { parseSubmission } from '../src/shared-saves.js';

async function author() {
  const update = localSigner('Ed25519', new Uint8Array(32).fill(3));
  const key = localSigner('Ed25519', new Uint8Array(32).fill(4));
  const k = update.publicKeyMultibase;
  const genesis = await createLog({
    versionTime: '2026-11-01T00:00:00Z',
    parameters: { method: 'did:vh:1.0', scid: '{SCID}', updateKeys: [k] },
    state: {
      '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:vh:{SCID}',
      verificationMethod: [{ id: 'did:vh:{SCID}#key-1', type: 'Multikey', controller: 'did:vh:{SCID}', publicKeyMultibase: key.publicKeyMultibase }],
      assertionMethod: ['did:vh:{SCID}#key-1'],
    },
    sign: signWith(update, { cryptosuite: 'eddsa-jcs-2022', verificationMethod: `did:key:${k}#${k}` }),
  });
  const did = genesis.state.id as string;
  return { evidence: { did, log: serializeLog([genesis]) }, ref: { did, verificationMethod: `${did}#key-1`, versionId: genesis.versionId }, secret: new Uint8Array(32).fill(4) };
}

describe('encodeSubmission → parseSubmission', () => {
  test('a signed candidate submitted by the SDK parses to the same entry, bytes and identities', async () => {
    const a = await author();
    let t = Date.parse('2026-11-08T00:00:00Z');
    const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [a.evidence], clock: () => (t += 1000) });
    const signer = keySigner({ keyType: 'Ed25519', secretKey: a.secret, verificationMethod: a.ref.verificationMethod });
    const c = await sdk.create({ name: 'wire', resource: { mediaType: 'image/png', bytes: new Uint8Array([1, 2, 3]) }, author: a.ref, signer });
    if (c.kind !== 'original') throw new Error('expected an Original');
    const next = new Uint8Array(70_000).map((_, i) => (i * 31) & 0xff);
    const candidate = await sdk.sign(await sdk.prepareEdit(c.original.did, { parent: c.original.checkpoint, author: a.ref, resource: { bytes: next } }), signer);

    let sent: Submission | undefined;
    await sdk.submit(candidate, {
      submit: (s) => ((sent = s), Promise.resolve({ status: 'accepted', checkpoint: candidate.versionId, head: candidate.versionId })),
      accepted: () => Promise.reject(new Error('not used')),
    });
    const parsed = parseSubmission(encodeSubmission(sent!));
    if ('http' in parsed) throw new Error(`refused: ${JSON.stringify(parsed)}`);
    expect(parsed.original).toBe(c.original.did);
    expect(parsed.entry).toBe(candidate.line);
    expect(parsed.resources).toEqual(new Map(Object.entries(sent!.resources)));
    expect([...parsed.resources.values()][0]).toEqual(next);
    expect(parsed.identities).toEqual([{ did: a.evidence.did, log: a.evidence.log }]);
  });
});
