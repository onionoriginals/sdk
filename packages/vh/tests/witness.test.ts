/**
 * Witnessed Originals in the verifier (plan 011, PR 7a): the witness parameter
 * follows the author DID's declaration (P9.9; owner decision Q6, plan §2.2),
 * entries after activation need threshold witness proofs to be current (P9.8),
 * and activation proves ordering from that entry on only (P7.6).
 */
import { describe, expect, test } from "bun:test";
import type { ProofSigner } from "../src/crypto/index.js";
import type { JsonObject } from "../src/json/index.js";
import { createWitnessProof, type LogEntry } from "../src/log/index.js";
import { createOriginal, resourceDigest, updateOriginal, verifyOriginal, type OriginalsReport } from "../src/originals/index.js";
import { NOW, VhAuthor, bytes, clock, photo, seeded, witnessSet } from "./helpers/originals.js";

const B1 = "harbor at dawn, first crop";
const B2 = "harbor at dawn, tighter crop";
const allBytes = Object.fromEntries([B1, B2].map((t) => [resourceDigest(bytes(t)), bytes(t)]));
const KEY = seeded(21);

async function witnessed(declaration = witnessSet([31, 32, 33], 2)) {
  const alice = await VhAuthor.create([{ fragment: "orig", signer: KEY }], declaration.declaration);
  const at = clock();
  const sign = alice.signer(KEY, "orig");
  const ref = alice.ref("orig");
  const genesis = await createOriginal({ versionTime: at(), name: "Harbor at dawn", resources: [photo(B1)], author: ref, sign });
  const activation = await updateOriginal(genesis, { versionTime: at(), witness: declaration.declaration, author: ref, sign });
  return { alice, at, sign, ref, genesis, activation, w: declaration.signers, declaration: declaration.declaration };
}

/** A witness file approving each entry by the given witnesses. */
async function approvals(entries: LogEntry[], by: ProofSigner[]): Promise<unknown[]> {
  return Promise.all(entries.map(async (e) => ({ versionId: e.versionId, proof: await Promise.all(by.map((w) => createWitnessProof(w, e.versionId))) })));
}

const verify = (log: LogEntry[], authors: VhAuthor[], witnessFile?: unknown): Promise<OriginalsReport> =>
  verifyOriginal({ log, authors: authors.map((a) => a.evidence()), now: NOW, bytes: allBytes, freshness: "asserted", ...(witnessFile ? { witnessFile } : {}) });

function rejected(r: OriginalsReport, index: number, code: string) {
  expect(r.history.failure?.index, JSON.stringify(r.history.failure)).toBe(index);
  expect(r.history.failure?.code).toBe(code);
  expect(r.current).toBe(false);
}

describe("activating witnesses (P9.8, P9.9)", () => {
  test("an entry that activates the declared witnesses, approved by a threshold, is current and witnessed", async () => {
    const { alice, genesis, activation, w } = await witnessed();
    const r = await verify([genesis, activation], [alice], await approvals([activation], w.slice(0, 2)));
    expect(r.history.status).toBe("valid");
    expect(r.ordering).toBe("witnessed");
    expect(r.witnessedFrom).toBe(activation.versionId);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-53: an entry that sets a witness list the author DID does not declare is rejected", async () => {
    const { alice, genesis, ref, sign, at } = await witnessed();
    const other = witnessSet([41, 42, 43], 2);
    const entry = await updateOriginal(genesis, { versionTime: at(), witness: other.declaration, author: ref, sign });
    rejected(await verify([genesis, entry], [alice], await approvals([entry], other.signers)), 1, "WITNESS_NOT_DECLARED");
  });

  test("an author DID with no declaration cannot activate witnesses", async () => {
    const alice = await VhAuthor.create([{ fragment: "orig", signer: KEY }]);
    const set = witnessSet([31, 32, 33], 2);
    const genesis = await createOriginal({ versionTime: "2026-10-18T12:00:00.000Z", name: "x", resources: [photo(B1)], author: alice.ref("orig"), sign: alice.signer(KEY, "orig") });
    const entry = await updateOriginal(genesis, { versionTime: "2026-10-18T12:00:01.000Z", witness: set.declaration, author: alice.ref("orig"), sign: alice.signer(KEY, "orig") });
    rejected(await verify([genesis, entry], [alice], await approvals([entry], set.signers)), 1, "WITNESS_NOT_DECLARED");
  });

  test("P9.8: a declaration with fewer than three witnesses, or a threshold of one or of all, is invalid", async () => {
    for (const [seeds, threshold] of [[[31, 32], 2], [[31, 32, 33], 1], [[31, 32, 33], 3]] as Array<[number[], number]>) {
      const { alice, genesis, activation, w } = await witnessed(witnessSet(seeds, threshold));
      rejected(await verify([genesis, activation], [alice], await approvals([activation], w)), 1, "WITNESS_DECLARATION_INVALID");
    }
  });
});

