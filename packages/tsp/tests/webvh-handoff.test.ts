import { describe, expect, test } from 'bun:test';
import {
  MemoryTspRouter,
  TspEndpoint,
  assertDidDocumentMultikeyOnly,
  createEphemeralTspIdentity,
  didDocumentForLocalVid,
  peerVidFromDidDocument,
  peerFromKeys,
} from '../src/index.js';

describe('did:webvh-style TSP handoff', () => {
  test('two multikey did:webvh endpoints exchange a handoff zip over TSP', async () => {
    const router = new MemoryTspRouter();
    const aliceDid = 'did:webvh:QmfAlice:example.com:alice';
    const bobDid = 'did:webvh:QmfBob:example.com:bob';

    const alice = createEphemeralTspIdentity(aliceDid, 'tsp://alice.example/handoff');
    const bob = createEphemeralTspIdentity(bobDid, 'tsp://bob.example/handoff');

    const aliceDoc = didDocumentForLocalVid(alice);
    const bobDoc = didDocumentForLocalVid(bob);
    assertDidDocumentMultikeyOnly(aliceDoc);
    assertDidDocumentMultikeyOnly(bobDoc);

    const aliceEp = new TspEndpoint(alice, router);
    const bobEp = new TspEndpoint(bob, router);
    const bobAsPeer = peerFromKeys({ ...peerVidFromDidDocument(bobDoc), transport: bob.transport! });
    const aliceAsPeer = peerFromKeys({ ...peerVidFromDidDocument(aliceDoc), transport: alice.transport! });

    await aliceEp.sendRelationshipInvite(bobAsPeer);
    const [invite] = bobEp.drainInbox();
    const openedInvite = await bobEp.receiveNext(aliceAsPeer, invite!);
    expect(openedInvite.payload.type).toBe('rfi');

    await bobEp.sendRelationshipAccept(peerFromKeys(alice), openedInvite.payload as never);
    const [accept] = aliceEp.drainInbox();
    await aliceEp.receiveNext(bobAsPeer, accept!);

    const handoffZip = new TextEncoder().encode('PK\x03\x04originals-handoff-fixture');
    await aliceEp.sendApplication(bobAsPeer, handoffZip);

    const [wire] = bobEp.drainInbox();
    expect(wire).toBeDefined();
    const received = await bobEp.receiveNext(aliceAsPeer, wire!);
    expect(received.applicationData).toEqual(handoffZip);
    expect(bobEp.relationship(aliceDid).status).toBe('bi');
  });
});