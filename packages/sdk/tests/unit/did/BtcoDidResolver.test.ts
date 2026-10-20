/**
 * did:btco resolution per the did:btco method v0.2.0 (plan 011 PR 9c): the
 * DID document is the inscription's CBOR metadata; versions follow chain
 * order; deactivation is terminal; an unreadable inscription fails closed.
 */
import { describe, expect, test } from 'bun:test';
import { encodeCbor } from '@originals/vh/originals';
import { BtcoDidResolver, parseBtcoDid } from '../../../src/did/BtcoDidResolver.js';
import { btcoDidDeactivationInscription, btcoDidInscription, createBtcoDidDocument } from '../../../src/did/createBtcoDidDocument.js';
import type { PublicationObservation, SatSnapshot } from '../../../src/bitcoin/sat-snapshot-types.js';

const SAT = '1234567890';
const DID = `did:btco:reg:${SAT}`;
const KEY = new Uint8Array(32).fill(7);
const T = 1_760_000_000;

let n = 0;
type Body = { metadata?: Uint8Array | null; content?: string; contentType?: string; unreadable?: boolean };
function publication(height: number, body: Body, transactionIndex = 1): PublicationObservation {
  const id = `${(n++).toString(16).padStart(64, '0')}i0`;
  return {
    id, revealTxid: id.slice(0, 64), network: 'regtest', sat: SAT, confirmed: true,
    creation: { height, blockHash: 'bb'.repeat(32), transactionIndex, inscriptionIndex: 0 },
    body: body.unreadable ? { status: 'unavailable' } : { status: 'complete', mediaType: body.contentType ?? 'text/plain', bytes: new TextEncoder().encode(body.content ?? 'x'), metadata: body.metadata ?? null },
  };
}
function snapshot(publications: PublicationObservation[], extra: Partial<SatSnapshot> = {}): SatSnapshot {
  const heights = [...new Set(publications.map((p) => p.creation!.height))];
  return {
    network: 'regtest', sat: SAT,
    tipBefore: { height: 100, hash: 'aa'.repeat(32) }, tipAfter: { height: 100, hash: 'aa'.repeat(32) }, indexTip: { height: 100, hash: 'aa'.repeat(32) },
    indexHealthy: true, enumerationComplete: true,
    blocks: heights.map((h) => ({ height: h, hash: 'bb'.repeat(32), txids: [], time: T + h * 600 })),
    publications,
    ownership: { owner: 'bcrt1qholder', satpoint: `${'cc'.repeat(32)}:1:0` },
    ...extra,
  };
}
const resolver = (s: SatSnapshot) => new BtcoDidResolver({ satSnapshot: () => Promise.resolve(s) });
const doc = (marker?: string) => ({ ...createBtcoDidDocument(SAT, 'regtest', { publicKey: KEY, keyType: 'Ed25519' }), ...(marker ? { alsoKnownAs: [marker] } : {}) });
const version = (height: number, d = doc(), tx = 1) => publication(height, { metadata: btcoDidInscription(d).metadata, content: DID }, tx);

describe('did:btco identifiers', () => {
  test('parses the network prefix and sat, and rejects anything else', () => {
    expect(parseBtcoDid(`did:btco:${SAT}`)).toEqual({ satNumber: SAT, network: 'mainnet' });
    expect(parseBtcoDid(DID)).toEqual({ satNumber: SAT, network: 'regtest' });
    expect(parseBtcoDid('did:btco:sig:0')).toEqual({ satNumber: '0', network: 'signet' });
    for (const bad of ['did:btco:01', 'did:btco:main:1', 'did:btco:1.5', 'did:btco:2099999997690000', `${DID}/0`]) expect(parseBtcoDid(bad)).toBeNull();
  });
});

