/**
 * One resource per Original (originals-spec #53; owner decision, 1 November
 * 2026; P4.1, P4.4, P14.4, P14.5, P14.6). An Original has exactly one
 * resource from genesis for its whole history; no entry adds a second one or
 * removes it. A change to its bytes is its next version, and earlier
 * versions stay verifiable in history (P8.3).
 */
import { describe, expect, test } from "bun:test";
import type { JsonObject } from "../src/json/index.js";
import { appendEntry, createLog, type LogEntry } from "../src/log/index.js";
import {
  ORIGINALS_METHOD,
  createOriginal,
  deactivateOriginal,
  resourceDigest,
  updateOriginal,
  verifyOriginal,
  type OriginalsReport,
} from "../src/originals/index.js";
import { NOW, VhAuthor, bytes, clock, photo, seeded } from "./helpers/originals.js";

const B1 = "harbor at dawn, first crop";
const B2 = "harbor at dawn, tighter crop";
const N1 = "a note about the harbor";
const texts = [B1, B2, N1];
const allBytes = Object.fromEntries(texts.map((t) => [resourceDigest(bytes(t)), bytes(t)]));
const KA = seeded(21);

async function harbor() {
  const alice = await VhAuthor.create([{ fragment: "orig", signer: KA }]);
  const at = clock();
  const ref = alice.ref("orig");
  const sign = alice.signer(KA, "orig");
  const genesis = await createOriginal({ versionTime: at(), name: "Harbor at dawn", resource: photo(B1), author: ref, sign });
  return { alice, at, ref, sign, genesis, asAlice: { author: ref, sign } };
}

const verify = (log: LogEntry[], dids: VhAuthor[]): Promise<OriginalsReport> =>
  verifyOriginal({ log, authors: dids.map((a) => a.evidence()), now: NOW, bytes: allBytes });

function failedWith(r: OriginalsReport, index: number, code: string, category?: string) {
  expect(r.history.failure?.index, JSON.stringify(r.history.failure)).toBe(index);
  expect(r.history.failure?.code).toBe(code);
  if (category) expect(r.history.failure?.category).toBe(category);
  expect(r.history.entries).toBe(index);
}

/** Sign an edited state after `previous`, bypassing the builder's checks. */
const forge = (previous: LogEntry, state: JsonObject, sign: Parameters<typeof appendEntry>[1]["sign"], parameters: JsonObject = {}) =>
  appendEntry(previous, { versionTime: "2026-10-18T12:30:00.000Z", parameters, state, sign });

/** Sign a genesis entry with this state, bypassing the builder's checks. */
const forgeGenesis = (genesis: LogEntry, asset: JsonObject, transitions: JsonObject[], sign: Parameters<typeof appendEntry>[1]["sign"]) =>
  createLog({
    versionTime: genesis.versionTime,
    parameters: { method: ORIGINALS_METHOD, scid: "{SCID}" },
    state: { ...genesis.state, id: "did:vh:{SCID}", asset, transitions },
    sign,
  });

const assetOf = (entry: LogEntry) => entry.state.asset as JsonObject;

describe("C12-16: an entry whose state has no resource, or more than one", () => {
  test("is rejected at genesis (P4.1, P14.5)", async () => {
    const { alice, genesis, asAlice } = await harbor();
    const { resource: _r, ...noResource } = assetOf(genesis);
    const t = genesis.state.transitions as JsonObject[];
    for (const [asset, code] of [
      [noResource, "STATE_MEMBERS"],
      [{ ...noResource, resource: [photo(B1), photo(N1)] }, "STATE_RESOURCE"],
      [{ ...noResource, resource: [photo(B1)] }, "STATE_RESOURCE"],
      [{ ...noResource, resources: [photo(B1), photo(N1)] }, "STATE_MEMBERS"],
      [{ ...assetOf(genesis), resources: [photo(N1)] }, "STATE_MEMBERS"],
    ] as Array<[JsonObject, string]>) {
      const forged = await forgeGenesis(genesis, asset, t, asAlice.sign);
      failedWith(await verify([forged], [alice]), 0, code, "invalid-evidence");
    }
    // The builder takes exactly one descriptor.
    await expect(createOriginal({ versionTime: genesis.versionTime, name: "x", resource: [photo(B1), photo(N1)] as never, ...asAlice })).rejects.toMatchObject({ code: "STATE_RESOURCE" });
    await expect(createOriginal({ versionTime: genesis.versionTime, name: "x", resources: [photo(B1)] } as never)).rejects.toMatchObject({ code: "STATE_RESOURCE" });
  });

  test("is rejected in an update: no entry adds a second resource or removes the one (P4.1)", async () => {
    const { alice, at, genesis, asAlice } = await harbor();
    const { resource: _r, ...noResource } = assetOf(genesis);
    const added = [{ from: photo(B1).digest, to: photo(N1).digest }];
    for (const [asset, transitions, code] of [
      [noResource, [], "STATE_MEMBERS"],
      [{ ...noResource, resource: [photo(B1), photo(N1)] }, [], "STATE_RESOURCE"],
      [{ ...assetOf(genesis), resources: [photo(N1)] }, added, "STATE_MEMBERS"],
    ] as Array<[JsonObject, JsonObject[], string]>) {
      const forged = await forge(genesis, { ...genesis.state, operation: "update", asset, transitions }, asAlice.sign);
      failedWith(await verify([genesis, forged], [alice]), 1, code, "invalid-evidence");
    }
    // The builder has no way to add or remove: `resources` and `remove` are refused, never ignored.
    await expect(updateOriginal(genesis, { versionTime: at(), resources: [photo(N1)], ...asAlice } as never)).rejects.toMatchObject({ code: "STATE_RESOURCE" });
    await expect(updateOriginal(genesis, { versionTime: at(), remove: ["photo"], ...asAlice } as never)).rejects.toMatchObject({ code: "STATE_RESOURCE" });
  });

  test("a change to the resource's bytes is its next version; earlier versions stay verifiable (P4.1, P4.4, P8.3)", async () => {
    const { alice, at, genesis, asAlice } = await harbor();
    const cropped = await updateOriginal(genesis, { versionTime: at(), resource: photo(B2), ...asAlice });
    // Another media type is still the same resource, at its next version.
    const asNote = await updateOriginal(cropped, { versionTime: at(), resource: photo(N1, "text/plain"), ...asAlice });
    const r = await verify([genesis, cropped, asNote], [alice]);
    expect(r.history.status, JSON.stringify(r.history.failure)).toBe("valid");
    expect(r.state?.resource).toEqual(photo(N1, "text/plain"));
    expect(r.resources.versions.map((v) => [v.version, v.versionId, v.mediaType, v.bytes])).toEqual([
      [1, genesis.versionId, "image/jpeg", "verified"],
      [2, cropped.versionId, "image/jpeg", "verified"],
      [3, asNote.versionId, "text/plain", "verified"],
    ]);
    // The derived document's #files service is the current descriptor (P14.9).
    expect((r.document?.service as Array<{ serviceEndpoint: JsonObject }>)[0].serviceEndpoint).toEqual(photo(N1, "text/plain"));
    // Earlier versions' bytes are still checked: a wrong one is a digest failure.
    const wrong = await verifyOriginal({ log: [genesis, cropped, asNote], authors: [alice.evidence()], now: NOW, bytes: { ...allBytes, [photo(B2).digest]: bytes("not the crop") } });
    expect(wrong.resources.status).toBe("digest-failure");
    expect(wrong.resources.failures.map((v) => v.version)).toEqual([2]);
  });
});