describe("after activation", () => {
  test("C12-55: an entry without threshold witness proofs is not current, whatever the deployment", async () => {
    const { alice, genesis, activation, w, ref, sign, at } = await witnessed();
    const edit = await updateOriginal(activation, { versionTime: at(), resources: [photo(B2)], author: ref, sign });
    const file = [...(await approvals([activation], w.slice(0, 2))), ...(await approvals([edit], w.slice(0, 1)))];
    const r = await verify([genesis, activation, edit], [alice], file);
    rejected(r, 2, "WITNESS_THRESHOLD");
    expect(r.head).toBe(activation.versionId);
  });

  test("C12-54: an entry that sets the witness parameter to an empty object is rejected", async () => {
    const { alice, genesis, activation, w, ref, sign, at } = await witnessed();
    const off = await updateOriginal(activation, { versionTime: at(), witness: {}, author: ref, sign });
    rejected(await verify([genesis, activation, off], [alice], await approvals([activation, off], w)), 2, "WITNESS_REMOVED");
  });

  test("a changed declaration must be carried into the log by the next entry, which the old witnesses approve", async () => {
    const { alice, genesis, activation, w, sign, at } = await witnessed();
    const next = witnessSet([41, 42, 43], 2);
    alice.witnesses = next.declaration;
    await alice.rotate([{ fragment: "orig", signer: KEY }]);
    const ref = alice.ref("orig");
    const stale = await updateOriginal(activation, { versionTime: at(), name: "Harbor", author: ref, sign });
    rejected(await verify([genesis, activation, stale], [alice], await approvals([activation, stale], w)), 2, "WITNESS_DECLARATION_MISMATCH");
    const moved = await updateOriginal(activation, { versionTime: at(), witness: next.declaration, author: ref, sign });
    const file = await approvals([activation, moved], w.slice(0, 2));
    expect((await verify([genesis, activation, moved], [alice], file)).current).toBe(true);
    // From then on the new witnesses approve.
    const after = await updateOriginal(moved, { versionTime: at(), name: "Harbor", author: ref, sign });
    expect((await verify([genesis, activation, moved, after], [alice], [...file, ...(await approvals([after], next.signers.slice(0, 2)))])).current).toBe(true);
    expect((await verify([genesis, activation, moved, after], [alice], [...file, ...(await approvals([after], w.slice(0, 2)))])).current).toBe(false);
  });

  test("C12-46 (witnessed): an approved entry stays current after its key is removed; a later entry by that key gets no approvals and is not current", async () => {
    const { alice, genesis, activation, w, sign, at } = await witnessed();
    const v1 = alice.versionId;
    await alice.rotate([{ fragment: "orig2", signer: seeded(23) }]);
    const file = await approvals([activation], w.slice(0, 2));
    expect((await verify([genesis, activation], [alice], file)).current).toBe(true);
    const thief = await updateOriginal(activation, { versionTime: at(), name: "Not by Alice", author: alice.ref("orig", v1), sign });
    const r = await verify([genesis, activation, thief], [alice], file);
    rejected(r, 2, "WITNESS_THRESHOLD");
  });

  test("C12-56: activation proves ordering from its own entry on, not before (P7.6)", async () => {
    const declaration = witnessSet([31, 32, 33], 2);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: KEY }], declaration.declaration);
    const at = clock();
    const v1 = alice.ref("orig");
    const genesis = await createOriginal({ versionTime: at(), name: "Harbor", resources: [photo(B1)], author: v1, sign: alice.signer(KEY, "orig") });
    // The key that signed genesis is later removed; the author activates witnesses with the new key.
    const fresh = seeded(23);
    await alice.rotate([{ fragment: "orig2", signer: fresh }]);
    const unwitnessedHead = await verify([genesis], [alice]);
    expect(unwitnessedHead.ordering).toBe("claimed");
    expect(unwitnessedHead.current).toBe(false);
    const activation = await updateOriginal(genesis, { versionTime: at(), witness: declaration.declaration, author: alice.ref("orig2"), sign: alice.signer(fresh, "orig2") });
    const r = await verify([genesis, activation], [alice], await approvals([activation], declaration.signers.slice(0, 2)));
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    expect(r.witnessedFrom).toBe(activation.versionId); // genesis keeps claimed ordering
  });
});

describe("witness proofs", () => {
  test("only eddsa-jcs-2022 did:key witnesses are accepted (plan 011, S3)", async () => {
    const bip = witnessSet([31, 32, 33], 2);
    const keys = bip.signers.map((_, i) => seeded(51 + i, "secp256k1"));
    const declaration: JsonObject = { threshold: 2, witnesses: keys.map((k) => ({ id: `did:key:${k.publicKeyMultibase}` })) };
    const { alice, genesis, activation } = await witnessed({ signers: keys, declaration });
    const r = await verify([genesis, activation], [alice]);
    expect(r.current).toBe(false);
    expect(r.history.failure?.code).toBe("PARAMETER_INVALID");
  });
});
