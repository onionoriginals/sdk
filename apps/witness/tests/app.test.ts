import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localSigner } from "@originals/vh/crypto";
import { createLog, serializeLog, signWith } from "@originals/vh/log";
import { createOriginal, resourceDigest, updateOriginal } from "@originals/vh/originals";
import { FileWitnessLedger } from "@originals/sdk/originals/fs";
import { MemoryStore, MemoryWitnessLedger, OriginalsSDK, httpWitnessClient, keySigner } from "@originals/sdk/originals";
import { createWitnessApp } from "../src/app.js";
import { parseWitnessConfig } from "../src/config.js";

const secret = (n: number) => new Uint8Array(32).fill(n);
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("configuration", () => {
  test("reads the secret key, data dir, path and port", () => {
    const c = parseWitnessConfig({ WITNESS_SECRET_KEY: hex(secret(31)), WITNESS_DATA_DIR: "/data", PORT: "9000" });
    expect(c).toEqual({ secretKey: secret(31), dataDir: "/data", path: "/witness", port: 9000 });
  });

  test("names every problem and never echoes the secret", () => {
    let message = "";
    try {
      parseWitnessConfig({ WITNESS_SECRET_KEY: "abc123", PORT: "x", WITNESS_PATH: "/health" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("WITNESS_SECRET_KEY");
    expect(message).toContain("WITNESS_DATA_DIR");
    expect(message).toContain("PORT");
    expect(message).toContain("WITNESS_PATH");
    expect(message).not.toContain("abc123");
  });
});

/** A did:vh author declaring three witnesses, built from the published primitives. */
async function author(witnessIds: string[]) {
  const update = localSigner("Ed25519", secret(90));
  const k = update.publicKeyMultibase;
  const orig = localSigner("Ed25519", secret(21)).publicKeyMultibase;
  const genesis = await createLog({
    versionTime: "2026-10-18T08:00:00Z",
    parameters: { method: "did:vh:1.0", scid: "{SCID}", updateKeys: [k] },
    state: {
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: "did:vh:{SCID}",
      verificationMethod: [{ id: "did:vh:{SCID}#orig", type: "Multikey", controller: "did:vh:{SCID}", publicKeyMultibase: orig }],
      assertionMethod: ["did:vh:{SCID}#orig"],
      service: [{ id: "did:vh:{SCID}#originals-witnesses", type: "OriginalsWitnesses", serviceEndpoint: { threshold: 2, witnesses: witnessIds.map((id) => ({ id })) } }],
    },
    sign: signWith(update, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${k}#${k}` }),
  });
  const did = genesis.state.id as string;
  return { did, evidence: { did, log: serializeLog([genesis]) }, ref: { did, verificationMethod: `${did}#orig`, versionId: genesis.versionId } };
}

describe("the service over real HTTP", () => {
  test("three running witnesses approve a witnessed commit; /health names each", async () => {
    let time = Date.parse("2026-10-18T12:00:00Z");
    const ids = [31, 32, 33].map((n) => `did:key:${localSigner("Ed25519", secret(n)).publicKeyMultibase}`);
    const a = await author(ids);
    const servers = await Promise.all([31, 32, 33].map(async (n) => {
      const dir = mkdtempSync(join(tmpdir(), "witness-"));
      dirs.push(dir);
      const app = createWitnessApp({
        secretKey: secret(n), path: "/witness", ledger: await FileWitnessLedger.open(dir),
        authors: async (did) => (did === a.did ? { evidence: a.evidence, retrievedAt: time } : undefined), clock: () => time,
      });
      return { app, server: Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch }) };
    }));
    try {
      const health = (await (await fetch(`http://127.0.0.1:${servers[0].server.port}/health`)).json()) as { id: string };
      expect(health.id).toBe(ids[0]);
      const sdk = OriginalsSDK.create({
        store: new MemoryStore(), authors: [a.evidence], freshness: "asserted", clock: () => (time += 250),
        witnesses: servers.map(({ app, server }) => httpWitnessClient({ id: app.id, endpoint: `http://127.0.0.1:${server.port}/witness` })),
      });
      const signer = keySigner({ keyType: "Ed25519", secretKey: secret(21), verificationMethod: a.ref.verificationMethod });
      const c = await sdk.create({ name: "Harbor", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: new TextEncoder().encode("x") }], author: a.ref, signer });
      if (c.kind !== "original") throw new Error("expected an Original");
      const r = await sdk.activateWitnesses(c.original.did, { parent: c.original.checkpoint, author: a.ref, signer });
      expect(r.original.report.ordering).toBe("witnessed");
      expect(r.original.current).toBe(true);
      const unknown = await fetch(`http://127.0.0.1:${servers[0].server.port}/elsewhere`);
      expect(unknown.status).toBe(404);
    } finally {
      for (const { server } of servers) server.stop(true);
    }
  });

  test("an author DID the witness cannot read is refused over HTTP (P9.8)", async () => {
    const app = createWitnessApp({ secretKey: secret(31), path: "/witness", ledger: new MemoryWitnessLedger(), authors: async () => undefined });
    const others = [32, 33].map((n) => `did:key:${localSigner("Ed25519", secret(n)).publicKeyMultibase}`);
    const a = await author([app.id, ...others]);
    const sign = signWith(localSigner("Ed25519", secret(21)), { cryptosuite: "eddsa-jcs-2022", verificationMethod: a.ref.verificationMethod });
    const resources = [{ id: "photo", mediaType: "image/jpeg", size: 1, digest: resourceDigest(new TextEncoder().encode("x")) }];
    const g = await createOriginal({ versionTime: "2026-10-18T12:00:00.000Z", name: "Harbor", resources, author: a.ref, sign });
    const declaration = { threshold: 2, witnesses: [app.id, ...others].map((id) => ({ id })) };
    const activation = await updateOriginal(g, { versionTime: "2026-10-18T12:00:01.000Z", witness: declaration, author: a.ref, sign });
    const response = await app.fetch(new Request("http://w/witness", { method: "POST", body: JSON.stringify({ original: g.state.id, log: serializeLog([g, activation]), witness: [] }) }));
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("AUTHOR_STATE_UNAVAILABLE");
  });
});
