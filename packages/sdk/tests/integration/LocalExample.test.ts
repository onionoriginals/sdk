import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { basicExample } from "../../src/examples/basic-usage.js";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));

function runExample(args: string[] = []) {
  return spawnSync(process.execPath, ["run", "src/examples/run.ts", ...args], {
    cwd: packageRoot,
    encoding: "utf8",
    timeout: 15_000,
  });
}

test("the basic example recovers every resource version without signing custody or network access", async () => {
  const { asset, verification } = await basicExample();
  expect(verification.verified).toBe(true);
  expect(verification.resources).toBe("verified");
  expect(verification.missingResources).toEqual([]);
  expect(asset.state.name).toBe("Revised greeting");
  expect(asset.state.layer).toBe("cel");
  expect(asset.state.entryCount).toBe(3);
  expect(asset.state.resources[0].version).toBe(2);
  expect(
    asset.resources.map((resource) =>
      new TextDecoder().decode(resource.content),
    ),
  ).toEqual(["Hello, Originals!", "Hello again, Originals!"]);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  await expect(
    asset.update({ name: "No retained signer" }),
  ).rejects.toMatchObject({
    code: "NO_SIGNING_KEY",
  });
});

test("each example run uses fresh demo custody", async () => {
  const first = await basicExample();
  const second = await basicExample();
  expect(first.asset.state.controller).not.toBe(second.asset.state.controller);
});

for (const args of [[], ["basic"]]) {
  test(`example runner succeeds for ${args[0] ?? "the default invocation"}`, () => {
    const result = runExample(args);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Local history and bytes verified: true");
    expect(result.stdout).toContain("Resource version: 2");
  });
}

test("example runner explains its supported local scope", () => {
  const result = runExample(["--help"]);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("[basic]");
  expect(result.stdout).toContain("No network publication");
  expect(result.stdout).not.toContain("Local history and bytes verified:");
});

for (const args of [["module"], ["lifecycle"], ["typo"], ["basic", "extra"]]) {
  test(`example runner rejects unsupported arguments: ${args.join(" ")}`, () => {
    const result = runExample(args);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unsupported example arguments");
    expect(result.stdout).not.toContain("Local history and bytes verified:");
  });
}
