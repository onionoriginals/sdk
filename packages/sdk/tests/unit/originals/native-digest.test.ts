/**
 * Native SHA-256 must not change what a prepare reads (P4.3). `prepareCreate`
 * and `prepareEdit` hash the caller's new resource synchronously, as before, so
 * they read their input exactly as they did: once per field, before anything
 * is awaited. Bytes kept in a draft are a private copy, so they always match
 * their digest. Bytes read from a store are hashed with `resourceDigestAsync`
 * on a private copy taken when read, at every size, and that copy is what is
 * returned, archived or kept (C12-02).
 */
import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { NATIVE_SHA256_MIN_BYTES, bytesView } from "@originals/vh/crypto";
import { resourceDigest } from "@originals/vh/originals";
import { OriginalsError } from "@originals/vh";
import { MemoryStore, OriginalsSDK, type SharedHost } from "../../../src/originals/index.js";
import { readEvidence } from "../../../src/originals/evidence.js";
import { Author, NOW, seed } from "./helpers.js";

const KEY = seed(37);
const LARGE = NATIVE_SHA256_MIN_BYTES * 2;

async function setup() {
  const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
  const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: () => NOW });
  return { alice, sdk, author: alice.ref("orig"), signer: alice.signer("orig", KEY) };
}

function onlyBytes(draft: { bytes: Map<string, Uint8Array> }): [string, Uint8Array] {
  const all = [...draft.bytes];
  expect(all).toHaveLength(1);
  return all[0]!;
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    expect(e).toBeInstanceOf(OriginalsError);
    return (e as OriginalsError).code;
  }
}

describe("prepareCreate reads its input when called", () => {
  test("an invalid name is refused even when the caller fixes it after the call", async () => {
    const { sdk, author } = await setup();
    const input = { name: null as unknown as string, resource: { mediaType: "image/png", bytes: new Uint8Array(LARGE).fill(1) }, author };
    const pending = sdk.prepareCreate(input);
    input.name = "accepted after call";
    expect(await codeOf(pending)).toBe("STATE_NAME");
  });

  test("a name, metadata and media type changed after the call are not the ones prepared", async () => {
    const { sdk, author } = await setup();
    const metadata = { title: "before" };
    const resource = { mediaType: "image/png", bytes: new Uint8Array(LARGE).fill(2) };
    const input = { name: "before", metadata, resource, author };
    const pending = sdk.prepareCreate(input);
    input.name = "after";
    metadata.title = "after";
    resource.mediaType = "text/plain";
    const asset = (await pending).entry.state.asset as { name: string; metadata: { title: string }; resource: { mediaType: string } };
    expect(asset.name).toBe("before");
    expect(asset.metadata.title).toBe("before");
    expect(asset.resource.mediaType).toBe("image/png");
  });

  test("Buffer bytes changed after the call are kept as they were, matching their digest (C12-02)", async () => {
    const { sdk, author } = await setup();
    const b = Buffer.alloc(LARGE, 1);
    const pending = sdk.prepareCreate({ name: "buffer", resource: { mediaType: "image/png", bytes: b }, author });
    b.fill(2);
    const draft = await pending;
    const [digest, kept] = onlyBytes(draft);
    expect(digest).toBe(resourceDigest(Buffer.alloc(LARGE, 1)));
    expect(resourceDigest(kept)).toBe(digest);
    b.fill(3);
    expect(resourceDigest(kept)).toBe(digest);
  });
});

