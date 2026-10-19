/**
 * Runs the shared vh interop vectors (brianorwhatever/vh@f5176785, profile
 * vh-log-interop-0) through the same handler the interop driver uses. The
 * comparisons are ported from that repository's harness/run.ts, so a pass
 * here means the same thing as a green cell in its interop matrix.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { canonicalize, parseJson } from "../src/json/index.js";
import { handle } from "../interop/handler.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const root = new URL("./fixtures/vh-interop/", import.meta.url);
const load = (path: string): Json => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const same = (a: unknown, b: unknown) => {
  try {
    return canonicalize(parseJson(JSON.stringify(a), { duplicateKeys: "last", lossyNumbers: true })) ===
      canonicalize(parseJson(JSON.stringify(b), { duplicateKeys: "last", lossyNumbers: true }));
  } catch {
    return false;
  }
};
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 300);

async function call(op: string, input: Json): Promise<Json> {
  const res = await handle(op, input);
  if (!res.ok) throw new Error(`driver error for ${op}: ${res.error}`);
  return res.result;
}

/** harness/run.ts compareResolution. */
function compareResolution(expectation: Json, got: Json): string[] {
  const problems: string[] = [];
  if (got?.valid !== expectation.valid) problems.push(`valid: expected ${expectation.valid}, got ${got?.valid}`);
  const err = got?.error ?? null;
  if (expectation.error) {
    const codes = expectation.error.oneOf ?? [expectation.error.code];
    if (!err || !codes.includes(err.code)) problems.push(`error.code: expected ${codes.join("|")}, got ${err?.code ?? "none"} (${err?.message ?? ""})`);
    if ("version" in expectation.error && err && err.version !== expectation.error.version) {
      problems.push(`error.version: expected ${expectation.error.version}, got ${err.version}`);
    }
  } else if (err && !expectation.valid) {
    problems.push(`unexpected error ${err.code}: ${err.message}`);
  }
  if (expectation.valid && got?.valid) {
    if (!same(expectation.state, got.state)) problems.push(`state: expected ${show(expectation.state)}, got ${show(got.state)}`);
    if ((got.firstInvalidVersion ?? null) !== (expectation.firstInvalidVersion ?? null)) {
      problems.push(`firstInvalidVersion: expected ${expectation.firstInvalidVersion}, got ${got.firstInvalidVersion}`);
    }
    const warnings = (got.metadata?.warnings ?? []).map((w: Json) => w.code).sort();
    if (!same(warnings, expectation.warnings ?? [])) problems.push(`warnings: expected ${show(expectation.warnings)}, got ${show(warnings)}`);
    for (const [k, v] of Object.entries(expectation.metadata ?? {})) {
      if (!same(v, got.metadata?.[k])) problems.push(`metadata.${k}: expected ${show(v)}, got ${show(got.metadata?.[k])}`);
    }
  }
  return problems;
}

describe("vh interop: primitives", () => {
  const v = load("primitives.json");
  const check = async (op: string, input: Json, pick: (r: Json) => unknown, want: unknown) => {
    const got = pick(await call(op, input));
    return same(got, want) ? null : `${op}: expected ${show(want)}, got ${show(got)}`;
  };
  test("jcs, hash, multikey, key-hash, scid, entry-hash, sign and verify", async () => {
    const problems: Array<string | null> = [];
    for (const c of v.jcs) problems.push(await check("jcs", { text: c.text }, (r) => r.output, c.output));
    for (const c of v.hash) problems.push(await check("hash", { data: c.data }, (r) => r.output, c.output));
    for (const c of v.multikey) problems.push(await check("multikey", { seed: c.seed }, (r) => r.multikey, c.multikey));
    for (const c of v.keyHash) problems.push(await check("key-hash", { multikey: c.multikey }, (r) => r.output, c.output));
    for (const c of v.scid) problems.push(await check("scid", { entry: c.entry }, (r) => r.scid, c.scid));
    for (const c of v.entryHash) problems.push(await check("entry-hash", { entry: c.entry, previousVersionId: c.previousVersionId }, (r) => r.hash, c.hash));
    for (const c of v.sign) {
      problems.push(await check("sign", { document: c.document, seed: c.seed, ...(c.created ? { created: c.created } : {}) }, (r) => r.proof, c.proof));
      problems.push(await check("verify", { document: c.document, proof: c.proof }, (r) => r.valid, true));
      problems.push(await check("verify", { document: { ...c.document, extra: 1 }, proof: c.proof }, (r) => r.valid, false));
    }
    expect(problems.filter(Boolean)).toEqual([]);
  });
});

describe("vh interop: resolution", () => {
  for (const file of readdirSync(new URL("resolution/", root)).filter((f) => f.endsWith(".json")).sort()) {
    const { cases } = load(`resolution/${file}`);
    for (const c of cases) {
      test(`${file.replace(".json", "")}/${c.name}`, async () => {
        expect(compareResolution(c.expect, await call("resolve", c.input))).toEqual([]);
      });
    }
  }
});

