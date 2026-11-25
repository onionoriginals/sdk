import { describe, expect, test } from 'bun:test';
import {
  webvhTspInboxUrl,
  webvhTspInboxUrlFromPublishingAddress,
  tspInboxPathMatches,
} from '../src/vid/webvh-inbox.js';

const SCID = 'QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ';

describe('did:webvh TSP inbox URL layout', () => {
  test('root DID uses .well-known/tsp/inbox', () => {
    const did = `did:webvh:${SCID}:example.com`;
    expect(webvhTspInboxUrl(did)).toBe('https://example.com/.well-known/tsp/inbox');
    expect(tspInboxPathMatches(did, 'https://example.com/.well-known/tsp/inbox')).toBe(true);
  });

  test('path and port segments mirror did.jsonl layout', () => {
    const did = `did:webvh:${SCID}:example.com%3A3000:dids:issuer`;
    expect(webvhTspInboxUrl(did)).toBe('https://example.com:3000/dids/issuer/tsp/inbox');
    expect(
      webvhTspInboxUrlFromPublishingAddress('example.com%3A3000', ['dids', 'issuer']),
    ).toBe(webvhTspInboxUrl(did));
  });
});