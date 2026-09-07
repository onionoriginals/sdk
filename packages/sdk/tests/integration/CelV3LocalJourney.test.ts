import { expect, test } from "bun:test";
import {
  OriginalsSDK,
  ASSET_LIMITS,
  createLocalSigner,
} from "../../src/index.js";
import type { Algorithm } from "@originals/cel/v3";
import authority from "../../../../docs/research/cel-core-vectors/histories.json";

for (const algorithm of ["Ed25519", "P-256", "P-384"] as Algorithm[]) {
  test(`${algorithm}: create, replace metadata and resource bytes, rotate and fresh-load terminal history`, async () => {
    const signer = createLocalSigner(
      algorithm,
      new Uint8Array(algorithm === "P-384" ? 48 : 32).fill(9),
    );
    const successor = createLocalSigner("Ed25519", new Uint8Array(32).fill(10));
    const sdk = OriginalsSDK.create({ signer });
    const asset = await sdk.lifecycle.createAsset(
      [
        {
          id: "book",
          mediaType: "text/plain",
          content: "first edition",
          url: ["https://example.com/book"],
        },
      ],
      {
        name: "Book",
        metadata: JSON.parse(
          '{"__proto__":{"kept":true},"0":"zero","type":"ordinary metadata"}',
        ),
      },
    );
    const initial = await sdk.lifecycle.loadAsset(
      JSON.stringify(asset.serialize()),
    );
    expect(Object.hasOwn(initial.asset.state.metadata, "__proto__")).toBe(true);
    expect(initial.asset.state.metadata["0"]).toBe("zero");
    await asset.update({ metadata: { edition: 2 } });
    expect(asset.state.metadata).toEqual({ edition: 2 });
    await asset.addResourceVersion(
      "book",
      new Uint8Array([0, 255, 127, 128]),
      "application/octet-stream",
    );
    await asset.rotateKey(successor.controller);
    const fresh = OriginalsSDK.create({ signer: successor });
    const loaded = await fresh.lifecycle.loadAsset(
      JSON.stringify(asset.serialize()),
    );
    await loaded.asset.deactivate("complete");
    const terminal = await fresh.lifecycle.loadAsset(
      JSON.stringify(loaded.asset.serialize()),
    );
    expect(terminal.verification.verified).toBe(true);
    expect(terminal.asset.state).toMatchObject({
      active: false,
      controller: successor.controller,
      entryCount: 5,
    });
    expect(terminal.asset.resources[1].content).toEqual(
      new Uint8Array([0, 255, 127, 128]),
    );
    expect(terminal.asset.resources[1].url).toBeUndefined();
    expect(terminal.asset.state.resources[0].version).toBe(2);
  });
}

test("authenticated offline Bitcoin history never becomes accepted on-sat history through load or verify", async () => {
  const document = {
    log: [authority.entries.G, authority.entries.W, authority.entries.T],
  };
  const sdk = OriginalsSDK.create();
  const envelope = {
    format: "originals/asset",
    version: 3,
    assetDid: authority.entries.W.event.operation.data.from,
    eventLog: document,
    resources: [],
  };
  // The expected identity comes from the independent fixture; it is still checked against genesis.
  await expect(sdk.lifecycle.loadAsset(envelope)).rejects.toMatchObject({
    code: "ASSET_LOAD_VERIFICATION_FAILED",
  });
  const loaded = await sdk.lifecycle.loadAsset(envelope, {
    allowPartial: true,
  });
  expect(loaded.verification.history).toMatchObject({
    status: "authenticated",
    scope: "controller-history",
    bitcoinAcceptance: "unverified",
    webvhBinding: "unverified",
  });
  expect(await loaded.asset.verify()).toBe(false);
});

test("byte budget failure happens before invoking custody and does not change the asset", async () => {
  const local = createLocalSigner("Ed25519", new Uint8Array(32).fill(12));
  const asset = await OriginalsSDK.create({
    signer: local,
  }).lifecycle.createAsset([
    { id: "r", mediaType: "text/plain", content: "old" },
  ]);
  const before = asset.serialize();
  let calls = 0;
  const signer = {
    ...local,
    async sign(message: Uint8Array) {
      calls++;
      return local.sign(message);
    },
  };
  await expect(
    asset.addResourceVersion(
      "r",
      new Uint8Array(ASSET_LIMITS.bytes + 1),
      "application/octet-stream",
      { signer },
    ),
  ).rejects.toMatchObject({ code: "ASSET_BYTES_LIMIT" });
  expect(calls).toBe(0);
  expect(asset.serialize()).toEqual(before);
});

test("invalid signatures cannot become skipped edits, and the following valid queued mutation still succeeds", async () => {
  const signer = createLocalSigner("Ed25519", new Uint8Array(32).fill(13));
  const sdk = OriginalsSDK.create({ signer, onAppendFailure: "skip" });
  const asset = await sdk.lifecycle.createAsset([
    { id: "r", mediaType: "text/plain", content: "old" },
  ]);
  const bad = {
    ...signer,
    async sign() {
      return new Uint8Array(64);
    },
  };
  const results = await Promise.allSettled([
    asset.addResourceVersion("r", "unacknowledged", "text/plain", {
      signer: bad,
    }),
    asset.update({ name: "good" }),
  ]);
  expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
  expect(asset.localResources).toHaveLength(0);
  expect(asset.resources).toHaveLength(1);
  expect(
    (await sdk.lifecycle.loadAsset(asset.serialize())).asset.state.entryCount,
  ).toBe(2);
});
