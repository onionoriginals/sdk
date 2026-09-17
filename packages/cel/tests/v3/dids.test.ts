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

test("WebVH path segments containing a tilde: literal rejected, percent-encoded accepted and mapped to a literal HTTPS log path", () => {
  const scid = authority.entries.W.event.operation.data.to.split(":")[2];
  // RFC 3986 unreserved `~` is not a DID Core `idchar`; a literal tilde segment
  // must still be rejected the same way it always was.
  expect(() =>
    parseAssetAlias(`did:webvh:${scid}:example.com:~alice`),
  ).toThrow(/Invalid WebVH path component/);
  // The canonical percent-encoded spelling is a valid DID Core idchar sequence
  // and must be accepted, with the HTTPS log path leaving `~` literal per RFC 3986.
  const alias = parseAssetAlias(`did:webvh:${scid}:example.com:%7Ealice`);
  expect(alias).toMatchObject({
    layer: "webvh",
    logUrl: "https://example.com/~alice/did.jsonl",
    methodBinding: "unverified",
  });
  // Lowercase hex is a different (noncanonical) spelling of the same percent-encoding.
  expect(() =>
    parseAssetAlias(`did:webvh:${scid}:example.com:%7ealice`),
  ).toThrow(/Noncanonical WebVH path spelling/);
  // Control: an RFC 3986 sub-delim ('!') still round-trips through its canonical
  // percent-encoded form, showing the escaping machinery is otherwise unchanged.
  expect(() =>
    parseAssetAlias(`did:webvh:${scid}:example.com:%21alice`),
  ).not.toThrow();
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
