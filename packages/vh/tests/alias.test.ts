/**
 * The did:webvh alias of a published Original (plan 011, PR 7b): listed in
 * the asset state, pointing back through alsoKnownAs (PROVISIONAL, plan S4),
 * and confirmed only in both directions (P3.6). The alias never supplies state.
 */
import { describe, expect, test } from "bun:test";
import type { JsonObject } from "../src/json/index.js";
import { appendEntry, createLog, serializeLog, signWith, type LogEntry } from "../src/log/index.js";
import {
  checkEntryState,
  createOriginal,
  resourceDigest,
  updateOriginal,
  verifyOriginal,
  verifyOriginalByAlias,
  type AliasEvidence,
  type OriginalsReport,
} from "../src/originals/index.js";
import { OriginalsError } from "../src/errors.js";
import { NOW, VhAuthor, bytes, clock, photo, seeded } from "./helpers/originals.js";

const B1 = "harbor at dawn, first crop";
const allBytes = { [resourceDigest(bytes(B1))]: bytes(B1) };
const KEY = seeded(21);
const ALIAS_KEY = seeded(61);

/** A did:webvh alias log, controlled by its own update key, pointing at `targets`. */
async function aliasLog(targets: string[], domain = "example.com"): Promise<{ did: string; entries: LogEntry[] }> {
  const k = ALIAS_KEY.publicKeyMultibase;
  const sign = signWith(ALIAS_KEY, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${k}#${k}` });
  const genesis = await createLog({
    versionTime: "2026-10-18T10:00:00Z",
    parameters: { method: "did:webvh:1.0", scid: "{SCID}", updateKeys: [k], portable: true },
    state: { id: `did:webvh:{SCID}:${domain}`, alsoKnownAs: targets },
    sign,
  });
  return { did: genesis.state.id as string, entries: [genesis] };
}

async function published() {
  const alice = await VhAuthor.create([{ fragment: "orig", signer: KEY }]);
  const at = clock();
  const sign = alice.signer(KEY, "orig");
  const ref = alice.ref("orig");
  const genesis = await createOriginal({ versionTime: at(), name: "Harbor at dawn", resources: [photo(B1)], author: ref, sign });
  const alias = await aliasLog([genesis.state.id as string]);
  // Publication: one update that lists the alias (no witnesses, owner decision Q14).
  const publish = await updateOriginal(genesis, { versionTime: at(), aliases: [alias.did], author: ref, sign });
  return { alice, at, sign, ref, genesis, publish, alias, log: [genesis, publish] };
}

const evidence = (a: { did: string; entries: LogEntry[] }): AliasEvidence => ({ did: a.did, log: serializeLog(a.entries) });

const verify = (log: LogEntry[], alice: VhAuthor, extra: Partial<Parameters<typeof verifyOriginal>[0]> = {}): Promise<OriginalsReport> =>
  verifyOriginal({ log, authors: [alice.evidence()], now: NOW, bytes: allBytes, freshness: "asserted", ...extra });

describe("publishing a did:webvh alias (P3.6, P9.8)", () => {
  test("an alias listed in the state and pointing back is confirmed; the Original stays current", async () => {
    const { alice, log, alias, genesis } = await published();
    const r = await verify(log, alice, { aliases: [evidence(alias)] });
    expect(r.state?.aliases).toEqual([alias.did]);
    expect(r.document?.alsoKnownAs).toEqual([alias.did]);
    expect(r.aliases).toEqual([{ did: alias.did, status: "confirmed" }]);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    // Resolving through the alias reaches the same verified Original.
    const via = await verifyOriginalByAlias({ alias: evidence(alias), log, authors: [alice.evidence()], now: NOW, bytes: allBytes, freshness: "asserted" });
    expect(via.original).toBe(genesis.state.id);
  });

  test("C12-67: a listed did:webvh whose document points elsewhere is not confirmed; the did:vh still verifies directly", async () => {
    const { alice, log } = await published();
    const elsewhere = await aliasLog(["did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ"]);
    const listed = (log[1].state as unknown as { asset: { aliases: string[] } }).asset.aliases[0];
    const r = await verify(log, alice, { aliases: [{ did: listed, log: serializeLog(elsewhere.entries) }] });
    expect(r.aliases[0]).toMatchObject({ did: listed, status: "not-confirmed" });
    expect(r.current).toBe(true);
  });

  test("C12-66: a did:webvh pointing to a did:vh that does not list it gives no Originals result", async () => {
    const { alice, at, sign, ref } = await published();
    const other = await createOriginal({ versionTime: at(), name: "Not published", resources: [photo(B1)], author: ref, sign });
    const claims = await aliasLog([other.state.id as string], "claims.example");
    let caught: unknown;
    try {
      await verifyOriginalByAlias({ alias: evidence(claims), log: [other], authors: [alice.evidence()], now: NOW, bytes: allBytes, freshness: "asserted" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OriginalsError);
    expect((caught as OriginalsError).code).toBe("ALIAS_NOT_CONFIRMED");
  });

  test("an alias that is missing, invalid or deactivated is reported as such", async () => {
    const { alice, log, alias } = await published();
    const missing = await verify(log, alice);
    expect(missing.aliases).toEqual([{ did: alias.did, status: "unavailable" }]);
    const broken = { ...alias.entries[0], proof: [{ ...alias.entries[0].proof[0], proofValue: "z1111" }] };
    expect((await verify(log, alice, { aliases: [{ did: alias.did, log: serializeLog([broken as LogEntry]) }] })).aliases[0].status).toBe("invalid");
    const k = ALIAS_KEY.publicKeyMultibase;
    const off = await appendEntry(alias.entries[0], { versionTime: "2026-10-18T10:00:01Z", parameters: { deactivated: true }, state: alias.entries[0].state, sign: signWith(ALIAS_KEY, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${k}#${k}` }) });
    expect((await verify(log, alice, { aliases: [{ did: alias.did, log: serializeLog([alias.entries[0], off]) }] })).aliases[0]).toMatchObject({ status: "not-confirmed", reason: "alias-deactivated" });
  });
});

describe("alias rules in the asset log (PROVISIONAL, plan 011 PR 7b)", () => {
  test("an Original starts local: genesis lists no alias", async () => {
    const { genesis, alias } = await published();
    const state = structuredClone(genesis.state) as unknown as { asset: { aliases: string[] } };
    state.asset.aliases = [alias.did];
    const scid = (genesis.state.id as string).slice("did:vh:".length);
    expect(() => checkEntryState(state as unknown as JsonObject, { scid, index: 0, deactivatedParameter: false })).toThrow(/genesis lists no alias/);
  });

  test("layers move one way: the alias cannot be removed, and only moves within its own did:webvh SCID (P9.3)", async () => {
    const { alice, at, sign, ref, publish, alias, log } = await published();
    const other = await aliasLog([log[0].state.id as string], "other.example");
    for (const aliases of [[], [other.did]]) {
      await expect(updateOriginal(publish, { versionTime: at(), aliases, author: ref, sign })).rejects.toMatchObject({ code: "STATE_ALIASES" });
    }
    const moved = alias.did.replace(":example.com", ":moved.example");
    const relocated = await updateOriginal(publish, { versionTime: at(), aliases: [moved], author: ref, sign });
    const r = await verify([...log, relocated], alice);
    expect(r.history.status, JSON.stringify(r.history.failure)).toBe("valid");
  });

  test("aliases other than one did:webvh are refused; did:btco arrives with anchoring", async () => {
    const { alice, at, sign, ref, publish, alias, log } = await published();
    for (const aliases of [[alias.did, alias.did], ["did:web:example.com"], [alias.did, "did:btco:1234"]]) {
      const bad = await updateOriginal(publish, { versionTime: at(), aliases, author: ref, sign }).catch((e: unknown) => e);
      if (bad instanceof OriginalsError) {
        expect(bad.code).toMatch(/^STATE_ALIASES/);
        continue;
      }
      const r = await verify([...log, bad as LogEntry], alice);
      expect(r.history.failure?.code).toMatch(/^STATE_ALIASES/);
    }
  });
});
