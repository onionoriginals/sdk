import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { localSigner, type DataIntegrityProof } from "../src/crypto/index.js";
import { parseJson, type JsonObject } from "../src/json/index.js";
import { OriginalsError } from "../src/errors.js";
import {
  appendEntry,
  createLog,
  keyHash,
  parseLog,
  selectVersion,
  serializeLog,
  signWith,
  verifyLog,
  type LogEntry,
  type LogVerification,
  type Specialisation,
  vhHash,
} from "../src/log/index.js";

const fixture = parseJson(
  readFileSync(new URL("./fixtures/didwebvh-ts-2.8.0.json", import.meta.url), "utf8"),
) as unknown as { logA: LogEntry[]; witnessA: JsonObject[]; logC: LogEntry[] };

const NOW = Date.parse("2026-10-19T00:00:00Z");

/** Enough of did:webvh 1.0 to run its logs through the generic engine. */
const webvhLike: Specialisation = {
  name: "test did:webvh",
  versionParameter: "method",
  versions: { "did:webvh:1.0": { vhLog: "vh-log:1.0", rank: 1, entrySuites: ["eddsa-jcs-2022"], witnessSuites: ["eddsa-jcs-2022"] } },
  extraParameters: { portable: (value) => typeof value === "boolean" },
  keys: { kind: "updateKeys" },
};

const seeded = (seed: number) => localSigner("Ed25519", new Uint8Array(32).fill(seed));
const k1 = seeded(11);
const k2 = seeded(12);
const k3 = seeded(13);
const vm = (signer: { publicKeyMultibase: string }) => `did:key:${signer.publicKeyMultibase}#${signer.publicKeyMultibase}`;
const sign = (signer = k2) => signWith(signer, { cryptosuite: "eddsa-jcs-2022", verificationMethod: vm(signer) });

const clone = <T>(value: T): T => structuredClone(value);
const verify = (entries: unknown[], witnessFile: unknown = fixture.witnessA, specialisation = webvhLike, extra = {}) =>
  verifyLog(entries, { specialisation, witnessFile, now: NOW, ...extra });

/** Re-sign an altered entry as-is, so that only the check under test fails. */
async function resign(entry: LogEntry, signer = k2): Promise<LogEntry> {
  const { proof: _proof, ...unsigned } = entry;
  return { ...entry, proof: await sign(signer)(unsigned as unknown as JsonObject) };
}

function failedAt(result: LogVerification, index: number, code: string) {
  expect(result.failure?.index).toBe(index);
  expect(result.failure?.error.code).toBe(code);
  expect(result.entries.length).toBe(index);
}

describe("VH-Log engine against didwebvh-ts 2.8.0 output", () => {
  test("verifies pre-rotation, rotation, witness activation and witness removal", async () => {
    const result = await verify(fixture.logA);
    expect(result.failure).toBeUndefined();
    expect(result.entries.map((e) => e.versionNumber)).toEqual([1, 2, 3, 4]);
    expect(result.scid).toBe(fixture.logA[0].parameters.scid as string);
    expect(result.entries.map((e) => e.witnessed)).toEqual([false, false, true, true]);
    // Entry 4 sets witness {}: it is witnessed under the outgoing list, after which none is active.
    expect(result.active.witness).toEqual({});
    expect(result.deactivated).toBe(false);
  });

  test("round-trips through JSON Lines", async () => {
    const text = serializeLog(fixture.logA);
    expect(text.split("\n").length).toBe(5);
    expect((await verify(parseLog(text))).entries.length).toBe(4);
  });

  test("a deactivated log is reported deactivated, and nothing may follow it", async () => {
    const result = await verify(fixture.logC, []);
    expect(result.failure).toBeUndefined();
    expect(result.deactivated).toBe(true);
    const after = await appendEntry(fixture.logC[1], {
      versionTime: "2026-10-18T23:59:00Z", parameters: {}, state: fixture.logC[1].state, sign: sign(k1),
    });
    failedAt(await verify([...fixture.logC, after], []), 2, "ENTRY_AFTER_DEACTIVATION");
  });

  test("an entry without a threshold of witness proofs ends the valid prefix", async () => {
    failedAt(await verify(fixture.logA, []), 2, "WITNESS_THRESHOLD");
    const [w3] = fixture.witnessA as unknown as Array<{ versionId: string; proof: DataIntegrityProof[] }>;
    failedAt(await verify(fixture.logA, [{ versionId: w3.versionId, proof: [w3.proof[0]] }]), 2, "WITNESS_THRESHOLD");
  });

  test("a proof for a later entry approves the entries before it", async () => {
    const result = await verify(fixture.logA, [fixture.witnessA[1]]);
    expect(result.failure).toBeUndefined();
  });

  test("witness proofs that do not verify, or come from unlisted witnesses, do not count", async () => {
    const files = clone(fixture.witnessA) as unknown as Array<{ versionId: string; proof: DataIntegrityProof[] }>;
    files[1].proof[0].proofValue = files[0].proof[0].proofValue;
    files[0].proof = [files[0].proof[0]];
    // Entry 3 still has witnesses 1 and 3 (a later proof counts); entry 4 has only witness 3.
    failedAt(await verify(fixture.logA, files), 3, "WITNESS_THRESHOLD");
    const stranger = await signWith(k3, { cryptosuite: "eddsa-jcs-2022", verificationMethod: vm(k3) })({ versionId: fixture.logA[3].versionId });
    failedAt(await verify(fixture.logA, [{ versionId: fixture.logA[3].versionId, proof: [...files[0].proof, ...stranger] }]), 2, "WITNESS_THRESHOLD");
  });
});

