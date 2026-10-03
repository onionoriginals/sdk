import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OriginalsSDK } from "../../src/index.js";
import pkg from "../../package.json";
import {
  createLocalSigner,
  signEvent,
  verifyHistory,
  encodeDocument,
} from "@originals/cel/v3";
import { HostedMemoryStorageAdapter } from "../../src/storage/HostedMemoryStorageAdapter.js";
import { OriginalsSDK as LocalSDK } from "../../src/v3/OriginalsSDK.js";

const cli = resolve(import.meta.dir, "../..", pkg.bin["originals-cel"]);
async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("the packaged CLI creates a byte-complete CEL 3 asset that the default SDK recovers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "originals-cel3-cli-"));
  try {
    const bytes = new Uint8Array([0, 255, 127, 128]);
    const file = join(dir, "art.bin"),
      key = join(dir, "test.key"),
      output = join(dir, "asset.json");
    await writeFile(file, bytes);
    await writeFile(key, new Uint8Array(32).fill(23));
    const created = await run([
      "create",
      "--file",
      file,
      "--media-type",
      "application/octet-stream",
      "--algorithm",
      "Ed25519",
      "--key",
      key,
      "--output",
      output,
    ]);
    expect(created.exitCode, created.stderr).toBe(0);
    const restored = await OriginalsSDK.create().lifecycle.loadAsset(
      await Bun.file(output).text(),
    );
    expect(restored.verification.verified).toBe(true);
    expect(restored.asset.resources[0].content).toEqual(bytes);
    const verified = await run(["verify", "--asset", output]);
    expect(verified.exitCode, verified.stderr).toBe(0);
    expect(JSON.parse(verified.stdout).verified).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the installed-style CLI symlink executes under Node", async () => {
  const { symlink } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "originals-cel3-bin-"));
  try {
    const bin = join(dir, "originals-cel");
    await symlink(cli, bin);
    const child = Bun.spawn(["node", bin, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, error).toBe(0);
    expect(output.trim()).toBe(pkg.version);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const signer = createLocalSigner("Ed25519", new Uint8Array(32).fill(9));

async function envelopes() {
  const sdk = OriginalsSDK.create({
    signer,
    storageAdapter: new HostedMemoryStorageAdapter(),
  });
  const asset = await sdk.lifecycle.createAsset([
    { id: "art", mediaType: "text/plain", content: "first" },
  ]);
  await asset.addResourceVersion("art", "second", "text/plain");
  const cel = asset.serialize();
  const published = await sdk.lifecycle.publishToWeb(asset, {
    domain: "example.com",
  });
  const webvh = published.asset.serialize();
  const btco = structuredClone(webvh);
  btco.eventLog.log.push(
    await signEvent(
      {
        previousEvent: published.asset.state.head,
        operation: {
          type: "migrate",
          data: {
            profile: "originals/cel/3",
            from: published.asset.state.alias,
            to: "did:btco:reg:123",
            layer: "btco",
            migratedAt: "2026-10-03T00:00:00Z",
          },
        },
      },
      signer,
    ),
  );
  // A signed post-anchor proposal is authentic, but has no chain acceptance.
  btco.eventLog.log.push(
    await signEvent(
      {
        previousEvent: verifyHistory(btco.eventLog).state.head,
        operation: {
          type: "update",
          data: { profile: "originals/cel/3", name: "offline proposal" },
        },
      },
      signer,
    ),
  );
  return { cel, webvh, btco };
}

for (const layer of ["cel", "webvh", "btco"] as const) {
  test(`CLI verifies complete ${layer} bytes offline without inferring publication acceptance`, async () => {
    const envelope = (await envelopes())[layer];
    const dir = await mkdtemp(join(tmpdir(), "cli-offline-"));
    try {
      const path = join(dir, "asset.json");
      await writeFile(path, JSON.stringify(envelope));
      const result = await run(["verify", "--asset", path]);
      expect(result.exitCode, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.localVerification).toEqual({
        scope: "controller-history-and-bytes",
        verified: true,
      });
      expect(output.verified).toBe(layer === "cel");
      expect(output.resources).toBe("verified");
      expect(output.state).toBeUndefined();
      expect(output.history.webvhBinding).toBe(
        layer === "cel" ? "not-applicable" : "unverified",
      );
      expect(output.history.bitcoinAcceptance).toBe(
        layer === "btco" ? "unverified" : "not-applicable",
      );
      expect(output.history.freshness).toBe("unknown");
      expect(output.hosted).toBeUndefined();
      expect(output.publication).toBeUndefined();
      if (layer !== "cel") {
        await expect(
          LocalSDK.create().lifecycle.loadAsset(envelope),
        ).rejects.toMatchObject({ code: "ASSET_LOAD_VERIFICATION_FAILED" });
      }
      for (const defect of [
        "missing",
        "draft",
        "signature",
        "bytes",
      ] as const) {
        const broken = structuredClone(envelope);
        if (defect === "missing") broken.resources.shift(); // Historical version, not just the head.
        if (defect === "signature")
          broken.eventLog.log[0].proof[0].proofValue = (
            await signEvent(
              broken.eventLog.log[0].event,
              createLocalSigner("Ed25519", new Uint8Array(32).fill(10)),
            )
          ).proof[0].proofValue;
        if (defect === "bytes") broken.resources[0].content.data = "YmFk";
        if (defect === "draft") {
          const { asset } = await LocalSDK.create().lifecycle.loadAsset(
            broken,
            { allowPartial: true },
          );
          await asset.addResourceVersion("art", "draft", "text/plain", {
            onAppendFailure: "skip",
          });
          broken.unverified = asset.serialize().unverified;
        }
        await writeFile(path, JSON.stringify(broken));
        const rejected = await run(["verify", "--asset", path]);
        expect(
          rejected.exitCode,
          `${layer}/${defect}: ${rejected.stdout}`,
        ).toBe(1);
        expect(rejected.stdout).toBe("");
        const inspected = await run(["inspect", "--asset", path]);
        if (defect === "missing" || defect === "draft") {
          expect(inspected.exitCode, inspected.stderr).toBe(0);
          const partial = JSON.parse(inspected.stdout);
          expect(partial.verified).toBe(false);
          expect(partial.localVerification.verified).toBe(false);
          expect(partial.state).toEqual(partial.history.state);
          if (defect === "missing")
            expect(partial.missingResources).toContainEqual({
              id: "art",
              version: 1,
            });
          else expect(partial.unverifiedLocalResources).toBe(1);
        } else expect(inspected.exitCode).toBe(1);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const format of ["json", "cbor"] as const) {
  test(`inspect --log adds state while verify preserves its ${format} history-only result`, async () => {
    const { btco } = await envelopes();
    const dir = await mkdtemp(join(tmpdir(), "cli-log-"));
    try {
      const path = join(dir, "history");
      await writeFile(path, encodeDocument(btco.eventLog, format));
      const verified = await run(["verify", "--log", path, "--format", format]);
      const inspected = await run([
        "inspect",
        "--log",
        path,
        "--format",
        format,
      ]);
      expect(verified.exitCode, verified.stderr).toBe(0);
      expect(inspected.exitCode, inspected.stderr).toBe(0);
      const output = JSON.parse(verified.stdout);
      expect(Object.keys(output).sort()).toEqual([
        "history",
        "resources",
        "scope",
        "verified",
      ]);
      expect(output).toMatchObject({
        verified: false,
        scope: "controller-history",
        resources: "unchecked",
      });
      expect(JSON.parse(inspected.stdout)).toEqual({
        ...output,
        state: output.history.state,
      });
      const assetPath = join(dir, "asset.json");
      await writeFile(assetPath, JSON.stringify(btco));
      const asset = await run(["inspect", "--asset", assetPath]);
      expect(JSON.parse(asset.stdout).state).toEqual(output.history.state);
      btco.eventLog.log.at(-1)!.event.previousEvent =
        btco.eventLog.log[1].event.previousEvent;
      await writeFile(path, encodeDocument(btco.eventLog, format));
      for (const command of ["verify", "inspect"]) {
        const invalid = await run([command, "--log", path, "--format", format]);
        expect(invalid.exitCode).toBe(1);
        expect(invalid.stdout).toBe("");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
