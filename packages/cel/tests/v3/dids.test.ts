import { expect, test } from "bun:test";
import { parseAssetAlias, verifyHistory, CelError } from "../../src/v3/index.js";
import authority from "../../../../docs/research/cel-core-vectors/histories.json";
import symbolic from "../../../../docs/research/cel-authority-vectors/histories.json";

test("migration accepts canonical alias syntax but exposes WebVH method binding as unverified", () => {
  const result = verifyHistory({
    log: [authority.entries.G, authority.entries.W, authority.entries.T],
  });
  expect(result.state.alias).toBe("did:btco:reg:5000000000");
  expect(result.bitcoinAcceptance).toBe("unverified");
  expect(result.webvhBinding).toBe("unverified");
  const webvhAlias = parseAssetAlias(authority.entries.W.event.operation.data.to);
  expect(webvhAlias).toMatchObject({
    layer: "webvh",
    logUrl: "https://example.com/art/did.jsonl",
    methodBinding: "unverified",
  });
  // The lifecycle-layer discriminator, not a claim that the "cel" layer is a DID method.
  expect("method" in webvhAlias).toBe(false);
  expect(() =>
    verifyHistory({ log: [symbolic.entries.G, symbolic.entries.W] }),
  ).toThrow();
});
for (const did of [
  "did:btco:reg:00",
  "did:btco:reg:-1",
  "did:btco:reg:2099999997690000",
  "did:btco:reg:1#key",
  "did:btco:testnet4:1",
  "did:cel:invalid",
])
  test(`rejects noncanonical asset alias ${did}`, () => {
    expect(() => parseAssetAlias(did)).toThrow();
  });
test("rejects malformed WebVH paths, host and port without fetching them", () => {
  const scid = authority.entries.W.event.operation.data.to.split(":")[2];
  for (const tail of [
    "127.0.0.1:art",
    "example.com:%2E%2E",
    "example.com:a%2Fb",
    "example.com%3A65536",
    "example.com%3a3000",
    "example.com:",
  ]) {
    expect(() => parseAssetAlias(`did:webvh:${scid}:${tail}`)).toThrow();
  }
  try {
    parseAssetAlias(`did:webvh:${scid}:xn--bcher-kva.example:art`);
    throw new Error("unexpected acceptance");
  } catch (error) {
    expect(error).toBeInstanceOf(CelError);
    expect((error as CelError).status).toBe("unsupported");
  }
});

test("URL parser failures become structured invalid-DID results", () => {
  const scid = authority.entries.W.event.operation.data.to.split(":")[2];
  for (const host of ["example.123", "256.256.256.256"]) {
    try {
      parseAssetAlias(`did:webvh:${scid}:${host}`);
      throw new Error("unexpected acceptance");
    } catch (error) {
      expect(error).toBeInstanceOf(CelError);
      expect((error as CelError).status).toBe("invalid");
    }
  }
});
