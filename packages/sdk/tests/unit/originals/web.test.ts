/**
 * Browser-safe helpers lifted from the apps (`web.ts`): a `HostedFetch` over
 * `fetch`, the shared-host transport, publication naming and upload order,
 * and the informational reasons. The public reader verifies through
 * `hostedFetch` exactly as through any other fetcher (P9.1); redirects are
 * refused (P8.5); an unanchored Original's `not-anchored` is informational
 * (P7.10).
 */
import { describe, expect, test } from "bun:test";
import { OriginalsError } from "@originals/vh";
import { localSigner } from "@originals/vh/crypto";
import { createLog, serializeLog, signWith } from "@originals/vh/log";
import type { AliasEvidence } from "@originals/vh/originals";
import { didWebvhFilesUrl } from "@originals/vh/webvh";
import { base64 } from "@scure/base";
import {
  INFORMATIONAL_REASONS, MemoryStore, OriginalsSDK, SubmitRefusedError, aliasSegment, blockingReasons, encodeSubmission, hostedFetch, hostedFiles,
  httpSharedHost, publicationUploads, readHostAnswer, siteKeyOf, uploadOrder, webvhAlias, type HostedFetchOptions,
} from "../../../src/originals/index.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const KEY = seed(27);

async function aliasFor(target: string): Promise<AliasEvidence> {
  const key = localSigner("Ed25519", seed(62));
  const k = key.publicKeyMultibase;
  const genesis = await createLog({
    versionTime: "2026-10-18T10:00:00Z",
    parameters: { method: "did:webvh:1.0", scid: "{SCID}", updateKeys: [k], portable: true },
    state: { id: `did:webvh:{SCID}:example.com:user-0123456789abcdef:${aliasSegment(target)}`, alsoKnownAs: [target] },
    sign: signWith(key, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${k}#${k}` }),
  });
  return { did: genesis.state.id as string, log: serializeLog([genesis]) };
}

async function published() {
  const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
  const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: clock() });
  const signer = alice.signer("orig", KEY);
  const c = await sdk.create({ name: "Sketch", resource: { mediaType: "image/png", bytes: bytes("one") }, author: alice.ref("orig"), signer });
  if (c.kind !== "original") throw new Error("expected an Original");
  const alias = await aliasFor(c.original.did);
  const p = await sdk.publish(c.original.did, { parent: c.original.checkpoint, author: alice.ref("orig"), signer, alias });
  return { alice, sdk, signer, did: c.original.did, alias, view: p.original };
}

const opts = (maxBytes = 1_000_000): HostedFetchOptions => ({ maxBytes, timeoutMs: 1000, signal: new AbortController().signal });

/** A fake `fetch` serving `files` by URL, recording each request. */
function server(files: Map<string, Uint8Array>, calls: Array<{ url: string; init: RequestInit }> = []) {
  return Object.assign(
    (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const data = files.get(url);
      return Promise.resolve(data ? new Response(data.slice()) : new Response("not found", { status: 404 }));
    },
    { calls },
  ) as unknown as typeof fetch & { calls: typeof calls };
}

async function refusal(p: Promise<unknown>): Promise<OriginalsError> {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(OriginalsError);
  return e as OriginalsError;
}