describe("C12-04: broken chain or reordered entry", () => {
  test("a changed byte fails the proof and ends the valid prefix", async () => {
    const log = clone(fixture.logA);
    (log[1].state as JsonObject).controller = "did:example:other";
    failedAt(await verify(log), 1, "PROOF_SIGNATURE");
  });

  test("a re-signed changed entry still fails its entry hash", async () => {
    const log = clone(fixture.logA);
    (log[1].state as JsonObject).controller = "did:example:other";
    log[1] = await resign(log[1]);
    failedAt(await verify(log), 1, "ENTRY_HASH_MISMATCH");
  });

  test("C12-03: a changed first entry invalidates the whole log, by hash or by SCID", async () => {
    const log = clone(fixture.logA);
    (log[0].state as JsonObject).controller = "did:example:other";
    const unsigned = await verify(log);
    failedAt(unsigned, 0, "PROOF_SIGNATURE");
    expect(unsigned.scid).toBeNull();
    log[0] = await resign(log[0], k1);
    failedAt(await verify(log), 0, "ENTRY_HASH_MISMATCH");
    // With the entry hash recomputed too, only the SCID binding catches it.
    const { proof: _p, ...body } = log[0];
    log[0] = await resign({ ...log[0], versionId: `1-${vhHash({ ...(body as unknown as JsonObject), versionId: log[0].parameters.scid as string })}` }, k1);
    failedAt(await verify(log), 0, "SCID_MISMATCH");
  });

  test("reordered or renumbered entries are rejected", async () => {
    failedAt(await verify([fixture.logA[0], fixture.logA[2], fixture.logA[1]]), 1, "PREROTATION_UPDATE_KEYS");
    failedAt(await verify([fixture.logA[1]]), 0, "VERSION_MISSING");
    const renumbered = clone(fixture.logA);
    renumbered[1] = await resign({ ...renumbered[1], versionId: renumbered[1].versionId.replace(/^2-/, "3-") });
    failedAt(await verify(renumbered), 1, "VERSION_NUMBER");
  });

  test("an entry hash that is not a sha2-256 multihash is unsupported", async () => {
    const log = clone(fixture.logA);
    log[1] = await resign({ ...log[1], versionId: "2-" + "8".repeat(46) });
    const result = await verify(log);
    expect(result.failure?.index).toBe(1);
    expect(result.failure?.error.category).toBe("unsupported-profile");
    log[1] = await resign({ ...log[1], versionId: "2-QmfFTzmYhf-x" });
    failedAt(await verify(log), 1, "VERSION_ID_FORMAT");
  });
});

