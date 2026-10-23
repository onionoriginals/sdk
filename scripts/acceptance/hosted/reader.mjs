/**
 * The signed-out reader (Node, fresh process): no key, no store, no cookie, no
 * author directory. For each case it retrieves the published Original through
 * its alias's public URLs and checks, separately (section 7; #976 B2, B4):
 * - `verified`, and the exact checkpoint the author published;
 * - the alias in both directions (P3.6);
 * - every resource byte against the author's claimed digest; missing bytes
 *   don't fail `verified` (P7.3), so availability is its own check;
 * - `current` (never true unanchored, P7.10), freshness and ordering.
 *
 * Input (ACCEPTANCE_INPUT): { phaseName, target, port?, cases: [{ name, alias, expect, checkpoint, resources }] }.
 * `expect: "complete"` must verify completely; `"incomplete"` must not.
 * With target "local", https://<host>/<path> is read from the loopback host
 * under that Host header (node:http, since fetch won't send one); otherwise
 * from the network with safeFetch, which follows no redirect.
 */
import { request } from "node:http";
import { OriginalsSDK, MemoryStore } from "@originals/sdk/originals";
import { safeFetch } from "@originals/vh/fetch";
import { base58btcDecode } from "@originals/vh/crypto";
import { OriginalsError } from "@originals/vh";
import { assert, assertEqual, Phase } from "../lib/phase.mjs";

const input = JSON.parse(process.env.ACCEPTANCE_INPUT ?? "{}");
const phase = new Phase(input.phaseName ?? "reader");
const seen = { cookies: 0, setCookies: 0 };

function loopbackRead(url) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: input.port, path: u.pathname, headers: { host: u.host } }, (res) => {
      if (res.headers["set-cookie"]) seen.setCookies++;
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => (res.statusCode === 200 ? resolve(new Uint8Array(Buffer.concat(chunks))) : reject(new OriginalsError("unavailable-bytes", "FETCH_STATUS", `${url} answered ${res.statusCode}`))));
    });
    if (req.getHeader("cookie")) seen.cookies++;
    req.on("error", reject);
    req.end();
  });
}

/** A resource digest (base58btc sha2-256 multihash) as the hex the author claimed. */
const hexOf = (digest) => Buffer.from(base58btcDecode(digest.slice(1)).slice(2)).toString("hex");

const read = input.target === "local" ? (url) => loopbackRead(url) : async (url, options) => (await safeFetch(url, options)).bytes;

await phase.check("no-authority", "the reader has no key, store, cookie or author directory", async () => {
  const keyVars = Object.keys(process.env).filter((k) => /KEY|SECRET|TOKEN|TURNKEY|SESSION|COOKIE/i.test(k));
  assertEqual(keyVars, [], "key-like environment variables");
  assertEqual(Object.keys(input.dirs ?? {}), [], "directories given to the reader");
  return { envNames: Object.keys(process.env).sort() };
});

for (const c of input.cases) {
  await phase.check(`${c.name}-${c.expect}`, `${c.name}: a stranger ${c.expect === "complete" ? "verifies the complete snapshot" : "can't verify a complete snapshot"}`, async () => {
    let r = null;
    let error = null;
    try {
      r = await OriginalsSDK.create({ store: new MemoryStore(), authors: [] }).loadPublished(c.alias, read);
    } catch (e) {
      error = `${e?.code ?? e?.name}: ${String(e?.message).slice(0, 200)}`;
    }
    const digests = (r?.report.resources.versions ?? []).map((v) => ({ resource: v.resource, version: v.version, sha256: hexOf(v.digest) }));
    const facts = r && {
      verified: r.verified,
      checkpoint: r.report.validAsOf?.checkpoint ?? null,
      head: r.report.head,
      alias: r.alias.status,
      resources: r.report.resources.status,
      current: r.report.current,
      reasons: r.report.reasons,
      freshness: { asset: r.report.assetFreshness.status, identity: r.report.identityEvidence.freshness, validAsOf: r.report.validAsOf },
      ordering: r.report.ordering,
    };
    const complete = !!facts && facts.verified && facts.checkpoint === c.checkpoint && facts.alias === "confirmed" && facts.resources === "available";
    if (c.expect === "incomplete") {
      assert(!complete, "a stranger verified a complete snapshot of an unfinished publication", facts);
      return { complete, error, facts };
    }
    assert(facts, "the published Original could not be retrieved", error);
    assert(facts.verified, "the snapshot does not verify", facts);
    assertEqual(facts.checkpoint, c.checkpoint, "the checkpoint");
    assertEqual(facts.alias, "confirmed", "the alias in both directions");
    assertEqual(facts.resources, "available", "resource availability");
    assert(facts.current === false && (facts.reasons ?? []).includes("not-anchored"), "an unanchored Original was reported current (P7.10)", facts);
    assertEqual(facts.ordering, "claimed", "ordering");
    // Every resource the author published, at the checkpoint, by its exact bytes (P8.1).
    for (const res of c.resources ?? []) {
      const at = digests.filter((d) => d.resource === res.id).at(-1);
      assertEqual(at?.sha256, res.sha256, `${res.id}: the verified bytes' SHA-256`);
    }
    return { ...facts, digests };
  });
}

await phase.check("no-cookies", "the reader sent no cookie and received none", async () => {
  assertEqual(seen, { cookies: 0, setCookies: 0 }, "cookies");
  return seen;
});

phase.finish();