describe("hostedFetch", () => {
  test("the public reader verifies a published Original through it, the same as through any fetcher (P9.1)", async () => {
    const { sdk, did, alias } = await published();
    const base = didWebvhFilesUrl(alias.did);
    const files = new Map([...(await hostedFiles(sdk, did, alias))].map(([path, data]) => [`${base}${path}`, data]));
    const cache = new Map<string, Uint8Array>();
    const fetch = server(files);
    const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")) });
    const r = await reader.loadPublished(alias.did, hostedFetch({ fetch, cache }));
    expect(r.verified, JSON.stringify(r.reasons)).toBe(true);
    expect(r.report.original).toBe(did);
    // Every request omits credentials, refuses redirects and skips the HTTP cache; every response is cached by URL.
    for (const c of fetch.calls) expect(c.init).toMatchObject({ redirect: "manual", credentials: "omit", cache: "no-store" });
    expect(cache.get(`${base}originals/asset/did.jsonl`)).toEqual(files.get(`${base}originals/asset/did.jsonl`)!);
  });

  test("returns the bytes, and rewrites to `origin` keeping the path and query", async () => {
    const fetch = server(new Map([["http://localhost:5173/a/b.json?x=1", bytes("ok")]]));
    expect(await hostedFetch({ fetch, origin: "http://localhost:5173" })("https://example.com/a/b.json?x=1", opts())).toEqual(bytes("ok"));
    expect(fetch.calls[0].url).toBe("http://localhost:5173/a/b.json?x=1");
  });

  test("refuses as safeFetch does: scheme, status, redirect, size, network and abort", async () => {
    const at = (r: Response | Error) => hostedFetch({ fetch: (() => (r instanceof Error ? Promise.reject(r) : Promise.resolve(r))) as unknown as typeof fetch });
    const http = await refusal(hostedFetch({ fetch: server(new Map()) })("http://example.com/x", opts()));
    expect([http.category, http.code]).toEqual(["unavailable-bytes", "FETCH_SCHEME"]);

    const missing = await refusal(at(new Response("no", { status: 404 }))("https://example.com/x", opts()));
    expect([missing.category, missing.code, missing.details?.status]).toEqual(["unavailable-bytes", "FETCH_STATUS", 404]);

    const moved = await refusal(at(new Response(null, { status: 302, headers: { location: "https://elsewhere.example/x" } }))("https://example.com/x", opts()));
    expect(moved.code).toBe("FETCH_REDIRECT");

    const declared = await refusal(at(new Response(new Uint8Array(10), { headers: { "content-length": "10" } }))("https://example.com/x", opts(9)));
    expect([declared.code, declared.details?.bytesRead]).toEqual(["FETCH_TOO_LARGE", 0]);

    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(6)); c.enqueue(new Uint8Array(6)); c.close(); } });
    const streamed = await refusal(at(new Response(stream))("https://example.com/x", opts(9)));
    expect([streamed.code, streamed.details?.bytesRead]).toEqual(["FETCH_TOO_LARGE", 12]);

    const offline = await refusal(at(new TypeError("Failed to fetch"))("https://example.com/x", opts()));
    expect([offline.category, offline.code]).toEqual(["unavailable-bytes", "FETCH_FAILED"]);

    const controller = new AbortController();
    controller.abort();
    const aborted = await refusal(hostedFetch({ fetch: (() => Promise.reject(new DOMException("aborted", "AbortError"))) as unknown as typeof fetch })("https://example.com/x", { ...opts(), signal: controller.signal }));
    expect(aborted.code).toBe("FETCH_ABORTED");
  });
});

