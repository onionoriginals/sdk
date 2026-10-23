/**
 * Publication and the public reader (plan 011, PR 7b): publishing lists a
 * did:webvh alias (P3.6; no witnesses, owner decision Q14); the hosted snapshot
 * is verified exactly, never mixed (P9.1); resources are served isolated (P9.7).
 */
import { describe, expect, test } from "bun:test";
import { OriginalsError } from "@originals/vh";
import { localSigner } from "@originals/vh/crypto";
import { createLog, serializeLog, signWith } from "@originals/vh/log";
import { resourceDigest, type AliasEvidence } from "@originals/vh/originals";
import { didWebvhFilesUrl } from "@originals/vh/webvh";
import { MemoryStore, OriginalsSDK, RETRIEVAL_LIMITS, hostedFiles, servingHeaders, type HostedFetch, type HostedFetchOptions } from "../../../src/originals/index.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const KEY = seed(21);
const B1 = bytes("first crop");
const B2 = bytes("tighter crop");

async function aliasFor(target: string, domain = "example.com"): Promise<AliasEvidence> {
  const key = localSigner("Ed25519", seed(61));
  const k = key.publicKeyMultibase;
  const genesis = await createLog({
    versionTime: "2026-10-18T10:00:00Z",
    parameters: { method: "did:webvh:1.0", scid: "{SCID}", updateKeys: [k], portable: true },
    state: { id: `did:webvh:{SCID}:${domain}:photos`, alsoKnownAs: [target] },
    sign: signWith(key, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${k}#${k}` }),
  });
  return { did: genesis.state.id as string, log: serializeLog([genesis]) };
}

async function published() {
  const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
  const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => alice.evidence(), freshness: "asserted", clock: clock() });
  const signer = alice.signer("orig", KEY);
  const c = await sdk.create({ name: "Harbor at dawn", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: B1 }], author: alice.ref("orig"), signer });
  if (c.kind !== "original") throw new Error("expected an Original");
  const did = c.original.did;
  const alias = await aliasFor(did);
  const p = await sdk.publish(did, { parent: c.original.checkpoint, author: alice.ref("orig"), signer, alias });
  const e = await sdk.edit(did, { parent: p.original.checkpoint, resources: [{ id: "photo", bytes: B2 }], author: alice.ref("orig"), signer });
  const files = await hostedFiles(sdk, did, alias);
  return { alice, sdk, signer, did, alias, files, published: p.original, head: e.original.checkpoint };
}

/** A host: the hosted files under the alias's #files base. */
function host(files: Map<string, Uint8Array>, base: string): HostedFetch {
  return (url) => {
    const path = url.startsWith(base) ? url.slice(base.length) : undefined;
    const data = path === undefined ? undefined : files.get(path);
    if (!data) return Promise.reject(new OriginalsError("unavailable-bytes", "FETCH_STATUS", `${url} answered 404`));
    return Promise.resolve(data.slice());
  };
}

const stranger = () => OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")) });

describe("publishing (P3.6, P9.8)", () => {
  test("publication is one entry that lists the confirmed alias", async () => {
    const { published: p, alias } = await published();
    expect(p.state.aliases).toEqual([alias.did]);
    expect(p.report.aliases).toEqual([{ did: alias.did, status: "confirmed" }]);
    expect(p.report.ordering).toBe("claimed");
  });

  test("an alias that does not point back to the Original cannot be published", async () => {
    const { sdk, alice, signer } = await published();
    const c = await sdk.create({ name: "Other", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: B1 }], author: alice.ref("orig"), signer });
    if (c.kind !== "original") throw new Error("expected an Original");
    const wrong = await aliasFor("did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ");
    await expect(sdk.publish(c.original.did, { parent: c.original.checkpoint, author: alice.ref("orig"), signer, alias: wrong })).rejects.toMatchObject({ code: "ALIAS_NOT_CONFIRMED" });
  });
});

