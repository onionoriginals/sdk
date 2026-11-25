/**
 * Fetching evidence for a did:og verification (P8.5, P14.13): the §8 verifier
 * rows. A refused fetch adds nothing to the evidence set and says why.
 */
import { describe, expect, test } from "bun:test";
import type { FetchTransport } from "../src/fetch/index.js";
import { FETCH_CAPS, fetchEvidence, type FetchedEvidence } from "../src/og/fetch.js";

const MiB = 1024 * 1024;
const publicDns = () => Promise.resolve(["93.184.215.14"]);

/** A transport answering `size` bytes in 1 MiB chunks, recording the address it was asked to connect to. */
function sized(size: number, seen: string[] = [], declare = false): FetchTransport {
  return ({ address }) => {
    seen.push(address);
    const chunk = new Uint8Array(MiB);
    return Promise.resolve({
      status: 200,
      headers: declare ? { "content-length": String(size) } : {},
      body: (async function* () {
        let left = size;
        while (left > 0) {
          const n = Math.min(left, MiB);
          yield n === MiB ? chunk : chunk.subarray(0, n);
          left -= n;
        }
      })(),
    });
  };
}

function refusedWith(r: FetchedEvidence, code: string) {
  expect(r.status).toBe("refused");
  if (r.status !== "refused") return;
  expect(r.code).toBe(code);
  expect(r.reason.length).toBeGreaterThan(0);
  expect("input" in r).toBe(false);
}

describe("T8-012, T8-001: a fetched log file is capped at 16 MiB", () => {
  test("16 MiB is fetched; 16 MiB plus one byte is refused with the cap as its reason", async () => {
    expect(FETCH_CAPS.log).toBe(16 * MiB);
    expect(FETCH_CAPS["signer-history"]).toBe(16 * MiB);
    const ok = await fetchEvidence("https://example.com/did.jsonl", "log", { resolve: publicDns, transport: sized(16 * MiB) });
    expect(ok.status).toBe("fetched");
    if (ok.status === "fetched") {
      expect(ok.input.kind).toBe("log");
      expect(ok.input.bytes.length).toBe(16 * MiB);
    }
    const over = await fetchEvidence("https://example.com/did.jsonl", "log", { resolve: publicDns, transport: sized(16 * MiB + 1) });
    refusedWith(over, "FETCH_TOO_LARGE");
    if (over.status === "refused") expect(over.reason).toContain(String(16 * MiB));
    // A declared length over the cap is refused before the body is read.
    refusedWith(await fetchEvidence("https://example.com/did.jsonl", "signer-history", { resolve: publicDns, transport: sized(16 * MiB + 1, [], true) }), "FETCH_TOO_LARGE");
  });
});

describe("T8-011: a fetched resource is capped at 64 MiB", () => {
  test("64 MiB is fetched; 64 MiB plus one byte is refused with the cap as its reason", async () => {
    expect(FETCH_CAPS.resource).toBe(64 * MiB);
    const ok = await fetchEvidence("https://example.com/r.png", "resource", { resolve: publicDns, transport: sized(64 * MiB) });
    expect(ok.status).toBe("fetched");
    if (ok.status === "fetched") expect(ok.input.bytes.length).toBe(64 * MiB);
    const over = await fetchEvidence("https://example.com/r.png", "resource", { resolve: publicDns, transport: sized(64 * MiB + 1) });
    refusedWith(over, "FETCH_TOO_LARGE");
    if (over.status === "refused") expect(over.reason).toContain(String(64 * MiB));
  }, 30_000);
});

describe("T8-002: a locator resolving or redirecting to a private address is refused", () => {
  test("any private answer refuses the fetch before connecting", async () => {
    const seen: string[] = [];
    refusedWith(await fetchEvidence("https://example.com/did.jsonl", "log", { resolve: () => Promise.resolve(["93.184.215.14", "10.0.0.5"]), transport: sized(1, seen) }), "FETCH_PRIVATE_ADDRESS");
    refusedWith(await fetchEvidence("https://internal.example/did.jsonl", "log", { resolve: () => Promise.resolve(["169.254.169.254"]), transport: sized(1, seen) }), "FETCH_PRIVATE_ADDRESS");
    expect(seen).toEqual([]);
  });

  test("a redirect is never followed, so it cannot lead to a private address", async () => {
    const redirect: FetchTransport = () => Promise.resolve({ status: 302, headers: { location: "https://127.0.0.1/" }, body: (async function* () {})() });
    refusedWith(await fetchEvidence("https://example.com/did.jsonl", "log", { resolve: publicDns, transport: redirect }), "FETCH_REDIRECT");
  });
});