describe("the shared-host transport (P6.7, P6.8)", () => {
  test("encodeSubmission: base64 resources, identity logs as text, did:btco identities left out", () => {
    const body = JSON.parse(encodeSubmission({
      original: "did:vh:zA", entry: '{"versionId":"2-x"}', resources: { zD: bytes("bytes") },
      identities: [{ did: "did:vh:zAuthor", log: "line\n", witness: [{ versionId: "1-x", proof: [] }] }, { did: "did:btco:123" }],
    })) as Record<string, unknown>;
    expect(body).toEqual({
      original: "did:vh:zA", entry: '{"versionId":"2-x"}', resources: { zD: base64.encode(bytes("bytes")) },
      identities: [{ did: "did:vh:zAuthor", log: "line\n", witness: [{ versionId: "1-x", proof: [] }] }],
    });
  });

  test("readHostAnswer: 200 accepted or already accepted, 409 stale parent, anything else refused", () => {
    expect(readHostAnswer(200, { status: "accepted", checkpoint: "2-a", head: "2-a" })).toEqual({ status: "accepted", checkpoint: "2-a", head: "2-a" });
    expect(readHostAnswer(200, { status: "already-accepted", checkpoint: "2-a", head: "3-b" }).status).toBe("already-accepted");
    expect(readHostAnswer(409, { status: "stale-parent", head: "3-b" })).toEqual({ status: "stale-parent", head: "3-b" });
    for (const [status, body] of [[409, { status: "accepted" }], [200, { status: "stale-parent" }], [403, { error: "forbidden" }], [507, { error: "store_full" }], [500, "oops"]] as const) {
      const e = (() => { try { readHostAnswer(status, body); } catch (x) { return x; } })() as SubmitRefusedError;
      expect(e).toBeInstanceOf(SubmitRefusedError);
      expect([e.code, e.status, e.body]).toEqual(["SUBMIT_REFUSED", status, body]);
    }
  });

  test("httpSharedHost sends to the alias's site key and reads back through the alias", async () => {
    const { sdk, alias } = await published();
    const sent: Array<[string, string]> = [];
    const read = hostedFetch({ fetch: server(new Map()) });
    const host = httpSharedHost({ sdk, aliasDid: alias.did, read, send: (key, body) => (sent.push([key, body]), Promise.resolve({ status: 409, body: { status: "stale-parent", head: "9-z" } })) });
    const submission = { original: "did:vh:zA", entry: "{}", resources: {}, identities: [] };
    expect(await host.submit(submission)).toEqual({ status: "stale-parent", head: "9-z" });
    expect(sent).toEqual([[siteKeyOf(alias.did), encodeSubmission(submission)]]);
    expect(siteKeyOf(alias.did)).toMatch(/^example\.com\/user-0123456789abcdef\/o-/);
    // Nothing is hosted here: reading back is unavailable, never a result.
    expect((await refusal(host.accepted("did:vh:zA"))).category).toBe("unavailable-bytes");
  });
});

describe("hosted publication naming and upload order", () => {
  test("aliasSegment, webvhAlias", async () => {
    const { did, alias, view } = await published();
    expect(aliasSegment(did)).toBe(`o-${did.slice(7, 23)}`);
    expect(() => aliasSegment("did:webvh:x:example.com")).toThrow(OriginalsError);
    expect(webvhAlias(view.state.aliases)).toBe(alias.did);
    expect(webvhAlias(["did:btco:1"])).toBeUndefined();
  });

  test("publicationUploads: alias log first, then the asset log, then the rest, resources last", async () => {
    const { sdk, did, alias } = await published();
    const uploads = await publicationUploads(sdk, did, alias);
    const orders = uploads.map((u) => uploadOrder(u.path));
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    expect(uploads[0].path).toMatch(/did\.jsonl$/);
    expect(uploadOrder(uploads[0].path)).toBe(0);
    expect(uploads.find((u) => uploadOrder(u.path) === 1)?.path).toBe("originals/asset/did.jsonl");
    expect(uploads[uploads.length - 1].path).toMatch(/^originals\/resources\//);
    for (const u of uploads) expect(u.key).toBe(`${siteKeyOf(alias.did)}/${u.path}`);
    expect(new Map(uploads.map((u) => [u.path, u.bytes]))).toEqual(await hostedFiles(sdk, did, alias));
  });
});

describe("informational reasons (P7.10)", () => {
  test("a valid unanchored Original has no blocking reason; anything else stays", async () => {
    const { view } = await published();
    expect(view.report.reasons).toEqual(["not-anchored"]);
    expect(blockingReasons(view.report.reasons)).toEqual([]);
    expect([...INFORMATIONAL_REASONS]).toEqual(["not-anchored"]);
    expect(blockingReasons(["not-anchored", "fork-unresolved", "identity-evidence-incomplete"])).toEqual(["fork-unresolved", "identity-evidence-incomplete"]);
  });
});
