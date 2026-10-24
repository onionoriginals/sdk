/**
 * Signer identity continuity through the SDK (P5.14): a did:webvh author moved
 * by didwebvh-ts under did:webvh portability keeps its genesis DID as its
 * identity. Each identity's moved log is found in an evidence package or at
 * the location of the DID in the verification method id of the latest entry
 * that identity signed, never through a redirect (P8.5).
 */
import { describe, expect, test } from "bun:test";
import { OriginalsError } from "@originals/vh";
import { safeFetch, type FetchTransport } from "@originals/vh/fetch";
import { localSigner } from "@originals/vh/crypto";
import { createLog, serializeLog, signWith, vhHash } from "@originals/vh/log";
import { resourceDigest, type AliasEvidence } from "@originals/vh/originals";
import { didWebvhFilesUrl, didWebvhLogUrl } from "@originals/vh/webvh";
import { MemoryStore, OriginalsSDK, hostedFiles, readZip, writeZip, type HostedFetch } from "../../../src/originals/index.js";
import { WebvhIdentity, bytes, clock, seed } from "./helpers.js";

const B1 = bytes("harbor at dawn, first crop");
const B2 = bytes("harbor at dawn, tighter crop");
const B3 = bytes("harbor at dawn, after the move");
const B4 = bytes("harbor at dawn, edited by a fresh reader");
const K1 = seed(21);
const K2 = seed(22);

/** Alice creates and edits on old.example.com, then moves to new.example.org and rotates to orig-2. */
async function journey() {
  const alice = await WebvhIdentity.create("old.example.com", [{ fragment: "orig-1", secret: K1 }]);
  const store = new MemoryStore();
  const sdk = OriginalsSDK.create({ store, authors: async (did) => (did === alice.did ? alice.evidence() : undefined), clock: clock() });
  const before = alice.ref("orig-1");
  const created = await sdk.create({ name: "Harbor at dawn", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: B1 }], author: before, signer: alice.signer(before, K1) });
  if (created.kind !== "original") throw new Error("expected an Original");
  const did = created.original.did;
  const cropped = await sdk.edit(did, { parent: created.original.checkpoint, resources: [{ id: "photo", bytes: B2 }], author: before, signer: alice.signer(before, K1) });
  return { alice, store, sdk, did, before, v1: created.original.checkpoint, v2: cropped.original.checkpoint };
}

/** The same package without the author DID logs, declared partial, as a reader with no identity evidence gets it. */
function withoutIdentity(zip: Uint8Array, author: string): Uint8Array {
  const files = new Map([...readZip(zip)].filter(([path]) => !path.startsWith("signers/")));
  const manifest = JSON.parse(new TextDecoder().decode(files.get("originals-evidence.json"))) as Record<string, unknown>;
  files.set("originals-evidence.json", new TextEncoder().encode(JSON.stringify({ ...manifest, completeness: "partial", missing: [{ kind: "identity", did: author, role: "author" }] })));
  return writeZip(files);
}

/** A host serving exactly these files; anything else is unavailable. */
function host(files: Record<string, string>, seen: string[] = []): HostedFetch {
  return (url) => {
    seen.push(url);
    const body = files[url];
    if (body === undefined) return Promise.reject(new OriginalsError("unavailable-bytes", "FETCH_STATUS", `${url} answered 404`));
    return Promise.resolve(new TextEncoder().encode(body));
  };
}