describe('resolution (did:btco method v0.2.0)', () => {
  test('the latest version in chain order is the document; metadata names it, with times and the holder', async () => {
    const v1 = version(10, doc('one'));
    const art = publication(11, { content: 'art', contentType: 'image/png' });
    const v2 = version(12, doc('two'));
    const r = await resolver(snapshot([v2, art, v1])).resolve(DID);
    expect(r.resolutionMetadata.error).toBeUndefined();
    expect(r.didDocument?.alsoKnownAs).toEqual(['two']);
    expect(r.resolutionMetadata.versions).toEqual([v1.id, v2.id]);
    expect(r.didDocumentMetadata).toEqual({
      created: new Date((T + 10 * 600) * 1000).toISOString(),
      updated: new Date((T + 12 * 600) * 1000).toISOString(),
      inscriptionId: v2.id,
      network: 'regtest',
      ownership: { address: 'bcrt1qholder', outpoint: `${'cc'.repeat(32)}:1` },
    });
  });

  test('a document in the content, or a 🔥 marker, is not a version: only metadata counts', async () => {
    const asContent = publication(10, { content: JSON.stringify(doc()), contentType: 'application/json' });
    const marker = publication(11, { content: `BTCO DID: ${DID} 🔥` });
    expect((await resolver(snapshot([asContent, marker])).resolve(DID)).resolutionMetadata.error).toBe('notFound');
    const v1 = version(9);
    const r = await resolver(snapshot([v1, marker])).resolve(DID);
    expect(r.didDocument?.id).toBe(DID);
    expect(r.didDocumentMetadata.deactivated).toBeUndefined();
  });

  test('a deactivation document is terminal: later documents are not versions', async () => {
    const v1 = version(10);
    const off = publication(11, { metadata: btcoDidDeactivationInscription(DID).metadata });
    const later = version(12, doc('after'));
    const r = await resolver(snapshot([v1, off, later])).resolve(DID);
    expect(r.didDocument).toBeNull();
    expect(r.didDocumentMetadata.deactivated).toBe(true);
    expect(r.resolutionMetadata.versions).toEqual([v1.id, off.id]);
  });

  test('metadata that is not strict CBOR, or names another DID, is not a version', async () => {
    const indefinite = publication(10, { metadata: new Uint8Array([0xbf, 0x62, 0x69, 0x64, 0x61, 0x78, 0xff]) });
    const other = publication(11, { metadata: encodeCbor({ ...doc(), id: 'did:btco:reg:1' }) });
    expect((await resolver(snapshot([indefinite, other])).resolve(DID)).resolutionMetadata.error).toBe('notFound');
  });

  test('versions in the same block follow transaction order', async () => {
    const later = version(10, doc('later'), 5);
    const earlier = version(10, doc('earlier'), 2);
    expect((await resolver(snapshot([later, earlier])).resolve(DID)).didDocument?.alsoKnownAs).toEqual(['later']);
  });

  test('an unreadable inscription, an incomplete read or a failed read fails closed', async () => {
    const r1 = await resolver(snapshot([version(10), publication(11, { unreadable: true })])).resolve(DID);
    expect(r1.resolutionMetadata.error).toBe('unresolvable');
    expect(r1.didDocument).toBeNull();
    expect((await resolver(snapshot([version(10)], { enumerationComplete: false })).resolve(DID)).resolutionMetadata.error).toBe('unresolvable');
    const failing = new BtcoDidResolver({ satSnapshot: () => Promise.reject(new Error('index behind')) });
    expect((await failing.resolve(DID)).resolutionMetadata.error).toBe('unresolvable');
  });

  test('a read during which the chain tip moved is unresolvable', async () => {
    const moved = snapshot([version(10)], { tipAfter: { height: 101, hash: 'dd'.repeat(32) } });
    expect((await resolver(moved).resolve(DID)).resolutionMetadata.error).toBe('unresolvable');
  });

  test('a DID for another network than the read is refused', async () => {
    expect((await resolver(snapshot([version(10)])).resolve(`did:btco:${SAT}`)).resolutionMetadata.error).toBe('networkMismatch');
    expect((await resolver(snapshot([])).resolve('did:btco:x')).resolutionMetadata.error).toBe('invalidDid');
  });
});

describe('writing did:btco inscriptions (v0.2.0)', () => {
  test('the document travels as CBOR metadata; the deactivation names only the DID', () => {
    const d = doc();
    const i = btcoDidInscription(d);
    expect(new TextDecoder().decode(i.content)).toBe(DID);
    expect(i.metadata).toEqual(encodeCbor(d as never));
    const off = btcoDidDeactivationInscription(DID);
    expect(off.metadata).toEqual(encodeCbor({ '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/did-resolution/v1'], id: DID, deactivated: true }));
  });
});