describe("prepareEdit reads its input when it did", () => {
  test("Buffer bytes changed after the draft is made are kept as they were, matching their digest (C12-02)", async () => {
    const { sdk, author, signer } = await setup();
    const c = await sdk.create({ name: "x", resource: { mediaType: "image/png", bytes: new Uint8Array(LARGE).fill(1) }, author, signer });
    if (c.kind !== "original") throw new Error("expected an Original");
    // Another size than the current version.
    const b = Buffer.alloc(LARGE + 1, 4);
    // An edit reads its input once the parent is verified, as it always did; the bytes are copied then.
    const [digest, kept] = onlyBytes(await sdk.prepareEdit(c.original.did, { parent: c.original.checkpoint, resource: { bytes: b }, author }));
    b.fill(5);
    expect(digest).toBe(resourceDigest(Buffer.alloc(LARGE + 1, 4)));
    expect(resourceDigest(kept)).toBe(digest);
  });

  test("an edit to the same bytes gives the entry it gave before: no transition", async () => {
    const { sdk, author, signer } = await setup();
    const v1 = new Uint8Array(LARGE).fill(1);
    const c = await sdk.create({ name: "x", resource: { mediaType: "image/png", bytes: v1 }, author, signer });
    if (c.kind !== "original") throw new Error("expected an Original");
    const draft = await sdk.prepareEdit(c.original.did, { parent: c.original.checkpoint, name: "renamed", resource: { bytes: v1.slice() }, author });
    expect((draft.entry.state as { transitions: unknown[] }).transitions).toEqual([]);
    expect((draft.entry.state.asset as { name: string }).name).toBe("renamed");
  });

  test("an invalid name is refused with the same error as before, with a new resource version", async () => {
    const { sdk, author, signer } = await setup();
    const c = await sdk.create({ name: "x", resource: { mediaType: "image/png", bytes: new Uint8Array(LARGE).fill(1) }, author, signer });
    if (c.kind !== "original") throw new Error("expected an Original");
    const edit = sdk.prepareEdit(c.original.did, { parent: c.original.checkpoint, name: null as never, resource: { bytes: new Uint8Array(LARGE + 7).fill(9) }, author });
    expect(await codeOf(edit)).toBe("STATE_NAME");
  });
});

describe("arguments a prepare cannot clone are read as they were consumed", () => {
  test("Proxy metadata changed after the call is the metadata it was (C12-02)", async () => {
    const { sdk, author } = await setup();
    const target: { title?: string } = { title: "before" };
    const pending = sdk.prepareCreate({ name: "proxy", metadata: new Proxy(target, {}) as never, resource: { mediaType: "image/png", bytes: new Uint8Array(LARGE).fill(1) }, author });
    target.title = "after";
    expect((await pending).entry.state.asset).toMatchObject({ metadata: { title: "before" } });
  });

  test("Proxy metadata made invalid after the call does not fail a prepare that read it valid", async () => {
    const { sdk, author } = await setup();
    const target: { title?: string } = { title: "before" };
    const pending = sdk.prepareCreate({ name: "proxy", metadata: new Proxy(target, {}) as never, resource: { mediaType: "image/png", bytes: new Uint8Array(LARGE).fill(1) }, author });
    target.title = undefined;
    expect((await pending).entry.state.asset).toMatchObject({ metadata: { title: "before" } });
  });

  test("metadata a clock changes while the input is read is hashed as read, every read alike (C12-02)", async () => {
    const { alice, author, signer } = await setup();
    const target = { title: "t0" };
    let calls = 0;
    let armed = false;
    // Each clock call queues a change to the metadata: one lands only if the input is read after an await.
    const clock = () => {
      const n = ++calls;
      if (armed) queueMicrotask(() => (target.title = `t${n}`));
      return NOW;
    };
    const seen: unknown[] = [];
    const watched = () => new Proxy(target, { get: (t, k, r) => { const v = Reflect.get(t, k, r); if (k === "title") seen.push(v); return v; } });
    const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock });
    const c = await sdk.create({ name: "x", resource: { mediaType: "image/png", bytes: new Uint8Array(LARGE).fill(1) }, author, signer });
    if (c.kind !== "original") throw new Error("expected an Original");
    const createInput = (metadata: object) => ({ name: "y", metadata: metadata as never, resource: { mediaType: "image/png", bytes: new Uint8Array(LARGE).fill(3) }, author });
    const editInput = (metadata: object) => ({ parent: c.original.checkpoint, metadata: metadata as never, resource: { bytes: new Uint8Array(LARGE + 1).fill(2) }, author });

    for (const prepare of [(m: object) => sdk.prepareCreate(createInput(m)), (m: object) => sdk.prepareEdit(c.original.did, editInput(m))]) {
      seen.length = 0;
      armed = true;
      const draft = await prepare(watched());
      armed = false;
      expect(seen.length).toBeGreaterThan(0);
      expect(new Set(seen).size).toBe(1);
      // The same entry as one prepared with plain metadata holding what was read.
      expect(draft.entry.versionId).toBe((await prepare({ title: seen[0] })).entry.versionId);
    }
  });
});

