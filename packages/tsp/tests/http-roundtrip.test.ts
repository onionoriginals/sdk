import { describe, expect, test } from 'bun:test';
import {
  createEphemeralTspIdentity,
  createTspHttpHandler,
  didDocumentForLocalVid,
  postTspWire,
  sealTspPayload,
} from '../src/index.js';

describe('HTTP TSP transport', () => {
  test('POST CESR wire to handler and receive application payload', async () => {
    const alice = createEphemeralTspIdentity('did:webvh:QmfA:example.com:a', 'http://127.0.0.1:0/tsp');
    const bob = createEphemeralTspIdentity('did:webvh:QmfB:example.com:b', 'http://127.0.0.1:0/tsp');

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

    const payload = new TextEncoder().encode('handoff-bytes');
    const wire = await sealTspPayload(alice, bob, { type: 'generic', data: payload }, { confidential: true });
    await postTspWire(server.url.href, wire);

    expect(received[0]).toEqual(payload);
    server.stop();
  });
});