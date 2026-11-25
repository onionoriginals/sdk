import { describe, expect, test } from 'bun:test';
import {
  TspEndpoint,
  createEphemeralTspIdentity,
  createTspHttpHandler,
  didDocumentForLocalVid,
  peerFromKeys,
  peerVidFromDidDocument,
} from '../src/index.js';

describe('HTTP TSP transport', () => {
  test('POST CESR wire to handler and receive application payload', async () => {
    const alice = createEphemeralTspIdentity('did:webvh:QmfA:example.com:a', 'http://127.0.0.1:0/tsp');
    const bob = createEphemeralTspIdentity('did:webvh:QmfB:example.com:b', 'http://127.0.0.1:0/tsp');
    const bobDoc = didDocumentForLocalVid(bob);

    const received: Array<Uint8Array | undefined> = [];
    const handler = createTspHttpHandler({
      local: bob,
      lookupSender: async (did) => {
        if (did === alice.id) {
          return { signingPublicKey: alice.signingPublicKey, encryptionPublicKey: alice.encryptionPublicKey };
        }
        return null;
      },
      onMessage: (msg) => {
        received.push(msg.applicationData);
      },
    });

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: handler,
    });
    bob.transport = server.url.href;
    alice.transport = server.url.href;

    const aliceEp = new TspEndpoint(alice);
    const bobPeer = peerFromKeys(peerVidFromDidDocument(bobDoc));
    const payload = new TextEncoder().encode('handoff-bytes');
    await aliceEp.sendApplicationHttp({ ...bobPeer, transport: server.url.href }, payload);

    expect(received[0]).toEqual(payload);
    server.stop();
  });
});