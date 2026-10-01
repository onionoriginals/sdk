import { expect, test } from "bun:test";
import {
  parseAssetAlias,
  verifyHistory,
  CelError,
  encodeWebVHPathSegment,
  isWebVHPathSegment,
  canonicalWebVHPaths,
  canonicalizeWebVHDomain,
} from "../../src/v3/index.js";
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

const PATH_CANDIDATES = [
  " hello", "hello ", "   ", "\thello", "hello\u00a0", "\ufeffx", "", ".", "..", "...",
  "a/b", "a\\b", "a\0b", "hello world", "café", "x~y", "a:b", "C:foo", "C:\\win",
  ".well-known", "%41", "😀", "a\ud800",
];

test("isWebVHPathSegment agrees with parseAssetAlias on every candidate", () => {
  const scid = authority.entries.W.event.operation.data.to.split(":")[2];
  const reads = (value: string) => {
    try {
      parseAssetAlias(`did:webvh:${scid}:example.com:${encodeWebVHPathSegment(value)}`);
      return true;
    } catch {
      return false;
    }
  };
  for (const value of PATH_CANDIDATES)
    expect([value, isWebVHPathSegment(value)]).toEqual([value, reads(value)]);
  expect(isWebVHPathSegment(123)).toBe(false);
});

test("canonicalWebVHPaths encodes decoded segments in DID spelling", () => {
  expect(canonicalWebVHPaths(["hello world", "x~y", "a:b"])).toEqual({
    ok: true,
    segments: ["hello%20world", "x%7Ey", "a%3Ab"],
  });
  expect(canonicalWebVHPaths([])).toEqual({ ok: true, segments: [] });
});

test("canonicalWebVHPaths rejects non-arrays, non-strings and invalid segments", () => {
  for (const paths of ["abc", [123], [" hello"], ["ok", ".."], [""], ["a\ud800"], undefined])
    expect(canonicalWebVHPaths(paths)).toEqual({ ok: false, reason: "invalid" });
});

test("canonicalWebVHPaths reserves only a leading .well-known, case-insensitively", () => {
  for (const first of [".well-known", ".WELL-KNOWN", ".Well-Known"])
    expect(canonicalWebVHPaths([first, "x"])).toEqual({ ok: false, reason: "reserved" });
  expect(canonicalWebVHPaths(["users", ".well-known"])).toEqual({
    ok: true,
    segments: ["users", ".well-known"],
  });
});

test("parseAssetAlias still reads a .well-known path DID", () => {
  const scid = authority.entries.W.event.operation.data.to.split(":")[2];
  expect(parseAssetAlias(`did:webvh:${scid}:example.com:.well-known`)).toMatchObject({
    logUrl: "https://example.com/.well-known/did.jsonl",
  });
});

const CANONICAL_DOMAINS: [string, string][] = [
  ["example.com", "example.com"],
  ["example.com:443", "example.com"],
  ["example.com:08080", "example.com:8080"],
  [" Example.COM:8080 ", "example.com:8080"],
  ["sub.example.co.uk:65535", "sub.example.co.uk:65535"],
];

function celCode(fn: () => unknown): [string, string] | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CelError);
    return [(error as CelError).status, (error as CelError).code];
  }
  return undefined;
}

test("canonicalizeWebVHDomain returns the URL#host spelling", () => {
  for (const [input, expected] of CANONICAL_DOMAINS) {
    const out = canonicalizeWebVHDomain(input);
    expect([input, out]).toEqual([input, expected]);
    expect(new URL("https://" + out).host).toBe(out);
  }
});

test("canonicalizeWebVHDomain rejects non-DNS hosts with INVALID_DOMAIN", () => {
  for (const domain of [
    "localhost", "localhost:3000", "127.0.0.1", "10.0.0.1:8080", "1.2.3", "example.0x10",
    "intranet", "web:3000", "example.com.", "-a.com", "a_b.com", "example.com:0",
    "example.com:65536", "example.com:", "example.com:80:1", "example.com/x", "",
  ])
    expect([domain, celCode(() => canonicalizeWebVHDomain(domain))]).toEqual([
      domain,
      ["invalid", "INVALID_DOMAIN"],
    ]);
  for (const domain of ["xn--bcher-kva.example", "bücher.example"])
    expect(celCode(() => canonicalizeWebVHDomain(domain))).toEqual([
      "unsupported",
      "CEL_WEBVH_IDNA",
    ]);
});

test("canonicalizeWebVHDomain allowLocalhost admits only localhost[:port]", () => {
  const opts = { allowLocalhost: true };
  expect(canonicalizeWebVHDomain("localhost", opts)).toBe("localhost");
  expect(canonicalizeWebVHDomain("LOCALHOST:3000", opts)).toBe("localhost:3000");
  expect(canonicalizeWebVHDomain("example.com:443", opts)).toBe("example.com");
  for (const domain of ["127.0.0.1", "intranet", "localhost:0", "localhost.:3000"])
    expect(celCode(() => canonicalizeWebVHDomain(domain, opts))).toEqual([
      "invalid",
      "INVALID_DOMAIN",
    ]);
});

test("every asset-canonical domain round-trips through parseAssetAlias", () => {
  const scid = authority.entries.W.event.operation.data.to.split(":")[2];
  for (const [input] of CANONICAL_DOMAINS) {
    const out = canonicalizeWebVHDomain(input);
    const alias = parseAssetAlias(`did:webvh:${scid}:${out.replace(":", "%3A")}`);
    if (alias.layer !== "webvh") throw new Error("expected a webvh alias");
    expect(new URL(alias.logUrl).host).toBe(out);
  }
});