describe("authorized keys and pre-rotation", () => {
  const first = fixture.logA[0];

  test("an entry signed by a key outside the active updateKeys is unauthorized", async () => {
    const entry = await appendEntry(first, {
      versionTime: "2026-10-18T12:00:02Z", parameters: { updateKeys: [k2.publicKeyMultibase], nextKeyHashes: [] },
      state: first.state, sign: sign(k1),
    });
    failedAt(await verify([first, entry]), 1, "UNAUTHORIZED_KEY");
  });

  test("pre-rotation requires explicit updateKeys whose hashes were committed", async () => {
    const missing = await appendEntry(first, { versionTime: "2026-10-18T12:00:02Z", parameters: {}, state: first.state, sign: sign(k1) });
    failedAt(await verify([first, missing]), 1, "PREROTATION_UPDATE_KEYS");
    const uncommitted = await appendEntry(first, {
      versionTime: "2026-10-18T12:00:02Z", parameters: { updateKeys: [k3.publicKeyMultibase], nextKeyHashes: [] },
      state: first.state, sign: sign(k3),
    });
    failedAt(await verify([first, uncommitted]), 1, "PREROTATION_KEY");
    const noNext = await appendEntry(first, {
      versionTime: "2026-10-18T12:00:02Z", parameters: { updateKeys: [k2.publicKeyMultibase] }, state: first.state, sign: sign(k2),
    });
    failedAt(await verify([first, noNext]), 1, "PREROTATION_NEXT_KEY_HASHES");
  });

  test("keyHash matches didwebvh-ts deriveNextKeyHash", () => {
    expect(keyHash(k2.publicKeyMultibase)).toBe((first.parameters.nextKeyHashes as string[])[0]);
  });
});

describe("versionTime", () => {
  const [first] = fixture.logA;
  const next = (versionTime: string) =>
    appendEntry(first, { versionTime, parameters: { updateKeys: [k2.publicKeyMultibase], nextKeyHashes: [] }, state: first.state, sign: sign(k2) });

  test("must strictly increase, in whole UTC seconds, and not lie in the future", async () => {
    failedAt(await verify([first, await next("2026-10-18T12:00:01Z")]), 1, "VERSION_TIME_ORDER");
    failedAt(await verify([first, await next("2026-10-18T12:00:00Z")]), 1, "VERSION_TIME_ORDER");
    failedAt(await verify([first, await next("2026-10-18T12:00:02.5Z")]), 1, "VERSION_TIME_FORMAT");
    failedAt(await verify([first, await next("2026-10-18T13:00:02+01:00")]), 1, "VERSION_TIME_FORMAT");
    failedAt(await verify([first, await next("2026-10-18T12:00:02")]), 1, "VERSION_TIME_FORMAT");
    failedAt(await verify([first, await next("2026-02-30T12:00:02Z")]), 1, "VERSION_TIME_FORMAT");
    failedAt(await verify([first, await next("2026-10-19T00:05:01Z")]), 1, "VERSION_TIME_FUTURE");
    expect((await verify([first, await next("2026-10-19T00:05:00Z")])).failure).toBeUndefined();
    expect((await verify([first, await next("2026-10-18T12:00:02+00:00")])).failure).toBeUndefined();
  });

  test("a specialisation may permit fractional seconds and a minimum interval (VH-Log PR 8)", async () => {
    const precise: Specialisation = { ...webvhLike, versionTime: { fractionalDigits: 3, minIntervalSeconds: 0.5 } };
    expect((await verify([first, await next("2026-10-18T12:00:01.500Z")], [], precise)).failure).toBeUndefined();
    failedAt(await verify([first, await next("2026-10-18T12:00:01.499Z")], [], precise), 1, "VERSION_TIME_INTERVAL");
    failedAt(await verify([first, await next("2026-10-18T12:00:02.0001Z")], [], precise), 1, "VERSION_TIME_FORMAT");
  });
});

