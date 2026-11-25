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

describe('TSP inbox router', () => {
  test('routes POST by did:webvh inbox path (multi-DID)', async () => {
    const aliceDid = `did:webvh:${SCID}:example.com:alice`;
    const bobDid = `did:webvh:${SCID}:example.com:bob`;
    const alice = createEphemeralTspIdentity(aliceDid, webvhTspInboxUrl(aliceDid));
    const bob = createEphemeralTspIdentity(bobDid, webvhTspInboxUrl(bobDid));

    const bobInbox: Uint8Array[] = [];
    const aliceEp = new TspEndpoint(alice);
    const bobEp = new TspEndpoint(bob);
    const lookup = async (did: string) => {
      if (did === aliceDid) {
        return { signingPublicKey: alice.signingPublicKey, encryptionPublicKey: alice.encryptionPublicKey };
      }
      if (did === bobDid) {
        return { signingPublicKey: bob.signingPublicKey, encryptionPublicKey: bob.encryptionPublicKey };
      }
      return null;
    };
    const router = createTspInboxRouter([
      { did: aliceDid, options: tspInboxHandlerOptions(aliceEp, alice, lookup) },
      {
        did: bobDid,
        options: tspInboxHandlerOptions(bobEp, bob, lookup, (msg) => {
          if (msg.applicationData) bobInbox.push(msg.applicationData);
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
    const payload = new TextEncoder().encode('routed');
    await aliceEp.sendApplicationHttp(bobPeer, payload);

    expect(bobInbox[0]).toEqual(payload);
    server.stop();
  });
});