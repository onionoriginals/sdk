import { describe, expect, test } from 'bun:test';
import {
  MemoryTspRouter,
  TspEndpoint,
  createEphemeralTspIdentity,
  didDocumentForLocalVid,
  peerFromKeys,
  peerVidFromDidDocument,
} from '@originals/tsp';
import {
  assertSdkDidDocumentHasNoJwk,
  receiveHandoffFromInbox,
  tspFieldsForWebVH,
} from '../../../src/tsp/index.js';

describe('TSP handoff delivery (sdk)', () => {
  test('handoff zip round trip with relationship establishment', async () => {
    const router = new MemoryTspRouter();
    const alice = createEphemeralTspIdentity('did:webvh:QmfA:issuer.example:alice', 'tsp://a');
    const bob = createEphemeralTspIdentity('did:webvh:QmfB:issuer.example:bob', 'tsp://b');
    const bobDoc = didDocumentForLocalVid(bob);
    const aliceDoc = didDocumentForLocalVid(alice);
    assertSdkDidDocumentHasNoJwk(bobDoc);
    assertSdkDidDocumentHasNoJwk(aliceDoc);

    const aliceFields = tspFieldsForWebVH(alice);
    expect(JSON.stringify(aliceFields)).not.toContain('JsonWebKey2020');

    const aliceEp = new TspEndpoint(alice, router);
    const bobEp = new TspEndpoint(bob, router);
    const bobPeer = peerFromKeys(peerVidFromDidDocument(bobDoc));
    const alicePeer = peerFromKeys(peerVidFromDidDocument(aliceDoc));

    await aliceEp.sendRelationshipInvite(bobPeer);
    const openedInvite = await bobEp.receiveNext(alicePeer, bobEp.drainInbox()[0]!);
    expect(openedInvite.payload.type).toBe('rfi');
    await bobEp.sendRelationshipAccept(alice, openedInvite.payload as never);
    await aliceEp.receiveNext(bobPeer, aliceEp.drainInbox()[0]!);

    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01]);
    await aliceEp.sendApplication(bobPeer, zip);
    const got = await receiveHandoffFromInbox(bob, aliceDoc, router);
    expect(got.handoffZip).toEqual(zip);
    expect(got.senderDid).toBe(alice.id);
  });
});