describe("parameters", () => {
  const [first] = fixture.logA;
  const withParameters = (parameters: JsonObject) =>
    appendEntry(first, { versionTime: "2026-10-18T12:00:02Z", parameters: { updateKeys: [k2.publicKeyMultibase], nextKeyHashes: [], ...parameters }, state: first.state, sign: sign(k2) });

  test("null, unknown and misplaced parameters are rejected", async () => {
    failedAt(await verify([first, await withParameters({ ttl: null })]), 1, "PARAMETER_NULL");
    failedAt(await verify([first, await withParameters({ color: "blue" })]), 1, "PARAMETER_UNKNOWN");
    failedAt(await verify([first, await withParameters({ logVersion: "vh-log:1.0" })]), 1, "PARAMETER_UNKNOWN");
    failedAt(await verify([first, await withParameters({ scid: first.parameters.scid as string })]), 1, "PARAMETER_SCID");
    failedAt(await verify([first, await withParameters({ ttl: -1 })]), 1, "PARAMETER_INVALID");
    failedAt(await verify([first, await withParameters({ watchers: ["ftp://watcher.example"] })]), 1, "PARAMETER_INVALID");
    failedAt(await verify([first, await withParameters({ watchers: ["https:///path"] })]), 1, "PARAMETER_INVALID");
    expect((await verify([first, await withParameters({ watchers: ["http://watcher.example", "https://w.example/x"] })])).failure).toBeUndefined();
    failedAt(await verify([first, await withParameters({ portable: "yes" })]), 1, "PARAMETER_INVALID");
  });

  test("the version parameter must name a known version and never move to a lower one", async () => {
    failedAt(await verify([first, await withParameters({ method: "did:webvh:9.9" })]), 1, "VERSION_UNSUPPORTED");
    const two: Specialisation = {
      ...webvhLike,
      versions: { ...webvhLike.versions, "did:webvh:0.5": { vhLog: "vh-log:1.0", rank: 0, entrySuites: ["eddsa-jcs-2022"], witnessSuites: ["eddsa-jcs-2022"] } },
    };
    failedAt(await verify([first, await withParameters({ method: "did:webvh:0.5" })], [], two), 1, "VERSION_DOWNGRADE");
  });

  test("malformed witness parameters are rejected, not coerced to no witnesses", async () => {
    const w = (id: string) => ({ id });
    const ids = fixture.logA[2].parameters.witness as { witnesses: Array<{ id: string }> };
    const [a, b] = ids.witnesses.map((x) => x.id);
    for (const witness of [
      { threshold: 3, witnesses: [w(a), w(b)] },
      { threshold: 0, witnesses: [w(a)] },
      { threshold: 1.5, witnesses: [w(a), w(b)] },
      { threshold: 1, witnesses: [w(a), w(a)] },
      { threshold: 1, witnesses: [] },
      { threshold: 1, witnesses: [w("did:web:example.com")] },
      { threshold: 1, witnesses: [{ id: a, weight: 2 }] },
      { witnesses: [w(a)] },
    ]) {
      failedAt(await verify([first, await withParameters({ witness: witness as never })]), 1, "PARAMETER_INVALID");
    }
  });
});

describe("proofs", () => {
  const [first] = fixture.logA;
  const params = { updateKeys: [k2.publicKeyMultibase], nextKeyHashes: [] };

  test("proofPurpose must be assertionMethod and the suite must be permitted by the version", async () => {
    const auth = await appendEntry(first, {
      versionTime: "2026-10-18T12:00:02Z", parameters: params, state: first.state,
      sign: signWith(k2, { cryptosuite: "eddsa-jcs-2022", verificationMethod: vm(k2), proofPurpose: "authentication" }),
    });
    failedAt(await verify([first, auth]), 1, "PROOF_PURPOSE");
    // An authorized key whose proof names a suite the version does not permit.
    const other = await appendEntry(fixture.logA[1], { versionTime: "2026-10-18T12:00:03Z", parameters: {}, state: first.state, sign: sign(k2) });
    other.proof[0].cryptosuite = "bip340-jcs-2025";
    failedAt(await verify([first, fixture.logA[1], other]), 2, "CRYPTOSUITE_NOT_PERMITTED");
  });

  test("an entry with members VH-Log does not define is rejected", async () => {
    const log = clone(fixture.logA);
    (log[1] as unknown as JsonObject).note = "extra";
    failedAt(await verify(log), 1, "ENTRY_MEMBERS");
    const empty = clone(fixture.logA);
    empty[1].proof = [];
    failedAt(await verify(empty), 1, "PROOF_MISSING");
  });

  test("a specialisation can require exactly one proof", async () => {
    const one: Specialisation = { ...webvhLike, maxProofs: 1 };
    const doubled = clone(fixture.logA);
    doubled[1].proof = [doubled[1].proof[0], doubled[1].proof[0]];
    failedAt(await verify(doubled, fixture.witnessA, one), 1, "PROOF_COUNT");
  });
});

