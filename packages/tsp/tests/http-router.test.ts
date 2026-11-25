import { describe, expect, test } from 'bun:test';
import {
  TspEndpoint,
  createEphemeralTspIdentity,
  createTspInboxRouter,
  didDocumentForLocalVid,
  peerFromKeys,
  peerVidFromDidDocument,
  webvhTspInboxUrl,
} from '../src/index.js';

const SCID = 'QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ';

describe('TSP inbox router', () => {
  test('routes POST by did:webvh inbox path (multi-DID)', async () => {
    const aliceDid = `did:webvh:${SCID}:example.com:alice`;
    const bobDid = `did:webvh:${SCID}:example.com:bob`;
    const alice = createEphemeralTspIdentity(aliceDid, webvhTspInboxUrl(aliceDid));
    const bob = createEphemeralTspIdentity(bobDid, webvhTspInboxUrl(bobDid));

    const bobInbox: Uint8Array[] = [];
    const router = createTspInboxRouter([
      {
        did: bobDid,
        options: {
          local: bob,
          lookupSender: async (did) =>
            did === alice.id
              ? { signingPublicKey: alice.signingPublicKey, encryptionPublicKey: alice.encryptionPublicKey }
              : null,
          onMessage: (msg) => {
            bobInbox.push(msg.applicationData ?? new Uint8Array());
          },
        },
      },
    ]);

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: router,
    });

    const bobPeer = peerFromKeys(peerVidFromDidDocument(didDocumentForLocalVid(bob)));
    const aliceEp = new TspEndpoint(alice);
    const payload = new TextEncoder().encode('routed');
    const inboxPath = new URL(webvhTspInboxUrl(bobDid)).pathname;
    await aliceEp.sendApplicationHttp(
      { ...bobPeer, transport: `${server.url.origin}${inboxPath}` },
      payload,
    );

    expect(bobInbox[0]).toEqual(payload);
    server.stop();
  });
});