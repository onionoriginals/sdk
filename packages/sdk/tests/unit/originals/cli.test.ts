import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore, OriginalsSDK } from "../../../src/originals/index.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const cli = new URL("../../../src/originals/cli.ts", import.meta.url).pathname;
const noNetwork = new URL("./fixtures/no-network.ts", import.meta.url).pathname;

function run(args: string[]) {
  // A fresh process: no store, no key, an empty environment and no network.
  const result = Bun.spawnSync(["bun", "--preload", noNetwork, cli, ...args], { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("C12-01: package in one process, verify in another", () => {
  test("a fresh process with no key and no network reproduces the checkpoint and resource versions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "originals-cli-"));
    try {
      const key = seed(21);
      const alice = await Author.create([{ fragment: "orig", secret: key }]);
      const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: clock() });
      const signer = alice.signer("orig", key);
      const author = alice.ref("orig");
      const c = await sdk.create({ name: "Harbor at dawn", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: bytes("B1") }], author, signer });
      if (c.kind !== "original") throw new Error("expected an Original");
      const e = await sdk.edit(c.original.did, { parent: c.original.checkpoint, resources: [{ id: "photo", bytes: bytes("B2") }], author, signer });
      const file = join(dir, "harbor.zip");
      writeFileSync(file, (await sdk.package(c.original.did)).bytes);

      const out = run(["verify", file, "--json", "--now", "2026-10-19T00:00:00Z"]);
      expect(out.stderr).toBe("");
      expect(out.code).toBe(0);
      const report = JSON.parse(out.stdout) as { checkpoint: string; resources: { versions: Array<{ version: number; digest: string; bytes: string }> }; history: { status: string } };
      expect(report.checkpoint).toBe(e.original.checkpoint);
      expect(report.history.status).toBe("valid");
      expect(report.resources.versions.map((v) => [v.version, v.digest, v.bytes])).toEqual(e.original.resources.map((r) => [r.version, r.digest, "verified"]));

      const text = run(["verify", file, "--now", "2026-10-19T00:00:00Z"]);
      expect(text.stdout).toContain("verified");
      expect(text.stdout).toContain(e.original.checkpoint);
      // C12-145: valid as of its checkpoint, with the author DID version relied on and when the
      // package was read; never current (P7.10). The freshness option is gone (originals-spec #46).
      expect((JSON.parse(out.stdout) as { current: boolean; validAsOf: unknown }).validAsOf).toEqual({
        checkpoint: e.original.checkpoint,
        signers: [{ did: alice.did, role: "author", versionId: alice.versionId, obtainedAt: "2026-10-19T00:00:00.000Z", source: "package", location: null }],
      });
      expect(JSON.parse(out.stdout).current).toBe(false);
      expect(text.stdout).toContain(`valid as of ${e.original.checkpoint}, not current: not anchored (P7.10)`);
      expect(text.stdout).toContain(`author ${alice.did} at ${alice.versionId}, obtained 2026-10-19T00:00:00.000Z from package`);
      // P7.8 (owner decision, 23 Oct 2026): where and when the history was obtained, and that the DID may be newer.
      expect(text.stdout).toContain(`The history of ${alice.did} was obtained from the evidence package at 2026-10-19T00:00:00.000Z; its latest version there is ${alice.versionId}.`);
      expect(text.stdout).toContain("Its freshness is not established. The DID may have a newer version, for example one that removes a key, that this verifier has not seen.");
      expect(run(["verify", file, "--freshness", "asserted"]).code).toBe(2);
      // Missing bytes leave the package verified, with the content reported unavailable (P7.3, P7.4).
      const store = new MemoryStore();
      const partialSdk = OriginalsSDK.create({ store, authors: [alice.evidence()], clock: clock() });
      const p = await partialSdk.create({ name: "Partial", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: bytes("P1") }], author, signer });
      if (p.kind !== "original") throw new Error("expected an Original");
      await partialSdk.edit(p.original.did, { parent: p.original.checkpoint, resources: [{ id: "photo", bytes: bytes("P2") }], author, signer });
      store.deleteResource(p.original.resources[0].digest);
      const partial = join(dir, "partial.zip");
      writeFileSync(partial, (await partialSdk.package(p.original.did)).bytes);
      const partialOut = run(["verify", partial, "--json", "--now", "2026-10-19T00:00:00Z"]);
      expect(partialOut.code).toBe(0);
      expect((JSON.parse(partialOut.stdout) as { resources: { status: string }; verified: boolean })).toMatchObject({ resources: { status: "partial" }, verified: true });
      const tampered = join(dir, "bad.zip");
      writeFileSync(tampered, new Uint8Array([1, 2, 3]));
      expect(run(["verify", tampered]).code).toBe(1);
      expect(run(["nonsense"]).code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