describe("the public reader verifies one exact snapshot (P9.1)", () => {
  test("a stranger reads the published Original through its did:webvh, with no key", async () => {
    const { did, alias, files, head } = await published();
    const r = await stranger().loadPublished(alias.did, host(files, didWebvhFilesUrl(alias.did)));
    expect(r.verified, JSON.stringify(r.reasons)).toBe(true);
    expect(r.report.original).toBe(did);
    expect(r.report.checkpoint).toBe(head);
    expect(r.alias.status).toBe("confirmed");
    expect(r.report.ordering).toBe("claimed"); // no witnesses (owner decision Q14)
    expect(r.report.resources.versions.map((v) => v.bytes)).toEqual(["verified", "verified"]);
  });

  test("C12-26: bytes from another version under a resource's digest are rejected before the result is verified", async () => {
    const { alias, files } = await published();
    const mixed = new Map(files);
    mixed.set(`originals/resources/${resourceDigest(B2)}`, B1);
    const r = await stranger().loadPublished(alias.did, host(mixed, didWebvhFilesUrl(alias.did)));
    expect(r.verified).toBe(false);
    expect(r.report.resources.status).toBe("digest-failure");
  });

  test("C12-26: a snapshot whose served history runs past its checkpoint is not verified", async () => {
    const { alias, files, published: p } = await published();
    const mixed = new Map(files);
    const manifest = JSON.parse(new TextDecoder().decode(files.get("originals/originals-evidence.json"))) as Record<string, unknown>;
    // The manifest claims the publication checkpoint, while the log and bytes are those of the later head.
    mixed.set("originals/originals-evidence.json", bytes(JSON.stringify({ ...manifest, checkpoint: p.checkpoint })));
    const r = await stranger().loadPublished(alias.did, host(mixed, didWebvhFilesUrl(alias.did)));
    expect(r.verified).toBe(false);
  });

  test("a snapshot of a different Original than the alias names gives no result", async () => {
    const { alias, files } = await published();
    const mixed = new Map(files);
    const manifest = JSON.parse(new TextDecoder().decode(files.get("originals/originals-evidence.json"))) as Record<string, unknown>;
    mixed.set("originals/originals-evidence.json", bytes(JSON.stringify({ ...manifest, original: "did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ" })));
    await expect(stranger().loadPublished(alias.did, host(mixed, didWebvhFilesUrl(alias.did)))).rejects.toMatchObject({ code: "ALIAS_NOT_CONFIRMED" });
  });

  test("C12-66: a did:webvh that points at an Original whose state does not list it gives no result", async () => {
    const { sdk, alice, signer } = await published();
    // Another Original, never published: an attacker's did:webvh claims it and hosts its real evidence.
    const c = await sdk.create({ name: "Never published", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: B1 }], author: alice.ref("orig"), signer });
    if (c.kind !== "original") throw new Error("expected an Original");
    const claim = await aliasFor(c.original.did, "evil.example");
    const files = await hostedFiles(sdk, c.original.did, claim);
    await expect(stranger().loadPublished(claim.did, host(files, didWebvhFilesUrl(claim.did)))).rejects.toMatchObject({ code: "ALIAS_NOT_CONFIRMED" });
  });

  test("missing bytes leave the snapshot verified, with the content reported unavailable (P7.3, P7.4, P9.18)", async () => {
    const { alias, files } = await published();
    const partial = new Map(files);
    partial.delete(`originals/resources/${resourceDigest(B1)}`);
    const r = await stranger().loadPublished(alias.did, host(partial, didWebvhFilesUrl(alias.did)));
    expect(r.verified).toBe(true);
    expect(r.report.resources.status).toBe("partial");
    expect(r.report.resources.missing.map((v) => v.digest)).toEqual([resourceDigest(B1)]);
    expect(r.reasons).not.toContain("resources-partial");
    // Bytes that are served but wrong still fail.
    const wrong = new Map(files);
    wrong.set(`originals/resources/${resourceDigest(B1)}`, bytes("not the first crop"));
    const bad = await stranger().loadPublished(alias.did, host(wrong, didWebvhFilesUrl(alias.did)));
    expect(bad.verified).toBe(false);
    expect(bad.report.resources.status).toBe("digest-failure");
  });

  test("retrieveHosted reads the snapshot's contents unverified, within the same bounds, for a shared host's accepted log (P6.8)", async () => {
    const { did, alias, files, head } = await published();
    const contents = await stranger().retrieveHosted(alias.did, host(files, didWebvhFilesUrl(alias.did)));
    expect(contents.manifest.checkpoint).toBe(head);
    expect(contents.log.trimEnd().split("\n")).toHaveLength(3);
    expect(Object.keys(contents.bytes).sort()).toEqual([resourceDigest(B1), resourceDigest(B2)].sort());
    expect(contents.authors.map((a) => a.did)).toHaveLength(1);
    // A reader that syncs from it verifies it before storing anything.
    const reader = stranger();
    const synced = await reader.sync(did, { submit: () => Promise.reject(new Error("unused")), accepted: () => Promise.resolve(contents) });
    expect(synced.status).toBe("imported");
    await expect(reader.sync("did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ", { submit: () => Promise.reject(new Error("unused")), accepted: () => Promise.resolve(contents) })).rejects.toMatchObject({ code: "IMPORT_REJECTED" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(stranger().retrieveHosted(alias.did, host(files, didWebvhFilesUrl(alias.did)), { signal: aborted.signal })).rejects.toBeInstanceOf(OriginalsError);
  });

  test("the hosted files are the same for a retried publication of the same checkpoint (P9.2)", async () => {
    const { sdk, did, alias, files } = await published();
    const again = await hostedFiles(sdk, did, alias);
    expect([...again.keys()].sort()).toEqual([...files.keys()].sort());
    for (const [path, data] of files) expect(again.get(path)).toEqual(data);
  });
});

