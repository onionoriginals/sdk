import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../../src/v3/cli.ts", import.meta.url));
let directory: string;
let file: string;
let key: string;
let nonFile: string;

function run(args: string[]) {
  const result = Bun.spawnSync([process.execPath, cli, ...args]);
  return {
    status: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}
function createArgs(input = file, privateKey = key) {
  return ["create", "--file", input, "--media-type", "text/plain", "--algorithm", "Ed25519", "--key", privateKey];
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "originals-cli-boundary-"));
  file = join(directory, "art.txt");
  key = join(directory, "controller.key");
  nonFile = join(directory, "not-a-file");
  await mkdir(nonFile);
  await writeFile(file, "CLI boundary fixture");
  await writeFile(key, new Uint8Array(32).fill(7));
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe("local CLI file and output contracts", () => {
  test("explicit empty output fails without emitting an envelope", () => {
    const result = run([...createArgs(), "--output", ""]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ status: "invalid", code: "CLI_ARGUMENT" });
    expect(JSON.parse(result.stderr).message).toContain("--output");
  });

  test("omitted output writes version 4 to stdout, matching create help", () => {
    const result = run(createArgs());
    expect(result.status).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.version).toBe(4);
    expect(envelope.format).toBe("originals/asset");
    const help = run(["create", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain(`version-${envelope.version} asset envelope`);
  });

  test("a named output is created and never overwritten", async () => {
    const output = join(directory, "asset.json");
    expect(run([...createArgs(), "--output", output]).status).toBe(0);
    const original = await readFile(output, "utf8");
    expect(JSON.parse(original).version).toBe(4);
    const again = run([...createArgs(), "--output", output]);
    expect(again.status).toBe(1);
    expect(again.stdout).toBe("");
    expect(await readFile(output, "utf8")).toBe(original);
  });

  for (const kind of ["media", "key", "asset", "log"] as const) {
    test(`${kind} directory input reports a file-type error`, () => {
      const args = kind === "media" ? createArgs(nonFile)
        : kind === "key" ? createArgs(file, nonFile)
        : ["verify", `--${kind}`, nonFile];
      const result = run(args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({ status: "invalid", code: "CLI_FILE_TYPE" });
      expect(JSON.parse(result.stderr).message).toContain("regular file");
    });
  }

  test("oversized regular key input retains its size-limit diagnostic", async () => {
    const oversized = join(directory, "oversized.key");
    await writeFile(oversized, new Uint8Array(33));
    const result = run(createArgs(file, oversized));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({ status: "limit", code: "CLI_FILE_LIMIT" });
  });
});
