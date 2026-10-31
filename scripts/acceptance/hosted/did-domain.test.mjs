import { test } from "node:test";
import assert from "node:assert/strict";
import { didWebvhDomain } from "./did-domain.mjs";

// #976 B1, B2: the acceptance account's identity DID must be on the staging
// did:webvh domain. An identity on another domain fails this gate.
test("a staging identity is on the staging domain", () => {
  assert.equal(didWebvhDomain("did:webvh:QmScid:staging.originals.build:user-0123456789abcdef"), "staging.originals.build");
});

test("a production identity is not on the staging domain", () => {
  assert.notEqual(didWebvhDomain("did:webvh:QmScid:originals.build:user-0123456789abcdef"), "staging.originals.build");
});

test("a percent-encoded port is decoded, as a host header names it", () => {
  assert.equal(didWebvhDomain("did:webvh:QmScid:127.0.0.1%3A4310:user-0123456789abcdef"), "127.0.0.1:4310");
});

test("anything but a did:webvh has no domain", () => {
  assert.equal(didWebvhDomain("did:vh:QmScid"), null);
  assert.equal(didWebvhDomain("did:webvh:QmScid"), null);
});