describe("stored bytes are kept as they were checked", () => {
  /** A store that hands back a fresh buffer and reuses it two microtasks later. */
  function reusingStore(): MemoryStore {
    const store = new MemoryStore();
    const get = store.getResource.bind(store);
    store.getResource = async (digest: string) => {
      const bytes = await get(digest);
      if (bytes) queueMicrotask(() => queueMicrotask(() => bytes.fill(0xee)));
      return bytes;
    };
    return store;
  }

  test("a package archives the bytes it checked, not the store's reused buffer (C12-02)", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const store = reusingStore();
    const sdk = OriginalsSDK.create({ store, authors: [alice.evidence()], clock: () => NOW });
    const c = await sdk.create({ name: "x", resource: { mediaType: "image/png", bytes: new Uint8Array(LARGE).fill(1) }, author: alice.ref("orig"), signer: alice.signer("orig", KEY) });
    if (c.kind !== "original") throw new Error("expected an Original");
    const pkg = await sdk.package(c.original.did);
    expect(pkg.manifest.completeness).toBe("complete");
    expect((await sdk.load(pkg.bytes)).report.resources.status).toBe("available");
  });

  test("evidence kept from a shared host is the bytes checked, not the host's buffer changed meanwhile (C12-02)", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const source = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: () => NOW });
    const v1 = new Uint8Array(LARGE).fill(1);
    const c = await source.create({ name: "x", resource: { mediaType: "image/png", bytes: v1 }, author: alice.ref("orig"), signer: alice.signer("orig", KEY) });
    if (c.kind !== "original") throw new Error("expected an Original");
    const contents = readEvidence((await source.package(c.original.did)).bytes);
    const digest = resourceDigest(v1);
    const hostBytes = contents.bytes[digest]!;
    const host: SharedHost = { submit: () => Promise.reject(new Error("unused")), accepted: () => Promise.resolve(contents) };
    // The host's adapter reuses its buffer while the digest that keeps it is pending.
    const subtle = crypto.subtle;
    const digestOf = subtle.digest.bind(subtle);
    const real = Object.getOwnPropertyDescriptor(subtle, "digest");
    Object.defineProperty(subtle, "digest", {
      configurable: true,
      value: (a: AlgorithmIdentifier, d: BufferSource) => {
        const result = digestOf(a, d);
        if (new Error().stack?.includes("keepEvidence")) hostBytes.fill(0xee);
        return result;
      },
    });
    const store = new MemoryStore();
    try {
      const sdk = OriginalsSDK.create({ store, authors: [alice.evidence()], clock: () => NOW });
      expect((await sdk.sync(c.original.did, host)).status).toBe("imported");
    } finally {
      if (real) Object.defineProperty(subtle, "digest", real);
      else delete (subtle as { digest?: unknown }).digest;
    }
    const kept = await store.getResource(digest);
    expect(kept && resourceDigest(kept)).toBe(digest);
  });
});