describe("serving resources (P9.7)", () => {
  test("C12-84: active content is served with its signed type, no sniffing and a sandboxing policy", () => {
    for (const type of ["image/svg+xml", "text/html", "application/xhtml+xml"]) {
      const h = servingHeaders(type);
      expect(h["Content-Type"]).toBe(type);
      expect(h["X-Content-Type-Options"]).toBe("nosniff");
      expect(h["Content-Security-Policy"]).toContain("sandbox");
      expect(h["Content-Security-Policy"]).toContain("script-src 'none'");
    }
    expect(servingHeaders("image/jpeg")["X-Content-Type-Options"]).toBe("nosniff");
    for (const type of ["application/rss+xml", "application/xslt+xml", "text/xsl", "application/pdf", "image/svg+xml; charset=utf-8"]) {
      expect(servingHeaders(type)["Content-Disposition"], type).toBe("attachment");
    }
  });
});

// ---------------------------------------------------------------------------
// Whole-operation retrieval budget (issue #970). These are implementation limits
// (PROVISIONAL), not protocol rules: an exhausted budget is a stable
// `limit-exceeded` failure (section 6), never a verified result.

interface Call {
  path: string;
  options?: HostedFetchOptions;
}

/**
 * An instrumented host. `cooperative` hosts honour `maxBytes` the way
 * `safeFetch` does (FETCH_TOO_LARGE); others ignore every option. `hang` lists
 * paths that never answer: a cooperative host gives up when its signal aborts.
 */
function instrumented(files: Map<string, Uint8Array>, base: string, behaviour: { cooperative?: boolean; hang?: (path: string) => boolean } = {}) {
  const calls: Call[] = [];
  let served = 0;
  const fetch: HostedFetch = (url, options) => {
    const path = url.startsWith(base) ? url.slice(base.length) : url;
    calls.push({ path, ...(options ? { options } : {}) });
    if (behaviour.hang?.(path)) {
      return new Promise<Uint8Array>((_, reject) => {
        if (behaviour.cooperative) options?.signal.addEventListener("abort", () => reject(new OriginalsError("unavailable-bytes", "FETCH_TIMEOUT", `${url} timed out`)));
      });
    }
    const data = files.get(path);
    if (!data) return Promise.reject(new OriginalsError("unavailable-bytes", "FETCH_STATUS", `${url} answered 404`));
    if (behaviour.cooperative && options && data.length > options.maxBytes) {
      return Promise.reject(new OriginalsError("unavailable-bytes", "FETCH_TOO_LARGE", `${url} exceeds ${options.maxBytes} bytes`));
    }
    served += data.length;
    return Promise.resolve(data.slice());
  };
  return { fetch, calls, served: () => served };
}