describe("vh interop: generation and cross-resolution", () => {
  const { scenarios } = load("generation.json");
  for (const sc of scenarios) {
    test(sc.name, async () => {
      const problems: string[] = [];
      let log = "";
      let scid = "";
      const versionIds: string[] = [];
      for (const [i, step] of sc.steps.entries()) {
        const input = step.op === "create" ? step.input : { ...JSON.parse(JSON.stringify(step.input).replaceAll("{SCID}", scid)), log };
        const res = await call(step.op, input);
        log = res.log;
        if (step.op === "create") scid = res.scid;
        versionIds.push(res.versionId);
        const line = JSON.parse(log.trimEnd().split("\n").at(-1)!);
        if (res.versionId !== step.expect.versionId) problems.push(`step ${i + 1} versionId: expected ${step.expect.versionId}, got ${res.versionId}`);
        if (step.expect.scid && res.scid !== step.expect.scid) problems.push(`step ${i + 1} scid`);
        if (!same(line, step.expect.line)) problems.push(`step ${i + 1} line: expected ${show(step.expect.line)}, got ${show(line)}`);
      }
      let witnessFile: Json[] | undefined;
      if (sc.witness) {
        witnessFile = [];
        for (const w of sc.witness) {
          const versionId = versionIds[w.step - 1];
          const proof = [];
          for (const seed of w.seeds) proof.push((await call("witness", { versionId, seed })).proof);
          witnessFile.push({ versionId, proof });
        }
        if (!same(witnessFile, sc.witnessFile)) problems.push(`witness file: expected ${show(sc.witnessFile)}, got ${show(witnessFile)}`);
      }
      // Cross-resolution, as harness/run.ts does with each generated log.
      const r = await call("resolve", { log, witness: witnessFile, now: sc.resolve.now });
      if (!r.valid || r.error) problems.push(`own log did not verify: ${show(r.error)}`);
      else if (!same(r.state, sc.resolve.state) || r.metadata.versionId !== sc.resolve.versionId) problems.push("own log resolved differently");
      // And the reference implementation's own log.
      const ref = await call("resolve", { log: sc.log, witness: sc.witnessFile, now: sc.resolve.now });
      if (!ref.valid || ref.error || ref.metadata.versionId !== sc.resolve.versionId) problems.push(`reference log: ${show(ref.error)}`);
      expect(problems).toEqual([]);
    });
  }
});

describe("vh interop: external didwebvh-ts logs", () => {
  for (const source of readdirSync(new URL("external/", root))) {
    const { scenarios } = load(`external/${source}/manifest.json`);
    for (const sc of scenarios) {
      test(`${source}/${sc.name}`, async () => {
        const entries = readFileSync(new URL(`external/${source}/${sc.name}.jsonl`, root), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Json);
        const scid = entries[0].parameters.scid as string;
        const problems: string[] = [];
        for (const [i, entry] of entries.entries()) {
          const { proof, ...doc } = entry;
          if (i === 0) {
            const preliminary = JSON.parse(JSON.stringify({ ...doc, versionId: "{SCID}" }).replaceAll(scid, "{SCID}"));
            if ((await call("scid", { entry: preliminary })).scid !== scid) problems.push("scid");
          }
          const hash = entry.versionId.split("-")[1];
          const previous = i === 0 ? scid : entries[i - 1].versionId;
          if ((await call("entry-hash", { entry: doc, previousVersionId: previous })).hash !== hash) problems.push(`#${i + 1} entry hash`);
          for (const p of proof) {
            if ((await call("verify", { document: doc, proof: p })).valid !== true) problems.push(`#${i + 1} proof`);
            if ((await call("verify", { document: { ...doc, versionTime: "1999-01-01T00:00:00Z" }, proof: p })).valid !== false) problems.push(`#${i + 1} tamper`);
          }
          const committed: string[] = i > 0 ? (entries[i - 1].parameters.nextKeyHashes ?? []) : [];
          for (const k of committed.length ? entry.parameters.updateKeys : []) {
            if (!committed.includes((await call("key-hash", { multikey: k })).output)) problems.push(`#${i + 1} key hash`);
          }
        }
        if (sc.witness) {
          for (const record of load(`external/${source}/${sc.name}.witness.json`)) {
            for (const p of record.proof) {
              if ((await call("verify", { document: { versionId: record.versionId }, proof: p })).valid !== true) problems.push("witness proof");
            }
          }
        }
        expect(problems).toEqual([]);
      });
    }
  }
});

describe("vh interop: independent Ed25519 boundaries", () => {
  test("proof and resolver boundary cases (tools/ed25519-fixtures.py)", async () => {
    const cases = load("ed25519/boundaries.json");
    const failures: string[] = [];
    for (const v of cases) {
      const r = await call(v.op, v.input);
      if (r.valid !== v.expected.valid ||
        ("error" in v.expected && (r.error?.code ?? null) !== v.expected.error) ||
        (v.expected.firstInvalidVersion && r.firstInvalidVersion !== v.expected.firstInvalidVersion)) {
        failures.push(`${v.op} ${v.name}: expected ${JSON.stringify(v.expected)}, got ${show(r)}`);
      }
    }
    expect(cases.length).toBe(89);
    expect(failures).toEqual([]);
  });
});
