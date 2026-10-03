import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  assetIdFromDigest,
  assetDigest,
  normalizeAssetId,
  deriveAssetId,
  canonicalizeValue,
  verifyHistory,
  eventDigest,
} from "../../src/v3/index.js";
import corpus from "../../../../docs/research/cel-profile-vectors/profile-documents.json";
import authority from "../../../../docs/research/cel-core-vectors/histories.json";

const genesis = corpus.accepted[0].document.log[0];
const hash = createHash("sha256")
  .update(canonicalizeValue(genesis.event))
  .digest("base64url");
const ni = `ni:///sha-256;${hash}`;
const id = "did:cel:" + eventDigest(genesis.event);

test("asset identity uses did:cel and preserves the legacy genesis commitment", () => {
  expect(deriveAssetId(genesis.event)).toBe(id);
  expect(assetIdFromDigest(eventDigest(genesis.event))).toBe(id);
  expect(assetDigest(id)).toBe(eventDigest(genesis.event));
  const state = verifyHistory(
    { log: [genesis] },
    { expectedAssetId: id },
  ).state;
  expect(state.assetId).toBe(id);
  expect(state.alias).toBe(id);
  expect(state.aliases).toEqual([id]);
});

test("old signed migrations verify unchanged under the corrected identity", () => {
  const document = {
    log: [authority.entries.G, authority.entries.W, authority.entries.T],
  };
  const before = JSON.stringify(document);
  const expected = deriveAssetId(authority.entries.G.event);
  const history = verifyHistory(document, { expectedAssetId: expected });
  expect(history.state.assetId).toBe(expected);
  expect(history.state.alias).toBe("did:btco:reg:5000000000");
  expect(JSON.stringify(document)).toBe(before);
  // The historical did:cel spelling signed into real migration history remains
  // readable through the retained aliases list; it is not a separate typed field.
  const legacyAlias = history.state.aliases.find((alias) =>
    alias.startsWith("did:cel:"),
  );
  expect(legacyAlias).toBeDefined();
  expect(normalizeAssetId(legacyAlias!)).toBe(expected);
  expect(() => verifyHistory(document, { expectedAssetId: id })).toThrow();
});

test("identity parser refuses alternate forms and does not accept other did:cel methods", () => {
  for (const value of [
    id + "=",
    id + "?x=1",
    id + "#key",
    ni.replace("ni:///", "ni://example.com/"),
    ni.replace("sha-256", "sha-512"),
    ni + "=",
    ni + "?x=1",
    id.slice(0, -1),
    "did:cel:zQmTest",
    hash,
  ])
    expect(() => normalizeAssetId(value)).toThrow();
  expect(normalizeAssetId(id)).toBe(id);
  expect(normalizeAssetId(ni)).toBe(id);
  expect(assetDigest(ni)).toBe(assetDigest(id));
  expect(
    verifyHistory({ log: [genesis] }, { expectedAssetId: ni }).state.assetId,
  ).toBe(id);
});
