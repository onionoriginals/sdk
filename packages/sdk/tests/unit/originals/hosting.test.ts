/**
 * Publication and the public reader (plan 011, PR 7b): publishing lists a
 * did:webvh alias (P3.6; no witnesses, owner decision Q14); the hosted snapshot
 * is verified exactly, never mixed (P9.1); resources are served isolated (P9.7).
 */
import { describe, expect, test } from "bun:test";
import { OriginalsError } from "@originals/vh";
import { localSigner } from "@originals/vh/crypto";
import { createLog, serializeLog, signWith } from "@originals/vh/log";
import { resourceDigest, type AliasEvidence } from "@originals/vh/originals";
import { didWebvhFilesUrl } from "@originals/vh/webvh";
import { MemoryStore, OriginalsSDK, hostedFiles, servingHeaders, type HostedFetch } from "../../../src/originals/index.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const KEY = seed(21);
const B1 = bytes("first crop");
const B2 = bytes("tighter crop");

async function aliasFor(target: string, domain = "example.com"): Promise<AliasEvidence> {
  const key = localSigner("Ed25519", seed(61));
  const k = key.publicKeyMultibase;
  const genesis = await createLog({
    versionTime: "2026-10-18T10:00:00Z",
    parameters: { method: "did:webvh:1.0", scid: "{SCID}", updateKeys: [k], portable: true },
    state: { id: `did:webvh:{SCID}:${domain}:photos`, alsoKnownAs: [target] },
    sign: signWith(key, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${k}#${k}` }),
  });
  return { did: genesis.state.id as string, log: serializeLog([genesis]) };
}

async function published() {
  const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
  const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => alice.evidence(), freshness: "asserted", clock: clock() });
  const signer = alice.signer("orig", KEY);
  const c = await sdk.create({ name: "Harbor at dawn", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: B1 }], author: alice.ref("orig"), signer });
  if (c.kind !== "original") throw new Error("expected an Original");
  const did = c.original.did;
  const alias = await aliasFor(did);
  const p = await sdk.publish(did, { parent: c.original.checkpoint, author: alice.ref("orig"), signer, alias });
  const e = await sdk.edit(did, { parent: p.original.checkpoint, resources: [{ id: "photo", bytes: B2 }], author: alice.ref("orig"), signer });
  const files = await hostedFiles(sdk, did, alias);
  return { alice, sdk, signer, did, alias, files, published: p.original, head: e.original.checkpoint };
}

/** A host: the hosted files under the alias's #files base. */
function host(files: Map<string, Uint8Array>, base: string): HostedFetch {
  return (url) => {
    const path = url.startsWith(base) ? url.slice(base.length) : undefined;
    const data = path === undefined ? undefined : files.get(path);
    if (!data) return Promise.reject(new OriginalsError("unavailable-bytes", "FETCH_STATUS", `${url} answered 404`));
    return Promise.resolve(data.slice());
  };
}

const stranger = () => OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")) });

describe("publishing (P3.6, P9.8)", () => {
  test("publication is one entry that lists the confirmed alias", async () => {
    const { published: p, alias } = await published();
    expect(p.state.aliases).toEqual([alias.did]);
    expect(p.report.aliases).toEqual([{ did: alias.did, status: "confirmed" }]);
    expect(p.report.ordering).toBe("claimed");
  });

  test("an alias that does not point back to the Original cannot be published", async () => {
    const { sdk, alice, signer } = await published();
    const c = await sdk.create({ name: "Other", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: B1 }], author: alice.ref("orig"), signer });
    if (c.kind !== "original") throw new Error("expected an Original");
    const wrong = await aliasFor("did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ");
    await expect(sdk.publish(c.original.did, { parent: c.original.checkpoint, author: alice.ref("orig"), signer, alias: wrong })).rejects.toMatchObject({ code: "ALIAS_NOT_CONFIRMED" });
  });
});