describe("bytes read from a store are a private copy of what was checked, at every size", () => {
  /** A store that hands back a fresh buffer and overwrites it two microtasks later. */
  function overwritingStore(): MemoryStore {
    const store = new MemoryStore();
    const get = store.getResource.bind(store);
    store.getResource = async (digest: string) => {
      const bytes = await get(digest);
      if (bytes) queueMicrotask(() => queueMicrotask(() => bytes.fill(0xee)));
      return bytes;
    };
    return store;
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  for (const size of [32, NATIVE_SHA256_MIN_BYTES - 1, LARGE]) {
    test(`a package of a ${size}-byte resource archives the bytes it hashed, and reloads available (C12-02)`, async () => {
      const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
      const store = overwritingStore();
      const sdk = OriginalsSDK.create({ store, authors: [alice.evidence()], clock: () => NOW });
      const c = await sdk.create({ name: "x", resource: { mediaType: "image/png", bytes: new Uint8Array(size).fill(1) }, author: alice.ref("orig"), signer: alice.signer("orig", KEY) });
      if (c.kind !== "original") throw new Error("expected an Original");
      const pkg = await sdk.package(c.original.did);
      expect(pkg.manifest.completeness).toBe("complete");
      expect((await sdk.load(pkg.bytes)).report.resources.status).toBe("available");
    });

    test(`resourceBytes of a ${size}-byte resource returns the checked bytes, which still match their digest (C12-02)`, async () => {
      const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
      const store = overwritingStore();
      const sdk = OriginalsSDK.create({ store, authors: [alice.evidence()], clock: () => NOW });
      const digest = resourceDigest(new Uint8Array(size).fill(1));
      await store.putResource(digest, new Uint8Array(size).fill(1));
      const got = await sdk.resourceBytes(digest);
      await settle();
      expect(got && resourceDigest(got)).toBe(digest);
    });

    test(`a pending candidate's ${size}-byte resource is the checked bytes, which still match their digest (C12-02)`, async () => {
      const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
      const store = overwritingStore();
      const sdk = OriginalsSDK.create({ store, authors: [alice.evidence()], clock: () => NOW });
      const signer = alice.signer("orig", KEY);
      const c = await sdk.create({ name: "x", resource: { mediaType: "image/png", bytes: new Uint8Array(size + 1).fill(1) }, author: alice.ref("orig"), signer });
      if (c.kind !== "original") throw new Error("expected an Original");
      const v2 = new Uint8Array(size).fill(2);
      const candidate = await sdk.sign(await sdk.prepareEdit(c.original.did, { parent: c.original.checkpoint, resource: { bytes: v2 }, author: alice.ref("orig") }), signer);
      await store.putResource(resourceDigest(v2), v2);
      await store.putPending(c.original.did, { parent: c.original.checkpoint, entry: candidate.line });
      const pending = await sdk.pending(c.original.did);
      await settle();
      const kept = pending?.bytes.get(resourceDigest(v2));
      expect(kept && resourceDigest(kept)).toBe(resourceDigest(v2));
    });
  }
});

describe("bytes from another realm get the same guarantee", () => {
  /** A store whose buffers come from another realm (an iframe's, a vm context's) and are overwritten two microtasks later. */
  function foreignStore(): MemoryStore {
    const store = new MemoryStore();
    const get = store.getResource.bind(store);
    store.getResource = async (digest: string) => {
      const own = await get(digest);
      if (!own) return undefined;
      const bytes = runInNewContext("(n) => new Uint8Array(n)")(own.length) as Uint8Array;
      expect(bytes instanceof Uint8Array).toBe(false);
      bytes.set(own);
      queueMicrotask(() => queueMicrotask(() => bytes.fill(0xee)));
      return bytes;
    };
    return store;
  }

  for (const size of [32, LARGE]) {
    test(`a ${size}-byte resource from another realm is packaged and returned as the bytes hashed (C12-02)`, async () => {
      const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
      const store = foreignStore();
      const sdk = OriginalsSDK.create({ store, authors: [alice.evidence()], clock: () => NOW });
      const c = await sdk.create({ name: "x", resource: { mediaType: "image/png", bytes: new Uint8Array(size).fill(1) }, author: alice.ref("orig"), signer: alice.signer("orig", KEY) });
      if (c.kind !== "original") throw new Error("expected an Original");
      const pkg = await sdk.package(c.original.did);
      expect((await sdk.load(pkg.bytes)).report.resources.status).toBe("available");
      const digest = resourceDigest(new Uint8Array(size).fill(1));
      const got = await sdk.resourceBytes(digest);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(got && resourceDigest(got)).toBe(digest);
    });
  }
});

describe("bytes are read through their contents, never an own length property", () => {
  const shadowed = (size: number, limit = Infinity) => {
    const state = { reads: 0 };
    const bytes = new Uint8Array(size).fill(1);
    Object.defineProperty(bytes, "length", { get() { if (++state.reads > limit) throw new Error("length read too often"); return size; } });
    return { bytes, state };
  };

  test("prepareCreate reads a large resource's length as often as a small one's", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: () => NOW });
    const small = shadowed(32);
    const large = shadowed(LARGE);
    await sdk.prepareCreate({ name: "x", resource: { mediaType: "image/png", bytes: small.bytes }, author: alice.ref("orig") });
    await sdk.prepareCreate({ name: "x", resource: { mediaType: "image/png", bytes: large.bytes }, author: alice.ref("orig") });
    expect(large.state.reads).toBe(small.state.reads);
    // So a getter that tolerates exactly those reads never fails a large create.
    const limited = shadowed(LARGE, small.state.reads);
    expect((await sdk.prepareCreate({ name: "x", resource: { mediaType: "image/png", bytes: limited.bytes }, author: alice.ref("orig") })).kind).toBe("draft");
  });

  test("resourceBytes and package never read a stored buffer's own length", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const store = new MemoryStore();
    const sdk = OriginalsSDK.create({ store, authors: [alice.evidence()], clock: () => NOW });
    const c = await sdk.create({ name: "x", resource: { mediaType: "image/png", bytes: new Uint8Array(LARGE).fill(1) }, author: alice.ref("orig"), signer: alice.signer("orig", KEY) });
    if (c.kind !== "original") throw new Error("expected an Original");
    const { bytes, state } = shadowed(LARGE, 0);
    store.getResource = () => Promise.resolve(bytes);
    expect(await sdk.resourceBytes(resourceDigest(new Uint8Array(LARGE).fill(1)))).toBeDefined();
    expect((await sdk.package(c.original.did)).manifest.completeness).toBe("complete");
    expect(state.reads).toBe(0);
  });
});