describe("C12-132, C12-133: create, move the author, rotate, append, package, import into a fresh SDK, verify, continue editing", () => {
  test("the end-to-end case of originals-spec #39 with a didwebvh-ts portable move", async () => {
    const { alice, sdk, did, v1, v2 } = await journey();
    await alice.move("new.example.org");
    expect(alice.location).not.toBe(alice.did);
    expect(alice.location.split(":")[2]).toBe(alice.did.split(":")[2]);

    // C12-135: didwebvh-ts keeps orig-1's controller as the old DID across the move, so at the
    // move's version orig-1 does not meet P5.3; the commit is refused and nothing changes.
    const moved = alice.ref("orig-1");
    expect(moved.verificationMethod.startsWith(`${alice.location}#`)).toBe(true);
    const refused = await sdk.edit(did, { parent: v2, resources: [{ id: "photo", bytes: B3 }], author: moved, signer: alice.signer(moved, K1) }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(OriginalsError);
    expect((refused as OriginalsError).code).toBe("COMMIT_VERIFICATION_FAILED");
    const report = (refused as OriginalsError).details?.report as { history: { failure?: { code: string; category: string } } };
    expect(report.history.failure).toMatchObject({ code: "AUTHOR_VM_CONTROLLER", category: "author-binding" });
    expect((await sdk.get(did)).checkpoint).toBe(v2);

    // Rotation in the author DID: orig-2 under the new id. The new key signs with no asset log entry for it.
    await alice.rotate([{ fragment: "orig-2", secret: K2 }]);
    const after = alice.ref("orig-2");
    expect(after.did).toBe(alice.did);
    const appended = await sdk.edit(did, { parent: v2, resources: [{ id: "photo", bytes: B3 }], author: after, signer: alice.signer(after, K2) });
    expect(appended.status).toBe("committed");
    // The rotation removed orig-1, so the entries signed with it are historically authorized only (P7.9).
    expect(appended.original.report.reasons).toEqual(["not-anchored", "historically-authorized-only"]);
    expect(appended.original.report.historicallyAuthorizedOnly.map((h) => h.versionId)).not.toContain(appended.original.checkpoint);
    expect(appended.original.validAsOf?.checkpoint).toBe(appended.original.checkpoint);
    expect(appended.original.report.identityEvidence).toMatchObject({ author: alice.did, latestVersionId: alice.versionId });
    // Entries before the move still verify against the versions before it.
    for (const checkpoint of [v1, v2]) {
      const earlier = await sdk.get(did, { checkpoint });
      expect(earlier.report.history.status).toBe("valid");
      expect(earlier.report.authorBinding.status).toBe("valid");
    }

    // Package, import into a fresh SDK with an empty store and no author source.
    const pkg = await sdk.package(did);
    expect(pkg.manifest.completeness).toBe("complete");
    const fresh = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")) });
    const loaded = await fresh.load(pkg.bytes);
    expect(loaded.report.checkpoint).toBe(appended.original.checkpoint);
    expect(loaded.report.authorBinding.status).toBe("valid");
    expect(loaded.report.identityEvidence.status).toBe("complete");
    const imported = await fresh.import(pkg.bytes);
    expect(imported.status).toBe("imported");
    expect(imported.original.checkpoint).toBe(appended.original.checkpoint);
    expect(imported.original.state).toEqual(appended.original.state);
    expect(imported.original.resources.map((r) => [r.version, r.digest, r.bytes])).toEqual(appended.original.resources.map((r) => [r.version, r.digest, r.bytes]));

    // The fresh SDK continues editing with the new key: authority comes from the key, not the import.
    const continued = await fresh.edit(did, { parent: imported.original.checkpoint, resources: [{ id: "photo", bytes: B4 }], author: after, signer: alice.signer(after, K2) });
    expect(continued.status).toBe("committed");
    expect(continued.original.report.authorBinding.status).toBe("valid");
    expect(continued.original.resources.map((r) => r.digest)).toEqual([B1, B2, B3, B4].map(resourceDigest));
    // The old key, at the version that still lists it, cannot continue: it is no longer the author's (P7.9).
    const old = alice.ref("orig-1", alice.log[0].versionId as string);
    const stale = await fresh.edit(did, { parent: continued.original.checkpoint, name: "renamed", author: old, signer: alice.signer(old, K1) }).catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(OriginalsError);
  });
});

describe("C12-134: a fresh reader with no package of the moved author's log", () => {
  async function movedAndRotated() {
    const env = await journey();
    await env.alice.move("new.example.org");
    await env.alice.rotate([{ fragment: "orig-2", secret: K2 }]);
    const after = env.alice.ref("orig-2");
    const appended = await env.sdk.edit(env.did, { parent: env.v2, resources: [{ id: "photo", bytes: B3 }], author: after, signer: env.alice.signer(after, K2) });
    return { ...env, zip: withoutIdentity((await env.sdk.package(env.did)).bytes, env.alice.did), head: appended.original.checkpoint };
  }

  test("without the log the author's identity evidence is incomplete and nothing is current", async () => {
    const { zip } = await movedAndRotated();
    const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")) });
    const r = (await reader.load(zip)).report;
    expect(r.identityEvidence.status).toBe("incomplete");
    expect(r.identityEvidence.freshness).toBe("not-established");
    expect(r.current).toBe(false);
  });

  test("found at the location of the DID in the latest entry's verification method, the log is used; without its witnesses' approval freshness is not established, and the report says where, when and which version (P7.8)", async () => {
    const { alice, zip, head } = await movedAndRotated();
    const seen: string[] = [];
    const log = alice.evidence().log as string;
    const reader = OriginalsSDK.create({
      store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")),
      identityFetch: host({ [didWebvhLogUrl(alice.location)]: log }, seen),
    });
    const loaded = await reader.load(zip);
    expect(seen).toContain("https://new.example.org/.well-known/did.jsonl");
    expect(loaded.report.checkpoint).toBe(head);
    expect(loaded.report.authorBinding.status).toBe("valid");
    expect(loaded.report.identityEvidence).toMatchObject({
      status: "complete", freshness: "not-established", latestVersionId: alice.versionId,
      obtained: { location: didWebvhLogUrl(alice.location), obtainedAt: expect.any(String), source: "fetched", latestVersionId: alice.versionId, witnessed: false },
    });
    expect(loaded.report.validAsOf?.signers[0]).toMatchObject({ did: alice.did, location: didWebvhLogUrl(alice.location), source: "fetched" });
  });

  test("a log kept only at the old location verifies the history but establishes no freshness (PROVISIONAL, 08b review r4 #5)", async () => {
    const { alice, zip, head } = await movedAndRotated();
    const seen: string[] = [];
    const reader = OriginalsSDK.create({
      store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")),
      identityFetch: host({ [didWebvhLogUrl(alice.did)]: alice.evidence().log as string }, seen),
    });
    const r = (await reader.load(zip)).report;
    // The genesis entry's location first; the log found there verifies the entries, whose latest
    // names the new location, which is asked next and serves nothing.
    expect(seen[0]).toBe(didWebvhLogUrl(alice.did));
    expect(seen).toContain(didWebvhLogUrl(alice.location));
    expect(r.checkpoint).toBe(head);
    expect(r.identityEvidence.freshness).toBe("not-established");
    expect(r.current).toBe(false);
  });

  test("found at both locations, the log from the latest verified entry's location is used", async () => {
    const { alice, zip, head } = await movedAndRotated();
    const seen: string[] = [];
    const log = alice.evidence().log as string;
    const reader = OriginalsSDK.create({
      store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")),
      identityFetch: host({ [didWebvhLogUrl(alice.did)]: log, [didWebvhLogUrl(alice.location)]: log }, seen),
    });
    const r = (await reader.load(zip)).report;
    expect(seen[0]).toBe(didWebvhLogUrl(alice.did));
    expect(r.checkpoint).toBe(head);
    expect(r.identityEvidence).toMatchObject({ status: "complete", freshness: "not-established", latestVersionId: alice.versionId, obtained: { location: didWebvhLogUrl(alice.location) } });
  });

  test("a retrieved log with another SCID, or one that diverges from the package's, is not used", async () => {
    const { alice, sdk, did } = await movedAndRotated();
    const mallory = await WebvhIdentity.create("new.example.org", [{ fragment: "orig-2", secret: K2 }]);
    const reader = OriginalsSDK.create({
      store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")),
      identityFetch: host({ [didWebvhLogUrl(alice.location)]: mallory.evidence().log as string }),
    });
    const r = (await reader.load((await sdk.package(did)).bytes)).report;
    // The package's own log is used; the impostor's is ignored and establishes nothing.
    expect(r.identityEvidence).toMatchObject({ status: "complete", freshness: "not-established" });
    expect(r.authorBinding.status).toBe("valid");
  });
});

describe("C12-137: the old author DID location redirecting to a new host", () => {
  test("the redirect is not followed and establishes no continuity (P5.14, P8.5)", async () => {
    const { alice, sdk, did } = await journey();
    // Alice moves after her latest entry, which names the old location; the old host now redirects.
    await alice.move("new.example.org");
    const oldUrl = didWebvhLogUrl(alice.did);
    const newUrl = didWebvhLogUrl(alice.location);
    const requested: string[] = [];
    const transport: FetchTransport = ({ url }) => {
      requested.push(url.href);
      const body = url.href === newUrl ? (alice.evidence().log as string) : "";
      const status = url.href === oldUrl ? 301 : url.href === newUrl ? 200 : 404;
      return Promise.resolve({ status, headers: status === 301 ? { location: newUrl } : {}, body: (async function* () { yield new TextEncoder().encode(body); })() });
    };
    const reader = OriginalsSDK.create({
      store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")),
      identityFetch: async (url, options) => (await safeFetch(url, { ...options, resolve: () => Promise.resolve(["93.184.215.14"]), transport })).bytes,
    });
    const r = (await reader.load(withoutIdentity((await sdk.package(did)).bytes, alice.did))).report;
    expect(requested[0]).toBe(oldUrl);
    expect(requested).not.toContain(newUrl);
    expect(r.identityEvidence.status).toBe("incomplete");
    expect(r.identityEvidence.freshness).toBe("not-established");
    expect(r.current).toBe(false);
    // With the package's (pre-move) log the history verifies, but the redirect still establishes nothing.
    const withPackage = (await reader.load((await sdk.package(did)).bytes)).report;
    expect(withPackage.identityEvidence).toMatchObject({ status: "complete", freshness: "not-established" });
  });
});

describe("C12-134: identity retrieval is bounded and follows only the identity's own chained entries (P5.14; 08b review R1, R2, A4)", () => {
  async function movedAndRotated() {
    const env = await journey();
    await env.alice.move("new.example.org");
    await env.alice.rotate([{ fragment: "orig-2", secret: K2 }]);
    const after = env.alice.ref("orig-2");
    const appended = await env.sdk.edit(env.did, { parent: env.v2, resources: [{ id: "photo", bytes: B3 }], author: after, signer: env.alice.signer(after, K2) });
    return { ...env, after, head: appended.original.checkpoint };
  }

  /** The package with `extra` lines appended to its asset log. Unchained lines need only parse. */
  function withLines(zip: Uint8Array, extra: string[]): Uint8Array {
    const files = new Map(readZip(zip));
    const log = new TextDecoder().decode(files.get("asset/did.jsonl"));
    files.set("asset/did.jsonl", new TextEncoder().encode(log + extra.map((l) => `${l}\n`).join("")));
    return writeZip(files);
  }

  test("lines that do not chain, naming other DIDs, request nothing: only the author's own location is fetched", async () => {
    const { alice, sdk, did } = await movedAndRotated();
    const scid = alice.did.split(":")[2];
    const junk = Array.from({ length: 200 }, (_, i) => {
      const victim = `did:webvh:${scid}:victim${i}.example`;
      return JSON.stringify({ versionId: `${i + 4}-x`, versionTime: "2026-10-18T12:59:00Z", parameters: {}, state: { author: { did: i % 2 ? victim : alice.did, verificationMethod: `${victim}#k`, versionId: "1-x" } }, proof: [] });
    });
    const seen: string[] = [];
    const reader = OriginalsSDK.create({
      store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")),
      identityFetch: host({ [didWebvhLogUrl(alice.location)]: alice.evidence().log as string }, seen),
    });
    await reader.load(withLines(withoutIdentity((await sdk.package(did)).bytes, alice.did), junk));
    // The genesis entry's location, then the latest chained entry's (08b review r4 #5): log and witness file.
    expect(seen.length).toBeLessThanOrEqual(3);
    expect(seen[0]).toBe(didWebvhLogUrl(alice.did));
    for (const url of seen.slice(1)) expect(url.startsWith("https://new.example.org/.well-known/")).toBe(true);
  });

  test("load with identityFetch has its own deadline: an identity host that never answers leaves freshness not established", async () => {
    const { alice, sdk, did } = await movedAndRotated();
    const reader = OriginalsSDK.create({
      store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")),
      retrievalLimits: { timeoutMs: 200 },
      identityFetch: () => new Promise<Uint8Array>(() => undefined),
    });
    const started = Date.now();
    const r = (await reader.load(withoutIdentity((await sdk.package(did)).bytes, alice.did))).report;
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(r.identityEvidence.freshness).toBe("not-established");
    expect(r.current).toBe(false);
  });

  test("load without identityFetch makes no request at all (P7.3)", async () => {
    const { sdk, did } = await movedAndRotated();
    const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")) });
    const r = (await reader.load((await sdk.package(did)).bytes)).report;
    expect(r.identityEvidence).toMatchObject({ status: "complete", freshness: "not-established" });
  });

  async function publishedMoved() {
    const env = await movedAndRotated();
    const key = localSigner("Ed25519", seed(61));
    const k = key.publicKeyMultibase;
    const g = await createLog({
      versionTime: "2026-10-18T10:00:00Z",
      parameters: { method: "did:webvh:1.0", scid: "{SCID}", updateKeys: [k], portable: true },
      state: { id: "did:webvh:{SCID}:example.com:photos", alsoKnownAs: [env.did] },
      sign: signWith(key, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${k}#${k}` }),
    });
    const alias: AliasEvidence = { did: g.state.id as string, log: serializeLog([g]) };
    const p = await env.sdk.publish(env.did, { parent: env.head, author: env.after, signer: env.alice.signer(env.after, K2), alias });
    expect(p.status).toBe("committed");
    const files = await hostedFiles(env.sdk, env.did, alias);
    // A reader of a host that serves no author DID log: the identity must come from its location.
    for (const path of [...files.keys()]) if (path.startsWith("originals/signers/")) files.delete(path);
    const base = didWebvhFilesUrl(alias.did);
    const hosted: HostedFetch = (url) => {
      const data = url.startsWith(base) ? files.get(url.slice(base.length)) : undefined;
      return data ? Promise.resolve(data.slice()) : Promise.reject(new OriginalsError("unavailable-bytes", "FETCH_STATUS", `${url} answered 404`));
    };
    return { ...env, alias, files, hosted };
  }

  test("loadPublished's deadline and the caller's signal bound identity requests", async () => {
    const { alias, hosted } = await publishedMoved();
    const hanging = OriginalsSDK.create({
      store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")),
      retrievalLimits: { timeoutMs: 300 }, identityFetch: () => new Promise<Uint8Array>(() => undefined),
    });
    const started = Date.now();
    const timedOut = await hanging.loadPublished(alias.did, hosted).then(() => undefined, (e: unknown) => e as OriginalsError);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(timedOut).toBeInstanceOf(OriginalsError);
    expect(timedOut!.code).toBe("RETRIEVAL_BUDGET_EXCEEDED");
    expect(timedOut!.details).toMatchObject({ limit: "time" });

    const patient = OriginalsSDK.create({
      store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")),
      identityFetch: () => new Promise<Uint8Array>(() => undefined),
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const aborted = await patient.loadPublished(alias.did, hosted, { signal: controller.signal }).then(() => undefined, (e: unknown) => e as OriginalsError);
    expect(aborted!.code).toBe("RETRIEVAL_ABORTED");
  });

  test("identity requests are planned and counted in loadPublished's request and byte budget", async () => {
    const { alice, alias, hosted } = await publishedMoved();
    const seen: string[] = [];
    const identity = host({ [didWebvhLogUrl(alice.location)]: alice.evidence().log as string }, seen);
    const reader = (retrievalLimits: Record<string, number>) =>
      OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")), retrievalLimits, identityFetch: identity });
    const r = await reader({}).loadPublished(alias.did, hosted);
    expect(seen).toContain(didWebvhLogUrl(alice.location));
    expect(r.report.identityEvidence).toMatchObject({ status: "complete", freshness: "not-established", obtained: { location: didWebvhLogUrl(alice.location), source: "fetched" } });
    // Without room for the author's two identity requests in the plan, nothing past the asset log is requested.
    const hostCalls: string[] = [];
    const counted: HostedFetch = (url, options) => {
      hostCalls.push(url);
      return hosted(url, options);
    };
    seen.length = 0;
    const planOnly = 4 + 1 + 2 + 3; // alias witness, alias log, manifest, asset log; asset witness; author log and witness; resources
    const error = await reader({ maxRequests: planOnly }).loadPublished(alias.did, counted).then(() => undefined, (e: unknown) => e as OriginalsError);
    expect(error!.code).toBe("RETRIEVAL_BUDGET_EXCEEDED");
    expect(error!.details).toMatchObject({ limit: "requests" });
    expect(seen).toEqual([]);
    // Identity bytes count: a byte budget too small for the identity log stops the call.
    const size = [...(await publishedMoved()).files.values()].reduce((n, d) => n + d.length, 0);
    const tight = await reader({ maxTotalBytes: size + 2_000 }).loadPublished(alias.did, hosted).then(() => undefined, (e: unknown) => e as OriginalsError);
    expect(tight?.details).toMatchObject({ limit: "bytes" });
  });
});

describe("C12-134: a forged hash-chained line chooses no identity location (P5.14; 08b review r2 #5)", () => {
  test("the location comes from the last entry that verified, not from an appended line whose proof does not", async () => {
    const { alice, sdk, did } = await journey();
    const files = new Map(readZip((await sdk.package(did)).bytes));
    const log = new TextDecoder().decode(files.get("asset/did.jsonl"));
    const last = JSON.parse(log.trimEnd().split("\n").pop()!) as Record<string, any>;
    // Anyone can chain a line: same SCID, an attacker's host, the previous proof reused.
    const tracker = `did:webvh:${alice.did.split(":")[2]}:tracker.attacker.example`;
    const { proof, ...rest } = last;
    const forged: Record<string, any> = { ...rest, versionTime: "2026-10-18T12:59:00Z", state: { ...last.state, transitions: [], author: { ...last.state.author, verificationMethod: `${tracker}#orig-1` } } };
    forged.versionId = `${Number(String(last.versionId).split("-")[0]) + 1}-${vhHash({ ...forged, versionId: last.versionId })}`;
    files.set("asset/did.jsonl", new TextEncoder().encode(`${log}${JSON.stringify({ ...forged, proof })}\n`));
    const seen: string[] = [];
    const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")), identityFetch: host({}, seen) });
    const r = (await reader.load(writeZip(files))).report;
    expect(r.history.status).toBe("invalid");
    expect(seen.some((url) => url.includes("attacker"))).toBe(false);
    expect(seen[0]).toBe(didWebvhLogUrl(alice.did));
  });

  test("08b review r4 #5 (PROVISIONAL): a reader with no identity evidence asks the genesis entry's location before a forged line's", async () => {
    const { alice, sdk, did } = await journey();
    const files = new Map(readZip((await sdk.package(did)).bytes));
    const log = new TextDecoder().decode(files.get("asset/did.jsonl"));
    const last = JSON.parse(log.trimEnd().split("\n").pop()!) as Record<string, any>;
    const tracker = `did:webvh:${alice.did.split(":")[2]}:tracker.attacker.example`;
    const { proof, ...rest } = last;
    const forged: Record<string, any> = { ...rest, versionTime: "2026-10-18T12:59:00Z", state: { ...last.state, transitions: [], author: { ...last.state.author, verificationMethod: `${tracker}#orig-1` } } };
    forged.versionId = `${Number(String(last.versionId).split("-")[0]) + 1}-${vhHash({ ...forged, versionId: last.versionId })}`;
    files.set("asset/did.jsonl", new TextEncoder().encode(`${log}${JSON.stringify({ ...forged, proof })}\n`));
    for (const path of [...files.keys()]) if (path.startsWith("signers/")) files.delete(path);
    const forgedZip = writeZip(files);
    // The author's own host serves the log: the forged line's location is never requested.
    const seen: string[] = [];
    const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")), identityFetch: host({ [didWebvhLogUrl(alice.did)]: alice.evidence().log as string }, seen) });
    const r = (await reader.load(forgedZip)).report;
    expect(seen[0]).toBe(didWebvhLogUrl(alice.did));
    expect(seen.some((url) => url.includes("attacker"))).toBe(false);
    expect(r.history.status).toBe("invalid");
    // Only when the genesis location gives nothing is P5.14's latest chained entry tried; it can choose a
    // request but never the result.
    const offline: string[] = [];
    const fallback = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")), identityFetch: host({}, offline) });
    const f = (await fallback.load(forgedZip)).report;
    expect(offline[0]).toBe(didWebvhLogUrl(alice.did));
    expect(f.identityEvidence.freshness).toBe("not-established");
    expect(f.current).toBe(false);
  });
});