describe("T8-007: a locator whose host is an IP literal is refused", () => {
  test("public and private literals alike, in any spelling the URL parser accepts", async () => {
    const seen: string[] = [];
    for (const u of ["https://93.184.215.14/did.jsonl", "https://127.0.0.1/did.jsonl", "https://[2606:4700:4700::1111]/did.jsonl", "https://[::1]/x", "https://2130706433/x", "https://0x7f.1/x", "https://%31%32%37.0.0.1/x"]) {
      refusedWith(await fetchEvidence(u, "log", { resolve: publicDns, transport: sized(1, seen) }), "FETCH_IP_LITERAL");
    }
    expect(seen).toEqual([]);
  });
});

describe("T8-008: the fetcher connects only to the address it validated", () => {
  test("a resolver that would answer privately on a second lookup is never asked again", async () => {
    let lookups = 0;
    const rebinding = () => Promise.resolve(lookups++ === 0 ? ["93.184.215.14"] : ["127.0.0.1"]);
    const seen: string[] = [];
    const r = await fetchEvidence("https://rebind.example/did.jsonl", "log", { resolve: rebinding, transport: sized(4, seen) });
    expect(r.status).toBe("fetched");
    expect(lookups).toBe(1);
    expect(seen).toEqual(["93.184.215.14"]);
  });

  test("a check that already answers privately refuses the fetch", async () => {
    refusedWith(await fetchEvidence("https://rebind.example/did.jsonl", "log", { resolve: () => Promise.resolve(["127.0.0.1"]), transport: sized(1) }), "FETCH_PRIVATE_ADDRESS");
  });
});

describe("T8-009: percent-encoded segments are decoded before the checks", () => {
  test("%2e%2e and its spellings are a dot segment; encoded separators are refused", async () => {
    const seen: string[] = [];
    for (const u of ["https://example.com/a/%2e%2e/did.jsonl", "https://example.com/a/%2E%2E/did.jsonl", "https://example.com/a/.%2e/x", "https://example.com/a/../x", "https://example.com/a/%2e/x", "https://example.com/a%2f..%2fx", "https://example.com/a%5c..%5cx"]) {
      refusedWith(await fetchEvidence(u, "log", { resolve: publicDns, transport: sized(1, seen) }), "FETCH_PATH");
    }
    refusedWith(await fetchEvidence("https://example.com/a/%zz", "log", { resolve: publicDns, transport: sized(1, seen) }), "FETCH_URL");
    expect(seen).toEqual([]);
    // Encoded ordinary characters decode to a locator that passes.
    expect((await fetchEvidence("https://example.com/a%20b/did.jsonl", "log", { resolve: publicDns, transport: sized(1) })).status).toBe("fetched");
  });
});

describe("T8-010: a fetch is bounded at 15 seconds", () => {
  test("the default limit is 15 s; a fetch that answers within it completes", async () => {
    const { OG_LIMITS } = await import("../src/og/rules.js");
    expect(OG_LIMITS.fetchMs).toBe(15_000);
    const slow: FetchTransport = (req) => new Promise((resolve) => setTimeout(() => resolve(sized(2)(req)), 5));
    expect((await fetchEvidence("https://example.com/did.jsonl", "log", { resolve: publicDns, transport: slow, timeoutMs: 1_000 })).status).toBe("fetched");
  });

  test("a fetch past the limit is abandoned, with the limit as its reason", async () => {
    // A transport that never answers, released only by the abort signal: deterministic, no wall-clock race.
    const never: FetchTransport = ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    const r = await fetchEvidence("https://example.com/did.jsonl", "log", { resolve: publicDns, transport: never, timeoutMs: 20 });
    refusedWith(r, "FETCH_TIMEOUT");
    if (r.status === "refused") expect(r.reason).toContain("20 ms");
  });
});

describe("P8.5: only https, never credentials", () => {
  test("other schemes and credentials are refused", async () => {
    refusedWith(await fetchEvidence("http://example.com/did.jsonl", "log", { resolve: publicDns, transport: sized(1) }), "FETCH_SCHEME");
    refusedWith(await fetchEvidence("https://u:p@example.com/did.jsonl", "log", { resolve: publicDns, transport: sized(1) }), "FETCH_CREDENTIALS");
    refusedWith(await fetchEvidence("not a url", "log"), "FETCH_URL");
  });
});