describe("byte arrays are read through their internal slots, never their own properties", () => {
  /** A Uint8Array of 1s whose own properties claim other bytes, a length, or throw. */
  function shadowed(size: number): Uint8Array {
    const bytes = new Uint8Array(size).fill(1);
    const other = new Uint8Array(size).fill(2);
    for (const [key, get] of [
      ["buffer", () => other.buffer], ["byteLength", () => { throw new Error("byteLength read"); }],
      ["length", () => size + 1], ["slice", () => () => other],
    ] as const) Object.defineProperty(bytes, key, { get });
    return bytes;
  }

  test("bytesView covers exactly the array's memory without copying it", () => {
    const backing = new Uint8Array(64).fill(7);
    const sub = backing.subarray(8, 40);
    const view = bytesView(sub)!;
    expect(view.length).toBe(32);
    view[0] = 9;
    expect(backing[8]).toBe(9);
    expect(bytesView(shadowed(16))).toEqual(new Uint8Array(16).fill(1));
    expect(bytesView([1, 2])).toBeUndefined();
    expect(bytesView(new Int8Array(2))).toBeUndefined();
  });

  for (const size of [32, LARGE]) {
    test(`a ${size}-byte draft keeps exactly the bytes it hashed and sized, whatever the array's own properties say (C12-02)`, async () => {
      const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
      const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: () => NOW });
      const draft = await sdk.prepareCreate({ name: "x", resource: { mediaType: "image/png", bytes: shadowed(size) }, author: alice.ref("orig") });
      const state = draft.entry.state as unknown as { asset: { resource: { digest: string; size: number } } };
      expect(state.asset.resource.digest).toBe(resourceDigest(new Uint8Array(size).fill(1)));
      expect(state.asset.resource.size).toBe(size);
      expect(resourceDigest(draft.bytes.get(state.asset.resource.digest)!)).toBe(state.asset.resource.digest);
    });
  }
});

