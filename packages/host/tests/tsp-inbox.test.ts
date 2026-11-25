import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TspEndpoint,
  createEphemeralTspIdentity,
  didDocumentForLocalVid,
  peerFromKeys,
  peerVidFromDidDocument,
  tspInboxHandlerOptions,
  webvhTspInboxPathname,
  webvhTspInboxUrl,
} from '@originals/tsp';
import { buildFetch } from '../src/app.js';
import { createTspInboxHost } from '../src/tsp-inbox.js';

const noopHostStore = {
  async handlePut() {
    return new Response(null, { status: 501 });
  },
  read() {
    return new Response(null, { status: 404 });
  },
  serve() {
    return null as Response | null;
  },
};

const SCID = 'QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ';

let distDir: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'host-tsp-dist-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>spa</title>');
  distDir = dir + '/';
});

afterAll(() => rmSync(distDir, { recursive: true, force: true }));

describe('@originals/host TSP inbox', () => {
  test('opt-in inbox serves RFI, RFA, and app message for two DIDs', async () => {
    const aliceDid = `did:webvh:${SCID}:demo.test:alice`;
    const bobDid = `did:webvh:${SCID}:demo.test:bob`;
    const alice = createEphemeralTspIdentity(aliceDid, webvhTspInboxUrl(aliceDid));
    const bob = createEphemeralTspIdentity(bobDid, webvhTspInboxUrl(bobDid));

    const aliceEp = new TspEndpoint(alice);
    const bobEp = new TspEndpoint(bob);
    const tspInbox = createTspInboxHost();

    const lookup = async (did: string) => {
      if (did === aliceDid) {
        return { signingPublicKey: alice.signingPublicKey, encryptionPublicKey: alice.encryptionPublicKey };
      }
      if (did === bobDid) {
        return { signingPublicKey: bob.signingPublicKey, encryptionPublicKey: bob.encryptionPublicKey };
      }
      return null;
    };

    const bobApp: Uint8Array[] = [];
    tspInbox.setEnabled(true);
    tspInbox.registerRoute({
      did: aliceDid,
      options: tspInboxHandlerOptions(aliceEp, alice, lookup),
    });
    tspInbox.registerRoute({
      did: bobDid,
      options: tspInboxHandlerOptions(bobEp, bob, lookup, (msg) => {
        if (msg.applicationData) bobApp.push(msg.applicationData);
      }),
    });

    const fetch = buildFetch({
      apiRoutes: null,
      hostStore: noopHostStore,
      distDir,
      tspInbox,
      trustedProxyHops: 0,
    });

    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch,
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
    expect(bobEp.relationship(aliceDid).status).toBe('uni');

    await bobEp.acceptRelationshipHttp(alicePeer);
    expect(aliceEp.relationship(bobDid).status).toBe('bi');

    const payload = new TextEncoder().encode('hosted-inbox');
    await aliceEp.sendApplicationHttp(bobPeer, payload);
    expect(bobApp[0]).toEqual(payload);

    server.stop();
  });
});