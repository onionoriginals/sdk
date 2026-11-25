import { describe, expect, test } from 'bun:test';
import {
  TspEndpoint,
  createEphemeralTspIdentity,
  createTspInboxRouter,
  didDocumentForLocalVid,
  peerFromKeys,
  peerVidFromDidDocument,
  tspInboxHandlerOptions,
  webvhTspInboxUrl,
  webvhTspInboxPathname,
} from '../src/index.js';

const SCID = 'QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ';

function peerKeys(
  id: string,
  signingPublicKey: Uint8Array,
  encryptionPublicKey: Uint8Array,
) {
  return { signingPublicKey, encryptionPublicKey };
}

describe('HTTP relationship cancel (RFD)', () => {
  test('cancel clears both sides; app send rejected and inbound ignored', async () => {
    const aliceDid = `did:webvh:${SCID}:example.com:alice`;
    const bobDid = `did:webvh:${SCID}:example.com:bob`;
    const alice = createEphemeralTspIdentity(aliceDid, webvhTspInboxUrl(aliceDid));
    const bob = createEphemeralTspIdentity(bobDid, webvhTspInboxUrl(bobDid));

    const aliceEp = new TspEndpoint(alice);
    const bobEp = new TspEndpoint(bob);

    const lookup = async (did: string) => {
      if (did === aliceDid) return peerKeys(aliceDid, alice.signingPublicKey, alice.encryptionPublicKey);
      if (did === bobDid) return peerKeys(bobDid, bob.signingPublicKey, bob.encryptionPublicKey);
      return null;
    };

    const bobApp: Uint8Array[] = [];
    const router = createTspInboxRouter([
      { did: aliceDid, options: tspInboxHandlerOptions(aliceEp, alice, lookup) },
      {
        did: bobDid,
        options: tspInboxHandlerOptions(bobEp, bob, lookup, (msg) => {
          if (msg.applicationData) bobApp.push(msg.applicationData);
        }),
      },
    ]);

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: router,
    });

    const inboxUrl = (did: string) => `${server.url.origin}${webvhTspInboxPathname(did)}`;
    const bobPeer = peerFromKeys({
      ...peerVidFromDidDocument(didDocumentForLocalVid(bob)),
      transport: inboxUrl(bobDid),
    });
    const alicePeer = peerFromKeys({
      ...peerVidFromDidDocument(didDocumentForLocalVid(alice)),
      transport: inboxUrl(aliceDid),
    });

    await aliceEp.requestRelationshipHttp(bobPeer);
    await bobEp.acceptRelationshipHttp(alicePeer);
    expect(aliceEp.relationship(bobDid).status).toBe('bi');

    await aliceEp.cancelRelationshipHttp(bobPeer);
    expect(aliceEp.relationship(bobDid).status).toBe('unrelated');
    expect(bobEp.relationship(aliceDid).status).toBe('unrelated');

    const payload = new TextEncoder().encode('after-cancel');
    await expect(aliceEp.sendApplicationHttp(bobPeer, payload)).rejects.toThrow(
      'bilateral TSP relationship required',
    );

    const wire = await sealBypassForTest(alice, bob, payload);
    await fetch(inboxUrl(bobDid), {
      method: 'POST',
      headers: { 'Content-Type': 'application/tsp+cesr' },
      body: wire,
    });
    expect(bobApp.length).toBe(0);

    server.stop();
  });
});

async function sealBypassForTest(
  alice: ReturnType<typeof createEphemeralTspIdentity>,
  bob: ReturnType<typeof createEphemeralTspIdentity>,
  data: Uint8Array,
): Promise<Uint8Array> {
  const { sealTspPayload } = await import('../src/message.js');
  return sealTspPayload(alice, bob, { type: 'generic', data }, { confidential: true });
}