describe("prepare reads resource.bytes as main did, and an empty array keeps exactly nothing", () => {
  test("a getter on the resource is read four times, so one that throws on its fourth read still throws", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: () => NOW });
    for (const limit of [Infinity, 3]) {
      let reads = 0;
      const value = new Uint8Array(LARGE).fill(3);
      const resource = { mediaType: "image/png", get bytes() { if (++reads > limit) throw new Error("fourth read"); return value; } };
      const result = await sdk.prepareCreate({ name: "x", resource, author: alice.ref("orig") }).then(() => "draft", (e: Error) => e.message);
      expect([reads, result]).toEqual(limit === Infinity ? [4, "draft"] : [4, "fourth read"]);
    }
  });

  test("resource.bytes and mediaType are read in main's order, so the same getter throws first", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: () => NOW });
    const events: string[] = [];
    const value = new Uint8Array(LARGE).fill(4);
    const resource = {
      get bytes() { events.push("bytes"); if (events.length > 4) throw new TypeError("late bytes"); return value; },
      get mediaType() { events.push("mediaType"); throw new RangeError("mediaType"); },
    };
    const error = await sdk.prepareCreate({ name: "x", resource: resource as never, author: alice.ref("orig") }).catch((e: Error) => e);
    expect(events).toEqual(["bytes", "bytes", "bytes", "mediaType"]);
    expect(error).toBeInstanceOf(RangeError);
  });

  test("an empty array's buffer is not read through its own properties", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: () => NOW });
    const empty = new Uint8Array(0);
    Object.defineProperty(empty.buffer, "detached", { get() { throw new RangeError("detached read"); } });
    expect((await sdk.prepareCreate({ name: "x", resource: { mediaType: "image/png", bytes: empty }, author: alice.ref("orig") })).kind).toBe("draft");
  });

  test("an empty array whose own constructor would make slice return other bytes keeps the empty bytes it hashed (C12-02)", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: () => NOW });
    const empty = new Uint8Array(0);
    Object.defineProperty(empty, "constructor", { value: { [Symbol.species]: function () { return new Uint8Array([9]); } } });
    const draft = await sdk.prepareCreate({ name: "x", resource: { mediaType: "image/png", bytes: empty }, author: alice.ref("orig") });
    const state = draft.entry.state as unknown as { asset: { resource: { digest: string; size: number } } };
    expect(state.asset.resource.size).toBe(0);
    expect(draft.bytes.get(state.asset.resource.digest)).toEqual(new Uint8Array(0));
  });

  test("an empty view of a detached buffer still throws a TypeError", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: () => NOW });
    const bytes = new Uint8Array(8);
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
    await expect(sdk.prepareCreate({ name: "x", resource: { mediaType: "image/png", bytes }, author: alice.ref("orig") })).rejects.toBeInstanceOf(TypeError);
  });
});

describe("prepareCreate reads its arguments as many times as it did, at every size", () => {
  const reads = (size: number) => {
    let n = 0;
    return { size, metadata: { get a() { return ++n; } } };
  };

  test("a counting getter is read the same number of times for a large resource as for a small one", async () => {
    const { sdk, author } = await setup();
    const metadataOf = async ({ size, metadata }: ReturnType<typeof reads>) =>
      (await sdk.prepareCreate({ name: "x", metadata: metadata as never, resource: { mediaType: "image/png", bytes: new Uint8Array(size).fill(1) }, author })).entry.state.asset.metadata;
    const small = await metadataOf(reads(32));
    expect(await metadataOf(reads(LARGE))).toEqual(small);
  });

  test("a getter that throws once read more often than before does not fail a large create", async () => {
    const { sdk, author } = await setup();
    // Measured on the synchronous path: how often a create reads a metadata field.
    let seen = 0;
    await sdk.prepareCreate({ name: "x", metadata: { get a() { return ++seen; } } as never, resource: { mediaType: "image/png", bytes: new Uint8Array(32).fill(1) }, author });
    let n = 0;
    const metadata = { get a() { if (++n > seen) throw new Error("read once too often"); return 1; } };
    const draft = await sdk.prepareCreate({ name: "x", metadata: metadata as never, resource: { mediaType: "image/png", bytes: new Uint8Array(LARGE).fill(1) }, author });
    expect(draft.entry.state.asset.metadata).toEqual({ a: 1 });
  });
});

test("a detached buffer is refused with the TypeError it was before", async () => {
  const { sdk, author } = await setup();
  const bytes = new Uint8Array(LARGE).fill(1);
  structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
  let expected: unknown;
  try {
    bytes.slice();
  } catch (e) {
    expected = e;
  }
  expect(expected).toBeInstanceOf(TypeError);
  const error = await sdk.prepareCreate({ name: "detached", resource: { mediaType: "image/png", bytes }, author }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TypeError);
  expect((error as TypeError).message).toBe((expected as TypeError).message);
});
