/**
 * Native SHA-256 must not change what a prepare reads (P4.3). `prepareCreate`
 * and `prepareEdit` hash a new resource version with `resourceDigestAsync`,
 * but read and check the caller's input before anything is awaited, as when
 * the digest was computed synchronously: a caller that changes its input or
 * its bytes after the call gets the draft, or the error, it would have got
 * before. Bytes kept in a draft are a private copy, so they always match their
 * digest (C12-02).
 */
import { describe, expect, test } from "bun:test";
import { NATIVE_SHA256_MIN_BYTES } from "@originals/vh/crypto";
import { resourceDigest } from "@originals/vh/originals";
import { OriginalsError } from "@originals/vh";
import { MemoryStore, OriginalsSDK } from "../../../src/originals/index.js";
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
    // Another size than the current version: hashed natively, after a stand-in check.
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
