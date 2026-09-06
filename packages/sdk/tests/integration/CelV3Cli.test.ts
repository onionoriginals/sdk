import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OriginalsSDK } from "../../src/index.js";
import pkg from "../../package.json";

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