describe("P14.6: mediaType and size change only with the digest", () => {
  test("a descriptor that changes either while keeping the digest is rejected", async () => {
    const { alice, genesis, asAlice } = await harbor();
    for (const resource of [{ ...photo(B1), mediaType: "image/png" }, { ...photo(B1), size: photo(B1).size + 1 }]) {
      const forged = await forge(genesis, { ...genesis.state, operation: "update", asset: { ...assetOf(genesis), resource }, transitions: [] }, asAlice.sign);
      failedWith(await verify([genesis, forged], [alice]), 1, "STATE_RESOURCE", "invalid-evidence");
    }
    // A descriptor with a member besides mediaType, size and digest is rejected.
    const withId = await forge(genesis, { ...genesis.state, operation: "update", asset: { ...assetOf(genesis), resource: { id: "photo", ...photo(B1) } }, transitions: [] }, asAlice.sign);
    failedWith(await verify([genesis, withId], [alice]), 1, "STATE_RESOURCE", "invalid-evidence");
  });
});

describe("C12-159: transitions in the genesis entry / an entry changing the resource / any other entry", () => {
  test("are [{from: null, to}] / [{from, to}] / [] (P14.4)", async () => {
    const { alice, at, genesis, asAlice } = await harbor();
    expect(genesis.state.transitions).toEqual([{ from: null, to: photo(B1).digest }]);
    const cropped = await updateOriginal(genesis, { versionTime: at(), resource: photo(B2), ...asAlice });
    expect(cropped.state.transitions).toEqual([{ from: photo(B1).digest, to: photo(B2).digest }]);
    const renamed = await updateOriginal(cropped, { versionTime: at(), name: "Harbor", metadata: { caption: "Dawn" }, ...asAlice });
    expect(renamed.state.transitions).toEqual([]);
    const deactivated = await deactivateOriginal(renamed, { versionTime: at(), ...asAlice });
    expect(deactivated.state.transitions).toEqual([]);
    expect((await verify([genesis, cropped, renamed, deactivated], [alice])).history.status).toBe("valid");
  });

  test("any other form is rejected (P14.4)", async () => {
    const { alice, at, genesis, asAlice } = await harbor();
    const cropped = await updateOriginal(genesis, { versionTime: at(), resource: photo(B2), ...asAlice });
    const change = { from: photo(B1).digest, to: photo(B2).digest };
    for (const transitions of [
      [],
      [change, change],
      [{ from: null, to: photo(B2).digest }],
      [{ from: photo(B1).digest, to: photo(N1).digest }],
      [{ ...change, resource: "photo" }],
      [{ from: photo(B1).digest, to: null }],
    ] as JsonObject[][]) {
      const forged = await forge(genesis, { ...cropped.state, transitions }, asAlice.sign);
      const r = await verify([genesis, forged], [alice]);
      expect(r.history.failure?.index).toBe(1);
      expect(["STATE_TRANSITIONS", "STATE_MEMBERS", "STATE_DIGEST"]).toContain(r.history.failure?.code);
    }
    // An entry that does not change the digest lists none.
    const listed = await forge(cropped, { ...cropped.state, transitions: [change] }, asAlice.sign);
    failedWith(await verify([genesis, cropped, listed], [alice]), 2, "STATE_TRANSITIONS", "invalid-evidence");
    // Genesis lists its first version with from: null, and nothing else.
    for (const transitions of [[], [{ from: photo(B1).digest, to: photo(B1).digest }]] as JsonObject[][]) {
      const forged = await forgeGenesis(genesis, assetOf(genesis), transitions, asAlice.sign);
      failedWith(await verify([forged], [alice]), 0, "STATE_TRANSITIONS", "invalid-evidence");
    }
  });
});