async function rejection(run: Promise<unknown>): Promise<OriginalsError> {
  const error = await run.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(OriginalsError);
  return error as OriginalsError;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The hosted asset log with forged extra lines; they need only parse, not verify. */
function forgeLog(files: Map<string, Uint8Array>, extra: (template: Record<string, any>) => Array<Record<string, unknown>>): Map<string, Uint8Array> {
  const out = new Map(files);
  const log = decoder.decode(files.get("originals/asset/did.jsonl"));
  const template = JSON.parse(log.trimEnd().split("\n")[0]) as Record<string, any>;
  out.set("originals/asset/did.jsonl", encoder.encode(log + extra(template).map((l) => `${JSON.stringify(l)}\n`).join("")));
  return out;
}

function withResources(template: Record<string, any>, resources: unknown[]): Record<string, unknown> {
  return { ...template, state: { ...template.state, asset: { ...template.state.asset, resources } } };
}

/** An Original published with `count` resources of `size` bytes each. */
async function publishedWith(count: number, size: number) {
  const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
  const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => alice.evidence(), freshness: "asserted", clock: clock() });
  const signer = alice.signer("orig", KEY);
  const resources = Array.from({ length: count }, (_, i) => ({ id: `r${i}`, mediaType: "application/octet-stream", bytes: new Uint8Array(size).fill(i + 1) }));
  const c = await sdk.create({ name: "Contact sheet", resources, author: alice.ref("orig"), signer });
  if (c.kind !== "original") throw new Error("expected an Original");
  const alias = await aliasFor(c.original.did);
  await sdk.publish(c.original.did, { parent: c.original.checkpoint, author: alice.ref("orig"), signer, alias });
  return { alias, files: await hostedFiles(sdk, c.original.did, alias), digests: resources.map((r) => resourceDigest(r.bytes)) };
}

const RESOURCE = /^originals\/resources\//;
const FAN_OUT = /^originals\/(?:asset\/did-witness\.json|authors\/|resources\/)/;