describe("the public reader verifies one exact snapshot (P9.1)", () => {
  test("a stranger reads the published Original through its did:webvh, with no key", async () => {
    const { did, alias, files, head } = await published();
    const r = await stranger().loadPublished(alias.did, host(files, didWebvhFilesUrl(alias.did)));
    expect(r.verified, JSON.stringify(r.reasons)).toBe(true);
    expect(r.report.original).toBe(did);
    expect(r.report.checkpoint).toBe(head);
    expect(r.alias.status).toBe("confirmed");
    expect(r.report.ordering).toBe("claimed"); // no witnesses (owner decision Q14)
    expect(r.report.resources.versions.map((v) => v.bytes)).toEqual(["verified", "verified"]);
  });

  test("C12-26: bytes from another version under a resource's digest are rejected before the result is verified", async () => {
    const { alias, files } = await published();
    const mixed = new Map(files);
    mixed.set(`originals/resources/${resourceDigest(B2)}`, B1);
    const r = await stranger().loadPublished(alias.did, host(mixed, didWebvhFilesUrl(alias.did)));
    expect(r.verified).toBe(false);
    expect(r.report.resources.status).toBe("digest-failure");
  });

  test("C12-26: a snapshot whose served history runs past its checkpoint is not verified", async () => {
    const { alias, files, published: p } = await published();
    const mixed = new Map(files);
    const manifest = JSON.parse(new TextDecoder().decode(files.get("originals/originals-evidence.json"))) as Record<string, unknown>;
    // The manifest claims the publication checkpoint, while the log and bytes are those of the later head.
    mixed.set("originals/originals-evidence.json", bytes(JSON.stringify({ ...manifest, checkpoint: p.checkpoint })));
    const r = await stranger().loadPublished(alias.did, host(mixed, didWebvhFilesUrl(alias.did)));
    expect(r.verified).toBe(false);
  });

  test("a snapshot of a different Original than the alias names gives no result", async () => {
    const { alias, files } = await published();
    const mixed = new Map(files);
    const manifest = JSON.parse(new TextDecoder().decode(files.get("originals/originals-evidence.json"))) as Record<string, unknown>;
    mixed.set("originals/originals-evidence.json", bytes(JSON.stringify({ ...manifest, original: "did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ" })));
    await expect(stranger().loadPublished(alias.did, host(mixed, didWebvhFilesUrl(alias.did)))).rejects.toMatchObject({ code: "ALIAS_NOT_CONFIRMED" });
  });

  test("missing bytes leave an explicitly partial, unverified result (P7.4)", async () => {
    const { alias, files } = await published();
    const partial = new Map(files);
    partial.delete(`originals/resources/${resourceDigest(B1)}`);
    const r = await stranger().loadPublished(alias.did, host(partial, didWebvhFilesUrl(alias.did)));
    expect(r.verified).toBe(false);
    expect(r.report.resources.status).toBe("partial");
  });

  test("the hosted files are the same for a retried publication of the same checkpoint (P9.2)", async () => {
    const { sdk, did, alias, files } = await published();
    const again = await hostedFiles(sdk, did, alias);
    expect([...again.keys()].sort()).toEqual([...files.keys()].sort());
    for (const [path, data] of files) expect(again.get(path)).toEqual(data);
  });
});

describe("serving resources (P9.7)", () => {
  test("C12-84: active content is served with its signed type, no sniffing and a sandboxing policy", () => {
    for (const type of ["image/svg+xml", "text/html", "application/xhtml+xml"]) {
      const h = servingHeaders(type);
      expect(h["Content-Type"]).toBe(type);
      expect(h["X-Content-Type-Options"]).toBe("nosniff");
      expect(h["Content-Security-Policy"]).toContain("sandbox");
      expect(h["Content-Security-Policy"]).toContain("script-src 'none'");
    }
    expect(servingHeaders("image/jpeg")["X-Content-Type-Options"]).toBe("nosniff");
  });
});