describe("keys from a controller (VH-Log PR 11)", () => {
  const author = seeded(40);
  const controlled: Specialisation = {
    name: "test controller",
    versionParameter: "method",
    versions: { "test:1.0": { vhLog: "vh-log:1.0", rank: 1, entrySuites: ["eddsa-jcs-2022"], witnessSuites: ["eddsa-jcs-2022"] } },
    keys: {
      kind: "controller",
      authorize: ({ proof }) => {
        if (proof.verificationMethod !== "did:example:author#k") {
          throw new OriginalsError("unauthorized-key", "TEST_NOT_AUTHOR", "not the author's key");
        }
        return Promise.resolve(author.publicKeyMultibase);
      },
    },
  };
  const authorSign = signWith(author, { cryptosuite: "eddsa-jcs-2022", verificationMethod: "did:example:author#k" });

  test("authorizes entries with the controller's key and forbids updateKeys", async () => {
    const genesis = await createLog({ versionTime: "2026-10-18T10:00:00Z", parameters: { method: "test:1.0", scid: "{SCID}" }, state: { id: "test:{SCID}" }, sign: authorSign });
    expect((genesis.state as JsonObject).id).toBe(`test:${genesis.parameters.scid as string}`);
    const next = await appendEntry(genesis, { versionTime: "2026-10-18T10:00:01Z", parameters: {}, state: { id: (genesis.state as JsonObject).id }, sign: authorSign });
    expect((await verify([genesis, next], [], controlled)).failure).toBeUndefined();

    const keyed = await appendEntry(genesis, { versionTime: "2026-10-18T10:00:01Z", parameters: { updateKeys: [author.publicKeyMultibase] }, state: {}, sign: authorSign });
    failedAt(await verify([genesis, keyed], [], controlled), 1, "PARAMETER_FORBIDDEN");
    const hashed = await appendEntry(genesis, { versionTime: "2026-10-18T10:00:01Z", parameters: { nextKeyHashes: [] }, state: {}, sign: authorSign });
    failedAt(await verify([genesis, hashed], [], controlled), 1, "PARAMETER_FORBIDDEN");
  });

  test("a failed authorization ends the prefix, and a wrong signature is not rescued", async () => {
    const genesis = await createLog({ versionTime: "2026-10-18T10:00:00Z", parameters: { method: "test:1.0", scid: "{SCID}" }, state: {}, sign: authorSign });
    const other = signWith(k3, { cryptosuite: "eddsa-jcs-2022", verificationMethod: "did:example:author#k" });
    const forged = await appendEntry(genesis, { versionTime: "2026-10-18T10:00:01Z", parameters: {}, state: {}, sign: other });
    failedAt(await verify([genesis, forged], [], controlled), 1, "PROOF_SIGNATURE");
    const stranger = signWith(k3, { cryptosuite: "eddsa-jcs-2022", verificationMethod: "did:example:stranger#k" });
    const foreign = await appendEntry(genesis, { versionTime: "2026-10-18T10:00:01Z", parameters: {}, state: {}, sign: stranger });
    const result = await verify([genesis, foreign], [], controlled);
    expect(result.failure?.index).toBe(1);
    expect(result.failure?.error.category).toBe("unauthorized-key");
  });
});

describe("selecting a version and limits", () => {
  test("by versionId, versionTime and versionNumber", async () => {
    const result = await verify(fixture.logA);
    expect(selectVersion(result, { versionId: fixture.logA[1].versionId })?.versionNumber).toBe(2);
    expect(selectVersion(result, { versionTime: "2026-10-18T12:00:03Z" })?.versionNumber).toBe(3);
    expect(selectVersion(result, { versionTime: "2026-10-18T12:00:03.9Z" })?.versionNumber).toBe(3);
    expect(selectVersion(result, { versionTime: "2026-10-18T12:00:00Z" })).toBeUndefined();
    expect(selectVersion(result, { versionNumber: 4 })?.versionNumber).toBe(4);
    expect(selectVersion(result, { versionNumber: 5 })).toBeUndefined();
    expect(selectVersion(result, {})?.versionNumber).toBe(4);
    expect(() => selectVersion(result, { versionNumber: 1, versionId: "x" })).toThrow();
  });

  test("C12-91 (engine): a history beyond the limit reports the last valid prefix as limit-exceeded", async () => {
    const result = await verify(fixture.logA, fixture.witnessA, webvhLike, { limits: { maxEntries: 2 } });
    expect(result.entries.length).toBe(2);
    expect(result.failure?.index).toBe(2);
    expect(result.failure?.error.category).toBe("limit-exceeded");
  });
});
