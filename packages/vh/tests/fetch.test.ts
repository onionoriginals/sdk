/**
 * The SSRF-safe fetcher (plan 011, PR 7b; P8.5 and the VH-Log retrieval
 * rules): HTTPS only, no redirects, no private or special-use addresses before
 * or after DNS, and bounded size and time. Every refusal is unavailable bytes.
 */
import { describe, expect, test } from "bun:test";
import { OriginalsError } from "../src/errors.js";
import { FETCH_LIMITS, isPublicAddress, safeFetch, type FetchTransport } from "../src/fetch/index.js";

const body = (...chunks: string[]) =>
  (async function* () {
    for (const c of chunks) yield new TextEncoder().encode(c);
  })();

function transport(response: { status?: number; headers?: Record<string, string>; chunks?: string[] }, seen: string[] = []): FetchTransport {
  return ({ address }) => {
    seen.push(address);
    return Promise.resolve({ status: response.status ?? 200, headers: response.headers ?? {}, body: body(...(response.chunks ?? ["ok"])) });
  };
}

const publicDns = () => Promise.resolve(["93.184.215.14"]);

async function refused(run: Promise<unknown>, code: string) {
  const error = await run.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(OriginalsError);
  expect((error as OriginalsError).category).toBe("unavailable-bytes");
  expect((error as OriginalsError).code).toBe(code);
}

describe("address classification", () => {
  test("private, loopback, link-local, special-use and mapped addresses are not public", () => {
    for (const a of [
      "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.8",
      "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "240.0.0.1", "255.255.255.255",
      "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2001:db8::1", "100::1",
      // Special-purpose ranges that can reach private space through a relay or translator.
      "64:ff9b:1::a9fe:a9fe", "2002:7f00:1::", "2002:a9fe:a9fe::1", "2001::1", "2001:0:4136:e378::1", "fec0::1", "::ffff:0:7f00:1", "192.88.99.1",
    ]) expect(isPublicAddress(a), a).toBe(false);
    for (const a of ["93.184.215.14", "8.8.8.8", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicAddress(a), a).toBe(true);
    expect(isPublicAddress("not an address")).toBe(false);
  });
});

describe("C12-81: a locator that resolves or redirects to a private address is refused", () => {
  test("a hostname whose DNS answers include a private address is refused before connecting", async () => {
    const seen: string[] = [];
    await refused(safeFetch("https://example.com/did.jsonl", { resolve: () => Promise.resolve(["93.184.215.14", "10.0.0.5"]), transport: transport({}, seen) }), "FETCH_PRIVATE_ADDRESS");
    await refused(safeFetch("https://internal.example/did.jsonl", { resolve: () => Promise.resolve(["127.0.0.1"]), transport: transport({}, seen) }), "FETCH_PRIVATE_ADDRESS");
    expect(seen).toEqual([]);
  });

  test("an IP-literal locator in a private range is refused", async () => {
    for (const url of ["https://169.254.169.254/latest", "https://[::1]/x", "https://[::ffff:10.0.0.1]/x"]) {
      await refused(safeFetch(url, { transport: transport({}) }), "FETCH_PRIVATE_ADDRESS");
    }
  });

  test("redirects are never followed", async () => {
    await refused(safeFetch("https://example.com/did.jsonl", { resolve: publicDns, transport: transport({ status: 302, headers: { location: "https://127.0.0.1/" } }) }), "FETCH_REDIRECT");
  });

  test("the connection goes to the vetted address, not a second lookup", async () => {
    const seen: string[] = [];
    const r = await safeFetch("https://example.com/did.jsonl", { resolve: publicDns, transport: transport({ headers: { "content-type": "text/jsonl" } }, seen) });
    expect(seen).toEqual(["93.184.215.14"]);
    expect(new TextDecoder().decode(r.bytes)).toBe("ok");
    expect(r.mediaType).toBe("text/jsonl");
  });
});

describe("C12-78: a log larger than the profile cap is refused", () => {
  test("by declared length, before reading", async () => {
    await refused(safeFetch("https://example.com/did.jsonl", { resolve: publicDns, maxBytes: 10, transport: transport({ headers: { "content-length": "11" } }) }), "FETCH_TOO_LARGE");
  });

  test("by the bytes that actually arrive", async () => {
    await refused(safeFetch("https://example.com/did.jsonl", { resolve: publicDns, maxBytes: 10, transport: transport({ chunks: ["123456", "7890", "1"] }) }), "FETCH_TOO_LARGE");
  });

  test("the default caps are bounded", () => {
    expect(FETCH_LIMITS.maxBytes).toBeGreaterThan(0);
    expect(FETCH_LIMITS.timeoutMs).toBeLessThanOrEqual(30_000);
  });
});

describe("other refusals", () => {
  test("non-HTTPS schemes, credentials in the URL and non-2xx statuses", async () => {
    await refused(safeFetch("http://example.com/did.jsonl", { resolve: publicDns, transport: transport({}) }), "FETCH_SCHEME");
    await refused(safeFetch("file:///etc/passwd", { transport: transport({}) }), "FETCH_SCHEME");
    await refused(safeFetch("https://user:pw@example.com/x", { resolve: publicDns, transport: transport({}) }), "FETCH_CREDENTIALS");
    await refused(safeFetch("https://example.com/x", { resolve: publicDns, transport: transport({ status: 404 }) }), "FETCH_STATUS");
    await refused(safeFetch("not a url"), "FETCH_URL");
  });

  test("a response that does not arrive in time", async () => {
    const never: FetchTransport = ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    await refused(safeFetch("https://example.com/x", { resolve: publicDns, transport: never, timeoutMs: 20 }), "FETCH_TIMEOUT");
  });

  test("a DNS lookup that hangs counts against the timeout", async () => {
    await refused(safeFetch("https://example.com/x", { resolve: () => new Promise(() => undefined), transport: transport({}), timeoutMs: 20 }), "FETCH_TIMEOUT");
  });

  test("a caller's abort signal ends the request (a whole-operation deadline)", async () => {
    const never: FetchTransport = ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await refused(safeFetch("https://example.com/x", { resolve: publicDns, transport: never, signal: controller.signal }), "FETCH_ABORTED");
    const seen: string[] = [];
    await refused(safeFetch("https://example.com/x", { resolve: publicDns, transport: transport({}, seen), signal: AbortSignal.abort() }), "FETCH_ABORTED");
    expect(seen).toEqual([]);
  });

  test("a hostname that does not resolve", async () => {
    await refused(safeFetch("https://example.invalid/x", { resolve: () => Promise.resolve([]), transport: transport({}) }), "FETCH_DNS");
  });
});