describe("loadPublished has a whole-operation retrieval budget (#970)", () => {
  test("an oversized request plan is refused before any resource is requested", async () => {
    const { alias, files } = await published();
    // 20 forged entries of 64 distinct, well-formed digests: 1,280 resource requests.
    const forged = forgeLog(files, (t) => Array.from({ length: 20 }, (_, i) =>
      withResources(t, Array.from({ length: 64 }, (_, j) => ({ ...t.state.asset.resources[0], id: `r${j}`, digest: resourceDigest(bytes(`${i}/${j}`)) })))));
    const host = instrumented(forged, didWebvhFilesUrl(alias.did));
    const error = await rejection(stranger().loadPublished(alias.did, host.fetch));
    expect(error.category).toBe("limit-exceeded");
    expect(error.code).toBe("RETRIEVAL_BUDGET_EXCEEDED");
    expect(error.details).toMatchObject({ limit: "requests", requests: 4 });
    expect(host.calls).toHaveLength(4); // alias witness, alias log, manifest, asset log
    expect(host.calls.filter((c) => FAN_OUT.test(c.path))).toEqual([]);
  });

  test("an invalid manifest stops retrieval before the asset log is requested", async () => {
    const { alias, files } = await published();
    const forged = new Map(files);
    forged.set("originals/originals-evidence.json", bytes(JSON.stringify({ format: "originals-evidence/0.1" })));
    const host = instrumented(forged, didWebvhFilesUrl(alias.did));
    const error = await rejection(stranger().loadPublished(alias.did, host.fetch));
    expect(error.code).toBe("EVIDENCE_MANIFEST");
    expect(host.calls).toHaveLength(3);
  });

  test("an author that is not a DID string stops all derived requests", async () => {
    const { alias, files } = await published();
    for (const did of [42, "../../etc/passwd"]) {
      const forged = forgeLog(files, (t) => [{ ...t, state: { ...t.state, author: { ...t.state.author, did } } }]);
      const host = instrumented(forged, didWebvhFilesUrl(alias.did));
      const error = await rejection(stranger().loadPublished(alias.did, host.fetch));
      expect(error.category).toBe("invalid-evidence");
      expect(error.code).toBe("SNAPSHOT_LOG_INVALID");
      expect(error.details).toMatchObject({ line: 4, cause: "STATE_AUTHOR" });
      expect(host.calls).toHaveLength(4);
      expect(host.calls.filter((c) => FAN_OUT.test(c.path))).toEqual([]);
    }
  });

  test("a resource descriptor whose digest is not a digest stops all derived requests", async () => {
    const { alias, files } = await published();
    const forged = forgeLog(files, (t) => [withResources(t, [{ ...t.state.asset.resources[0], digest: "not-a-digest" }])]);
    const host = instrumented(forged, didWebvhFilesUrl(alias.did));
    const error = await rejection(stranger().loadPublished(alias.did, host.fetch));
    expect(error.category).toBe("invalid-evidence");
    expect(error.code).toBe("SNAPSHOT_LOG_INVALID");
    expect(error.details).toMatchObject({ line: 4, cause: "STATE_DIGEST" });
    expect(host.calls).toHaveLength(4);
    expect(host.calls.filter((c) => FAN_OUT.test(c.path))).toEqual([]);
  });

  for (const cooperative of [true, false]) {
    test(`many individually small responses stop at the aggregate byte limit (${cooperative ? "a host that honours maxBytes" : "a host that ignores it"})`, async () => {
      const { alias, files, digests } = await publishedWith(6, 1_000);
      const base = didWebvhFilesUrl(alias.did);
      // Everything but the resources, then room for two and a half resources.
      const fixed = [...files].filter(([path]) => !RESOURCE.test(path)).reduce((n, [, data]) => n + data.length, 0);
      const host = instrumented(files, base, { cooperative });
      const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")), retrievalLimits: { maxTotalBytes: fixed + 2_500 } });
      const error = await rejection(reader.loadPublished(alias.did, host.fetch));
      expect(error.category).toBe("limit-exceeded");
      expect(error.code).toBe("RETRIEVAL_BUDGET_EXCEEDED");
      expect(error.details).toMatchObject({ limit: "bytes", bytes: fixed + 2_000, maxTotalBytes: fixed + 2_500 });
      const resources = host.calls.filter((c) => RESOURCE.test(c.path));
      expect(resources.map((c) => c.path)).toEqual(digests.slice(0, 3).map((d) => `originals/resources/${d}`));
      expect(resources.map((c) => c.options?.maxBytes)).toEqual([1_000 + 1_500, 1_500, 500]);
      expect(host.calls).toHaveLength(7 + 3);
      expect(host.served()).toBe(cooperative ? fixed + 2_000 : fixed + 3_000);
    });
  }

  test("failed optional requests consume the request budget", async () => {
    const { alias, files } = await published();
    const base = didWebvhFilesUrl(alias.did);
    const reader = (maxRequests: number) =>
      OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")), retrievalLimits: { maxRequests } });
    // Alias witness (404), alias log, manifest, asset log; then asset witness (404), author log
    // and witness (404), and two resources: 9 requests, 3 of which fail.
    const enough = instrumented(files, base);
    const r = await reader(9).loadPublished(alias.did, enough.fetch);
    expect(r.verified, JSON.stringify(r.reasons)).toBe(true);
    expect(enough.calls).toHaveLength(9);

    // With one fewer, the plan does not fit: the failed alias-witness request counted.
    const short = instrumented(files, base);
    const error = await rejection(reader(8).loadPublished(alias.did, short.fetch));
    expect(error.code).toBe("RETRIEVAL_BUDGET_EXCEEDED");
    expect(error.details).toMatchObject({ limit: "requests", requests: 4, maxRequests: 8 });
    expect(short.calls).toHaveLength(4);

    // Exhausted before the plan is known: the fourth request is never made.
    const tiny = instrumented(files, base);
    expect((await rejection(reader(3).loadPublished(alias.did, tiny.fetch))).details).toMatchObject({ limit: "requests", requests: 3 });
    expect(tiny.calls.map((c) => c.path.replace(/^.*\//, ""))).toEqual(["did-witness.json", "did.jsonl", "originals-evidence.json"]);
  });

  test("a whole-operation deadline bounds many slow optional requests", async () => {
    const { alias, files } = await published();
    const optional = (path: string) => path.endsWith("did-witness.json");
    const host = instrumented(files, didWebvhFilesUrl(alias.did), { cooperative: true, hang: optional });
    const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")), retrievalLimits: { requestTimeoutMs: 200, timeoutMs: 500 } });
    const started = Date.now();
    const error = await rejection(reader.loadPublished(alias.did, host.fetch));
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(error.category).toBe("limit-exceeded");
    expect(error.details).toMatchObject({ limit: "time", timeoutMs: 500 });
    // Two witnesses time out at 200 ms each; the third is cut off by the 500 ms deadline.
    expect(host.calls.map((c) => c.path.replace(/^.*\//, ""))).toEqual(["did-witness.json", "did.jsonl", "originals-evidence.json", "did.jsonl", "did-witness.json", "did.jsonl", "did-witness.json"]);
    for (const c of host.calls) expect(c.options!.timeoutMs).toBeLessThanOrEqual(200);
    expect(host.calls[6].options!.signal.aborted).toBe(true);
  });

  test("a host that ignores the signal is still bounded by the deadline", async () => {
    const { alias, files } = await published();
    const host = instrumented(files, didWebvhFilesUrl(alias.did), { hang: () => true });
    const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")), retrievalLimits: { timeoutMs: 50 } });
    const error = await rejection(reader.loadPublished(alias.did, host.fetch));
    expect(error.details).toMatchObject({ limit: "time" });
    expect(host.calls).toHaveLength(1);
  });

  test("a caller's abort signal stops retrieval", async () => {
    const { alias, files } = await published();
    const host = instrumented(files, didWebvhFilesUrl(alias.did));
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(stranger().loadPublished(alias.did, host.fetch, { signal: controller.signal }));
    expect(error.code).toBe("RETRIEVAL_ABORTED");
    expect(host.calls).toHaveLength(0);
  });

  test("C12-78: a hosted asset log larger than the per-file cap is unavailable", async () => {
    const { alias, files } = await published();
    const size = files.get("originals/asset/did.jsonl")!.length;
    const host = instrumented(files, didWebvhFilesUrl(alias.did));
    const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")), retrievalLimits: { maxFileBytes: size - 1 } });
    const error = await rejection(reader.loadPublished(alias.did, host.fetch));
    expect(error.category).toBe("unavailable-bytes");
    expect(error.code).toBe("FETCH_TOO_LARGE");
    expect(host.calls).toHaveLength(4);
  });

  test("a valid snapshot within budget passes each request its remaining allowance", async () => {
    const { alias, files } = await published();
    const host = instrumented(files, didWebvhFilesUrl(alias.did), { cooperative: true });
    const r = await stranger().loadPublished(alias.did, host.fetch);
    expect(r.verified, JSON.stringify(r.reasons)).toBe(true);
    expect(host.calls).toHaveLength(9);
    for (const c of host.calls) {
      expect(c.options!.maxBytes).toBeLessThanOrEqual(RETRIEVAL_LIMITS.maxFileBytes);
      expect(c.options!.timeoutMs).toBeLessThanOrEqual(RETRIEVAL_LIMITS.requestTimeoutMs);
      expect(c.options!.signal.aborted).toBe(false);
    }
  });
});

describe("hosted files that are not UTF-8 are invalid evidence (#962 review R3)", () => {
  test("a non-UTF-8 alias log, alias witness or asset log is EVIDENCE_ENCODING, never a raw TypeError", async () => {
    const { alias, files } = await published();
    const base = didWebvhFilesUrl(alias.did);
    const notUtf8 = new Uint8Array([0xff, 0xfe, 0x7b]);
    for (const target of ["did.jsonl", "did-witness.json", "originals/asset/did.jsonl"]) {
      const served = new Map(files);
      served.set(target, notUtf8);
      const error = await rejection(stranger().loadPublished(alias.did, host(served, base)));
      expect(error.category, target).toBe("invalid-evidence");
      expect(error.code, target).toBe("EVIDENCE_ENCODING");
    }
  });
});

describe("bytes read from a refused response count against the budget (#962 review R5)", () => {
  test("a host whose refusals report bytes read exhausts the byte budget", async () => {
    const { alias, files } = await published();
    const base = didWebvhFilesUrl(alias.did);
    const total = [...files.values()].reduce((n, d) => n + d.length, 0);
    const limits = { maxTotalBytes: total + 1_000 };
    // A 404 that sent 600 bytes of error page before it was refused, as safeFetch reports it.
    const chatty: HostedFetch = (url, options) =>
      files.has(url.slice(base.length))
        ? host(files, base)(url, options)
        : Promise.reject(new OriginalsError("unavailable-bytes", "FETCH_STATUS", `${url} answered 404`, { bytesRead: 600 }));
    const quiet = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")), retrievalLimits: limits });
    expect((await quiet.loadPublished(alias.did, host(files, base))).verified).toBe(true);
    const error = await rejection(quiet.loadPublished(alias.did, chatty));
    expect(error.code).toBe("RETRIEVAL_BUDGET_EXCEEDED");
    expect(error.details).toMatchObject({ limit: "bytes" });
  });
});

describe("hosted files carry the newest verified author evidence (#965 review C2, P7.8)", () => {
  test("a configured author DID log that a stored one extends is not republished over it", async () => {
    const K2 = seed(22);
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const v1 = alice.evidence();
    // The publisher was configured with v1 of the author DID.
    const at = clock();
    const a = OriginalsSDK.create({ store: new MemoryStore(), authors: [v1], freshness: "asserted", clock: at });
    const signer = alice.signer("orig", KEY);
    const c = await a.create({ name: "Harbor at dawn", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: B1 }], author: alice.ref("orig"), signer });
    if (c.kind !== "original") throw new Error("expected an Original");
    const did = c.original.did;
    // The author rotates to v2 elsewhere and edits there; the publisher imports that package.
    await alice.rotate([{ fragment: "orig", secret: KEY }, { fragment: "next", secret: K2 }]);
    const v2 = alice.evidence();
    const b = OriginalsSDK.create({ store: new MemoryStore(), authors: [v2], freshness: "asserted", clock: at });
    await b.import((await a.package(did)).bytes);
    const e = await b.edit(did, { parent: c.original.checkpoint, resources: [{ id: "photo", bytes: B2 }], author: alice.ref("next"), signer: alice.signer("next", K2) });
    expect((await a.import((await b.package(did)).bytes)).status).toBe("imported");
    const alias = await aliasFor(did);
    const p = await a.publish(did, { parent: e.original.checkpoint, author: alice.ref("next"), signer: alice.signer("next", K2), alias });
    const files = await hostedFiles(a, did, alias);
    const authorLog = [...files].find(([path]) => /^originals\/authors\/[0-9a-f]{64}\/did\.jsonl$/.test(path));
    expect(decoder.decode(authorLog![1])).toBe(v2.log as string);
    expect(p.original.checkpoint).toBeDefined();
  });
});

describe("identity retrieval in loadPublished stays inside its budget (08b review R1)", () => {
  test("forged lines naming many did:webvh signers are planned against the request budget, and none is requested", async () => {
    const { alias, files } = await published();
    const scid = alias.did.split(":")[2];
    const forged = forgeLog(files, (t) => Array.from({ length: 90 }, (_, i) => {
      const did = `did:webvh:${scid}:evil${i}.example`;
      return { ...t, state: { ...t.state, author: { did, verificationMethod: `${did}#k`, versionId: "1-x" } } };
    }));
    const host = instrumented(forged, didWebvhFilesUrl(alias.did));
    const identity: string[] = [];
    const reader = OriginalsSDK.create({
      store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")),
      retrievalLimits: { maxRequests: 200, maxTotalBytes: 1_000_000, timeoutMs: 5_000 },
      identityFetch: async (url) => {
        identity.push(url);
        return new Uint8Array(900_000).fill(0x7b);
      },
    });
    const error = await rejection(reader.loadPublished(alias.did, host.fetch));
    expect(error.code).toBe("RETRIEVAL_BUDGET_EXCEEDED");
    expect(error.details).toMatchObject({ limit: "requests" });
    expect(identity).toEqual([]);
    expect(host.calls.length + identity.length).toBeLessThanOrEqual(200);
  });
});
