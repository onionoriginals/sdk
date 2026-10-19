/**
 * Witnessed Originals through the SDK (plan 011, PR 7a): the reference
 * witness's obligations (P9.8) and witnessed commits, which leave the prior
 * checkpoint unchanged when approvals fall short (P6.1).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OriginalsError } from "@originals/vh";
import { localSigner } from "@originals/vh/crypto";
import { FileStore } from "../../../src/originals/fs-store.js";
import { MemoryStore, OriginalsSDK, OriginalsWitness, type OriginalsStore } from "../../../src/originals/index.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const KEY = seed(21);
const WITNESS_SEEDS = [31, 32, 33];

async function setup(options: { store?: OriginalsStore; witnessAge?: number[] } = {}) {
  const ids = WITNESS_SEEDS.map((n) => `did:key:${localSigner("Ed25519", seed(n)).publicKeyMultibase}`);
  const alice = await Author.create([{ fragment: "orig", secret: KEY }], { threshold: 2, witnesses: ids.map((id) => ({ id })) });
  const now = clock();
  let time = Date.parse("2026-10-18T12:00:00Z");
  const tick = () => (time = now());
  // Each witness reads the author DID itself, never from the request (P9.8).
  const witnesses = WITNESS_SEEDS.map((n, i) =>
    OriginalsWitness.create({
      secretKey: seed(n),
      authors: async (did) => (did === alice.did ? { evidence: alice.evidence(), retrievedAt: time - (options.witnessAge?.[i] ?? 0) } : undefined),
      clock: () => time,
    }),
  );
  const sdk = OriginalsSDK.create({ store: options.store ?? new MemoryStore(), authors: async () => alice.evidence(), freshness: "asserted", clock: tick, witnesses });
  const signer = alice.signer("orig", KEY);
  const c = await sdk.create({ name: "Harbor at dawn", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: bytes("first crop") }], author: alice.ref("orig"), signer });
  if (c.kind !== "original") throw new Error("expected an Original");
  return { alice, sdk, signer, witnesses, ids, tick, did: c.original.did, v1: c.original.checkpoint };
}

async function refused(run: () => Promise<unknown>, code: string): Promise<OriginalsError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OriginalsError);
  const error = caught as OriginalsError;
  expect(error.code).toBe("WITNESS_APPROVALS_INSUFFICIENT");
  const refusals = (error.details as { refusals: Array<{ code: string }> }).refusals;
  expect(refusals.map((r) => r.code)).toContain(code);
  return error;
}

describe("activating witnesses through the SDK (P9.8, P9.9)", () => {
  test("activation confirms the head, sets the declared witnesses and is approved by a threshold", async () => {
    const { sdk, alice, signer, did, v1 } = await setup();
    const activated = await sdk.activateWitnesses(did, { parent: v1, author: alice.ref("orig"), signer });
    expect(activated.original.report.ordering).toBe("witnessed");
    expect(activated.original.report.witnessedFrom).toBe(activated.original.checkpoint);
    expect(activated.original.current, JSON.stringify(activated.original.report.reasons)).toBe(true);
    // Later edits are witnessed too, and a fresh reader verifies the package with its witness proofs.
    const edited = await sdk.edit(did, { parent: activated.original.checkpoint, name: "Harbor", author: alice.ref("orig"), signer });
    expect(edited.original.report.ordering).toBe("witnessed");
    const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [], freshness: "asserted", clock: clock(Date.parse("2026-10-18T13:00:00Z")) });
    const loaded = await reader.load((await sdk.package(did)).bytes);
    expect(loaded.report.ordering).toBe("witnessed");
    expect(loaded.report.current, JSON.stringify(loaded.reasons)).toBe(true);
  });

  test("an author DID that declares no witnesses cannot activate them", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => alice.evidence(), freshness: "asserted", clock: clock() });
    const signer = alice.signer("orig", KEY);
    const c = await sdk.create({ name: "x", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: bytes("x") }], author: alice.ref("orig"), signer });
    if (c.kind !== "original") throw new Error("expected an Original");
    let caught: unknown;
    try {
      await sdk.activateWitnesses(c.original.did, { parent: c.original.checkpoint, author: alice.ref("orig"), signer });
    } catch (error) {
      caught = error;
    }
    expect((caught as OriginalsError).code).toBe("WITNESSES_NOT_DECLARED");
  });

  test("the witness file survives reopening a FileStore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "originals-witness-"));
    try {
      const { sdk, alice, signer, did, v1 } = await setup({ store: await FileStore.open(dir) });
      await sdk.activateWitnesses(did, { parent: v1, author: alice.ref("orig"), signer });
      const reopened = OriginalsSDK.create({ store: await FileStore.open(dir), authors: async () => alice.evidence(), freshness: "asserted", clock: clock(Date.parse("2026-10-18T13:00:00Z")) });
      const view = await reopened.get(did);
      expect(view.report.ordering).toBe("witnessed");
      expect(view.current).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the reference witness refuses (P9.8)", () => {
  test("C12-71: when it cannot obtain author DID state no more than 60 seconds old; the commit leaves the head unchanged", async () => {
    const { sdk, alice, signer, did, v1 } = await setup({ witnessAge: [0, 61_000, 61_000] });
    await refused(() => sdk.activateWitnesses(did, { parent: v1, author: alice.ref("orig"), signer }), "AUTHOR_STATE_STALE");
    expect((await sdk.get(did)).checkpoint).toBe(v1);
  });

  test("C12-42: an entry that does not extend the last entry it approved", async () => {
    const { sdk, alice, signer, did, v1, witnesses, tick } = await setup();
    const activated = await sdk.activateWitnesses(did, { parent: v1, author: alice.ref("orig"), signer });
    const v2 = activated.original.checkpoint;
    const elsewhere = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => alice.evidence(), freshness: "asserted", clock: tick, witnesses });
    await elsewhere.import((await sdk.package(did)).bytes);
    await sdk.edit(did, { parent: v2, name: "Approved first", author: alice.ref("orig"), signer });
    // A sibling of the approved entry, built on the same parent.
    await refused(() => elsewhere.edit(did, { parent: v2, name: "A competing edit", author: alice.ref("orig"), signer }), "NOT_EXTENDING_LAST_APPROVED");
  });

  test("C12-57 (witnessed): every entry once the author DID is deactivated", async () => {
    const { sdk, alice, signer, did, v1 } = await setup();
    const activated = await sdk.activateWitnesses(did, { parent: v1, author: alice.ref("orig"), signer });
    await alice.deactivate();
    // The SDK's own read of the author DID shows the deactivation too; the witnesses refuse independently.
    await refused(() => sdk.edit(did, { parent: activated.original.checkpoint, name: "After", author: alice.ref("orig"), signer }), "AUTHOR_DEACTIVATED");
  });

  test("C12-46 (witnessed): an entry signed by a key the latest author DID no longer lists", async () => {
    const { sdk, alice, signer, did, v1 } = await setup();
    const activated = await sdk.activateWitnesses(did, { parent: v1, author: alice.ref("orig"), signer });
    const old = alice.ref("orig");
    await alice.rotate([{ fragment: "orig2", secret: seed(23) }]);
    await refused(() => sdk.edit(did, { parent: activated.original.checkpoint, name: "Thief", author: old, signer }), "KEY_NOT_IN_LATEST");
  });

  test("a retried approval of the same entry is approved again, never a conflict", async () => {
    const { sdk, alice, signer, did, v1, witnesses } = await setup();
    await sdk.activateWitnesses(did, { parent: v1, author: alice.ref("orig"), signer });
    const stored = (await sdk.package(did)).bytes;
    const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock() });
    await reader.import(stored);
    const { log, witness } = (await reader["store"].get(did))!;
    const again = await witnesses[0].approve({ original: did, log, witness: witness as never });
    expect(again.verificationMethod).toContain(witnesses[0].id);
  });
});
