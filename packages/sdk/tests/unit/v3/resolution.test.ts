import { expect, test } from "bun:test";
import { OriginalsSDK } from "../../../src/index.js";
import { AssetResolver } from "../../../src/v3/resolution.js";
import {
  createLocalSigner,
  signEvent,
  encodeDocument,
  type SatSnapshot,
  eventDigest,
} from "@originals/cel/v3";

const signer = createLocalSigner("Ed25519", new Uint8Array(32).fill(7));
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
const txid = "a".repeat(64),
  blockHash = "b".repeat(64);
async function boundary() {
  const asset = await OriginalsSDK.create({ signer }).lifecycle.createAsset([
    { id: "art", mediaType: "image/png", content: png },
  ]);
  const web =
    "did:webvh:QmWmyoCVmCuFjPT9fAtP8jCFXbT8Zzq5TGfxEbGoZFbBfo:example.com:art";
  const hosted = await signEvent(
    {
      previousEvent: asset.state.head,
      operation: {
        type: "migrate",
        data: {
          profile: "originals/cel/3",
          from: asset.id,
          to: web,
          layer: "webvh",
          migratedAt: "2026-09-06T00:00:00Z",
        },
      },
    },
    signer,
  );
  const migration = await signEvent(
    {
      previousEvent: eventDigest(hosted.event),
      operation: {
        type: "migrate",
        data: {
          profile: "originals/cel/3",
          from: web,
          to: "did:btco:reg:123",
          layer: "btco",
          migratedAt: "2026-09-06T00:00:00Z",
        },
      },
    },
    signer,
  );
  const log = { log: [...asset.celLog.log, hosted, migration] };
  const snapshot: SatSnapshot = {
    network: "regtest",
    sat: "123",
    tipBefore: { height: 100, hash: blockHash },
    tipAfter: { height: 100, hash: blockHash },
    indexTip: { height: 100, hash: blockHash },
    indexHealthy: true,
    enumerationComplete: true,
    blocks: [{ height: 100, hash: blockHash, txids: [txid] }],
    ownership: { owner: "holder", satpoint: txid + ":0:0" },
    publications: [
      {
        id: txid + "i0",
        revealTxid: txid,
        network: "regtest",
        sat: "123",
        confirmed: true,
        creation: {
          height: 100,
          blockHash,
          transactionIndex: 0,
          inscriptionIndex: 0,
        },
        body: {
          status: "complete",
          mediaType: "image/png",
          bytes: png,
          metadata: encodeDocument(log, "cbor"),
        },
      },
    ],
  };
  return { snapshot, asset, log };
}

test("a fresh consumer resolves binary bytes and DID authority from the same accepted sat history", async () => {
  const { snapshot, asset } = await boundary();
  const sdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => snapshot },
  });
  const result = await sdk.lifecycle.resolveAssetFromSat("123");
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") throw new Error(result.status);
  expect(result.asset.id).toBe(asset.id);
  expect(result.asset.resources[0].content).toEqual(png);
  expect(result.resolution.state.controller).toBe(signer.controller);
  expect(result.verification.resources).toBe("verified");
  const did = await sdk.did.resolveDID("did:btco:reg:123");
  expect(did?.id).toBe("did:btco:reg:123");
  expect(did?.controller).toEqual([signer.controller]);
  expect(did?.alsoKnownAs).toContain(asset.id);
  const metadata = await sdk.did.resolveDIDWithMetadata("did:btco:reg:123");
  expect(metadata.didDocumentMetadata.ownership).toEqual(snapshot.ownership);
  expect(metadata.didDocumentMetadata.head).toBe(result.asset.state.head);
});

test("network recovery and verify re-read the accepted head instead of trusting serialized Bitcoin claims", async () => {
  const { snapshot } = await boundary();
  const sdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => snapshot },
  });
  const result = await sdk.lifecycle.resolveAssetFromSat("123");
  if (result.status !== "accepted") throw new Error(result.status);
  const loaded = await sdk.lifecycle.loadAsset(
    JSON.stringify(result.asset.serialize()),
  );
  expect(loaded.verification.verified).toBe(true);
  expect(await loaded.asset.verify()).toBe(true);
  snapshot.indexHealthy = false;
  expect(await loaded.asset.verify()).toBe(false);
  await expect(
    sdk.lifecycle.loadAsset(result.asset.serialize()),
  ).rejects.toThrow("not fully verified");
  await expect(sdk.did.resolveDID("did:btco:reg:123")).rejects.toThrow();
});

test("log-only publication keeps missing bytes explicit and unrelated raw DID content cannot replace authority", async () => {
  const { snapshot, log } = await boundary();
  snapshot.publications[0].body = {
    status: "complete",
    mediaType: "application/cel",
    bytes: encodeDocument(log, "json"),
    metadata: null,
  };
  const rawTx = "c".repeat(64);
  snapshot.blocks[0].txids.push(rawTx);
  snapshot.publications.push({
    ...snapshot.publications[0],
    id: rawTx + "i0",
    revealTxid: rawTx,
    creation: { ...snapshot.publications[0].creation!, transactionIndex: 1 },
    body: {
      status: "complete",
      mediaType: "application/json",
      metadata: null,
      bytes: new TextEncoder().encode(
        JSON.stringify({ id: "did:btco:reg:123", controller: ["attacker"] }),
      ),
    },
  });
  const sdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => snapshot },
  });
  const result = await sdk.lifecycle.resolveAssetFromSat("123");
  if (result.status !== "accepted") throw new Error(result.status);
  expect(result.verification.verified).toBe(false);
  expect(result.verification.missingResources).toEqual([
    { id: "art", version: 1 },
  ]);
  expect(result.asset.resources[0].content).toBeUndefined();
  expect((await sdk.did.resolveDID("did:btco:reg:123"))?.controller).toEqual([
    signer.controller,
  ]);
});

test("rotation and updates in one later publication retire the prior key independently of sale and reacquisition", async () => {
  const { snapshot, log } = await boundary();
  const nextSigner = createLocalSigner("Ed25519", new Uint8Array(32).fill(8));
  const rotation = await signEvent(
    {
      previousEvent: eventDigest(log.log.at(-1)!.event),
      operation: {
        type: "rotateKey",
        data: {
          profile: "originals/cel/3",
          newController: nextSigner.controller,
          rotatedAt: "2026-09-06T00:00:01Z",
        },
      },
    },
    signer,
  );
  const update = await signEvent(
    {
      previousEvent: eventDigest(rotation.event),
      operation: {
        type: "update",
        data: { profile: "originals/cel/3", name: "By the current controller" },
      },
    },
    nextSigner,
  );
  const nextTx = "c".repeat(64),
    nextHash = "d".repeat(64);
  snapshot.tipBefore =
    snapshot.tipAfter =
    snapshot.indexTip =
      { height: 101, hash: nextHash };
  snapshot.blocks.push({ height: 101, hash: nextHash, txids: [nextTx] });
  snapshot.publications.unshift({
    id: nextTx + "i0",
    revealTxid: nextTx,
    network: "regtest",
    sat: "123",
    confirmed: true,
    creation: {
      height: 101,
      blockHash: nextHash,
      transactionIndex: 0,
      inscriptionIndex: 0,
    },
    body: {
      status: "complete",
      mediaType: "application/cel",
      bytes: encodeDocument({ log: [rotation, update] }, "json"),
      metadata: null,
    },
  });
  const sdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => snapshot },
  });
  for (const owner of ["buyer", "original holder"]) {
    snapshot.ownership.owner = owner;
    const result = await sdk.lifecycle.resolveAssetFromSat("123");
    if (result.status !== "accepted") throw new Error(result.status);
    expect(result.asset.state.name).toBe("By the current controller");
    expect(result.asset.state.controller).toBe(nextSigner.controller);
    expect(result.asset.resources[0].content).toEqual(png);
    expect((await sdk.did.resolveDID("did:btco:reg:123"))?.controller).toEqual([
      nextSigner.controller,
    ]);
    await expect(
      result.asset.update({ name: "Retired key" }, { signer }),
    ).rejects.toThrow("current controller");
  }
});

test("a holder-only CEL-shaped inscription cannot substitute creator authority; live possession stays separately visible", async () => {
  const { snapshot, log } = await boundary();
  const holder = createLocalSigner("Ed25519", new Uint8Array(32).fill(9));
  const forgedRotation = await signEvent(
    {
      previousEvent: eventDigest(log.log.at(-1)!.event),
      operation: {
        type: "rotateKey",
        data: {
          profile: "originals/cel/3",
          newController: holder.controller,
          rotatedAt: "2026-09-06T00:00:01Z",
        },
      },
    },
    holder,
  );
  const holderTx = "e".repeat(64),
    holderHash = "f".repeat(64);
  snapshot.tipBefore =
    snapshot.tipAfter =
    snapshot.indexTip =
      { height: 101, hash: holderHash };
  snapshot.blocks.push({ height: 101, hash: holderHash, txids: [holderTx] });
  snapshot.ownership = { owner: "holder-after-sale", satpoint: holderTx + ":0:0" };
  snapshot.publications.push({
    id: holderTx + "i0",
    revealTxid: holderTx,
    network: "regtest",
    sat: "123",
    confirmed: true,
    creation: {
      height: 101,
      blockHash: holderHash,
      transactionIndex: 0,
      inscriptionIndex: 0,
    },
    body: {
      status: "complete",
      mediaType: "application/cel",
      bytes: encodeDocument({ log: [forgedRotation] }, "json"),
      metadata: null,
    },
  });
  const sdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => snapshot },
  });
  const result = await sdk.lifecycle.resolveAssetFromSat("123");
  if (result.status !== "accepted") throw new Error(result.status);
  // Buying/holding the sat never rewrites creator authority by itself.
  expect(result.asset.state.controller).toBe(signer.controller);
  expect(result.resolution.state.controller).toBe(signer.controller);
  expect(
    result.resolution.diagnostics.some(
      (d) => d.inscriptionId === holderTx + "i0" && d.code === "CEL_AUTHORITY",
    ),
  ).toBe(true);
  // Live possession is still observable, and disagrees with authorship on purpose.
  expect(result.resolution.ownership.owner).toBe("holder-after-sale");
  // Generic DID resolution and asset resolution agree on the same rejected authority state.
  const did = await sdk.did.resolveDID("did:btco:reg:123");
  expect(did?.controller).toEqual([signer.controller]);
  const metadata = await sdk.did.resolveDIDWithMetadata("did:btco:reg:123");
  expect(metadata.didDocumentMetadata.ownership?.owner).toBe(
    "holder-after-sale",
  );
});

test('resolution retries a changing snapshot and bounds failures if the chain cannot stabilize', async () => {
  const { snapshot } = await boundary(); let calls = 0;
  const changing = structuredClone(snapshot); changing.tipAfter.hash = 'e'.repeat(64);
  const sdk = OriginalsSDK.create({ network: 'regtest', satProvider: { getSatSnapshot: async () => ++calls === 1 ? changing : snapshot } });
  expect((await sdk.lifecycle.resolveAssetFromSat('123')).status).toBe('accepted');
  expect(calls).toBe(2);
  calls = 0;
  const unstable = OriginalsSDK.create({ network: 'regtest', satProvider: { getSatSnapshot: async () => { calls++; return changing; } } });
  expect((await unstable.lifecycle.resolveAssetFromSat('123')).status).toBe('chain-changed');
  expect(calls).toBe(3);
});


test("resolution retries provider-detected chain movement without accepting partial evidence", async () => {
  const { snapshot } = await boundary();
  let reads = 0;
  const sdk = OriginalsSDK.create({ network: "regtest", satProvider: { async getSatSnapshot() {
    if (++reads === 1) throw Object.assign(new Error("index moved"), { code: "SAT_SNAPSHOT_CHAIN_CHANGED" });
    return snapshot;
  } } });
  expect((await sdk.lifecycle.resolveAssetFromSat("123")).status).toBe("accepted");
  expect(reads).toBe(2);
});

test("an accepted resolution and its DID metadata are labeled provider-asserted unless an explicit application validator succeeds", async () => {
  const { snapshot } = await boundary();
  const sdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => snapshot },
  });
  const result = await sdk.lifecycle.resolveAssetFromSat("123");
  if (result.status !== "accepted") throw new Error(result.status);
  expect(result.resolution.chainEvidence.assurance).toBe("provider-asserted");
  expect(result.resolution.chainEvidence.source).toBeUndefined();
  expect(result.verification.publication?.chainEvidence.assurance).toBe("provider-asserted");
  const metadata = await sdk.did.resolveDIDWithMetadata("did:btco:reg:123");
  expect(metadata.didDocumentMetadata.chainEvidence.assurance).toBe("provider-asserted");

  // An ordinary provider claim cannot upgrade the result.
  const validated: SatSnapshot = {
    ...snapshot,
    chainEvidence: { assurance: "node-validated", source: "untrusted-claim" },
  };
  const ordinarySdk = OriginalsSDK.create({ network: "regtest", satProvider: { getSatSnapshot: async () => validated } });
  const ordinary = await ordinarySdk.lifecycle.resolveAssetFromSat("123");
  if (ordinary.status !== "accepted") throw new Error(ordinary.status);
  expect(ordinary.resolution.chainEvidence).toEqual({ assurance: "provider-asserted" });
  const validatedSdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => validated },
    chainValidator: async checked => {
      expect(checked).toEqual(validated);
      expect(checked).not.toBe(validated);
      return { source: "regtest-core+ord" };
    },
  });
  const validatedResult = await validatedSdk.lifecycle.resolveAssetFromSat("123");
  if (validatedResult.status !== "accepted") throw new Error(validatedResult.status);
  expect(validatedResult.resolution.chainEvidence.assurance).toBe("node-validated");
  expect(validatedResult.resolution.chainEvidence.source).toBe("regtest-core+ord");
  const validatedMetadata = await validatedSdk.did.resolveDIDWithMetadata("did:btco:reg:123");
  expect(validatedMetadata.didDocumentMetadata.chainEvidence.assurance).toBe("node-validated");
  expect(validatedMetadata.didDocumentMetadata.chainEvidence.source).toBe("regtest-core+ord");
});

test("an unsupported-capability DID resolution reports no chain evidence was even obtained, without a configured provider", async () => {
  const sdk = OriginalsSDK.create({ network: "regtest" });
  const metadata = await sdk.did.resolveDIDWithMetadata("did:btco:reg:123");
  expect(metadata.didResolutionMetadata.status).toBe("unsupported-capability");
  // No provider was consulted at all, so this must not be confused with a
  // provider having actually supplied and stood behind a snapshot.
  expect(metadata.didDocumentMetadata.chainEvidence.assurance).toBe("unavailable");
});

test("a sat whose only publication is still unconfirmed resolves as pending, not silently as not-found", async () => {
  const { snapshot } = await boundary();
  const pendingSnapshot: SatSnapshot = {
    ...snapshot,
    publications: snapshot.publications.map((publication) => ({
      ...publication,
      confirmed: false,
    })),
  };
  const sdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => pendingSnapshot },
  });
  const result = await sdk.lifecycle.resolveAssetFromSat("123");
  expect(result.status).toBe("pending");
  if (result.status !== "pending") throw new Error(result.status);
  expect(result.pending).toEqual(pendingSnapshot.publications.map((p) => p.id));

  const metadata = await sdk.did.resolveDIDWithMetadata("did:btco:reg:123");
  expect(metadata.didResolutionMetadata.status).toBe("pending");
  expect(metadata.didDocument).toBeNull();
  expect(metadata.didDocumentMetadata.pending).toEqual(result.pending);

  // The plain (non-metadata) resolveDID call treats "pending" like any other
  // inconclusive status: it throws rather than silently returning null, so a
  // caller can't confuse "not confirmed yet" with "confirmed absent."
  await expect(sdk.did.resolveDID("did:btco:reg:123")).rejects.toThrow();
});

test("a provider that fabricates a self-consistent alternate tip, or silently omits a later publication, still only ever yields a provider-asserted result", async () => {
  const { snapshot, log } = await boundary();

  // (a) A relocated but internally self-consistent chain state: resolveSat can
  // only check internal consistency, never independently authenticate the tip
  // it was handed, so it must accept this -- the honesty has to live in the
  // chainEvidence label, not in a rejection that core has no way to make.
  const altHash = "f".repeat(64);
  const fabricated: SatSnapshot = structuredClone(snapshot);
  fabricated.tipBefore = fabricated.tipAfter = fabricated.indexTip = {
    height: 9000,
    hash: altHash,
  };
  fabricated.blocks = [{ height: 9000, hash: altHash, txids: [txid] }];
  fabricated.publications[0] = {
    ...fabricated.publications[0],
    creation: {
      height: 9000,
      blockHash: altHash,
      transactionIndex: 0,
      inscriptionIndex: 0,
    },
  };
  const fabricatedSdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => fabricated },
  });
  const fabricatedResult =
    await fabricatedSdk.lifecycle.resolveAssetFromSat("123");
  if (fabricatedResult.status !== "accepted")
    throw new Error(fabricatedResult.status);
  expect(fabricatedResult.resolution.tip).toEqual({
    height: 9000,
    hash: altHash,
  });
  expect(fabricatedResult.resolution.chainEvidence.assurance).toBe("provider-asserted");

  // (b) A later publication genuinely exists but the provider's enumeration
  // silently drops it while still asserting enumerationComplete: true.
  // resolveSat has no way to detect the omission -- it resolves the earlier
  // state as though it were current -- so an omitted-publication result must
  // never read as anything stronger than provider-asserted either.
  const laterUpdate = await signEvent(
    {
      previousEvent: eventDigest(log.log.at(-1)!.event),
      operation: {
        type: "update",
        data: { profile: "originals/cel/3", name: "Never observed" },
      },
    },
    signer,
  );
  const nextTx = "c".repeat(64),
    nextHash = "d".repeat(64);
  const complete: SatSnapshot = structuredClone(snapshot);
  complete.tipBefore =
    complete.tipAfter =
    complete.indexTip =
      { height: 101, hash: nextHash };
  complete.blocks.push({ height: 101, hash: nextHash, txids: [nextTx] });
  complete.publications.unshift({
    id: nextTx + "i0",
    revealTxid: nextTx,
    network: "regtest",
    sat: "123",
    confirmed: true,
    creation: {
      height: 101,
      blockHash: nextHash,
      transactionIndex: 0,
      inscriptionIndex: 0,
    },
    body: {
      status: "complete",
      mediaType: "application/cel",
      bytes: encodeDocument({ log: [laterUpdate] }, "json"),
      metadata: null,
    },
  });
  const omitting: SatSnapshot = structuredClone(snapshot);
  const completeSdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => complete },
  });
  const completeResult =
    await completeSdk.lifecycle.resolveAssetFromSat("123");
  if (completeResult.status !== "accepted")
    throw new Error(completeResult.status);
  expect(completeResult.asset.state.name).toBe("Never observed");
  expect(completeResult.resolution.chainEvidence.assurance).toBe("provider-asserted");

  const omittingSdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => omitting },
  });
  const omittedResult =
    await omittingSdk.lifecycle.resolveAssetFromSat("123");
  if (omittedResult.status !== "accepted")
    throw new Error(omittedResult.status);
  expect(omittedResult.asset.state.name).not.toBe("Never observed");
  expect(omittedResult.resolution.chainEvidence.assurance).toBe("provider-asserted");
});

test("a provider that throws before returning any snapshot never obtained chain evidence, unlike a returned-but-mismatched snapshot", async () => {
  // The provider never returned anything at all: no snapshot -- and therefore
  // no provider assertion -- was ever obtained, so this must not be confused
  // with a provider having actually stood behind a (even if rejected) snapshot.
  const throwingSdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: {
      getSatSnapshot: async () => {
        throw new Error("network unreachable");
      },
    },
  });
  const thrownResult = await throwingSdk.lifecycle.resolveAssetFromSat("123");
  expect(thrownResult.status).toBe("incomplete");
  if (thrownResult.status === "accepted") throw new Error("unexpected accept");
  expect(thrownResult.chainEvidence.assurance).toBe("unavailable");

  // A snapshot WAS returned here, just for the wrong sat/network -- the
  // provider supplied data, but its claimed upgrade is not trusted.
  const { snapshot } = await boundary();
  const mismatched: SatSnapshot = {
    ...snapshot,
    sat: "999",
    chainEvidence: { assurance: "node-validated", source: "untrusted-claim" },
  };
  const mismatchedSdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => mismatched },
  });
  const mismatchedResult =
    await mismatchedSdk.lifecycle.resolveAssetFromSat("123");
  expect(mismatchedResult.status).toBe("inconsistent-evidence");
  if (mismatchedResult.status === "accepted")
    throw new Error("unexpected accept");
  expect(mismatchedResult.chainEvidence.assurance).toBe("provider-asserted");
  expect(mismatchedResult.chainEvidence.source).toBeUndefined();
});

test("check() rejects a cross-network identity before any provider is consulted, with no chain evidence obtained", async () => {
  const resolver = new AssetResolver("regtest");
  // A mainnet-shaped did (no network prefix) queried against a
  // regtest-configured resolver: rejected purely from parsing the identity,
  // before any provider call, so no snapshot -- and no provider assertion --
  // was ever obtained.
  const result = await resolver.check("did:btco:123", "did:btco:123");
  expect(result.status).toBe("identity-mismatch");
  expect(result.chainEvidence.assurance).toBe("unavailable");
});

test('validator failures fail closed and validator mutations cannot change the resolved view', async () => {
  const { snapshot } = await boundary();
  const failed = OriginalsSDK.create({ network: 'regtest', satProvider: { getSatSnapshot: async () => snapshot },
    chainValidator: async () => { throw new Error('disagreement'); } });
  const rejected = await failed.lifecycle.resolveAssetFromSat('123');
  expect(rejected.status).toBe('incomplete');
  if (rejected.status === 'accepted') throw new Error('accepted');
  expect(rejected.chainEvidence.assurance).toBe('provider-asserted');
  const detached = OriginalsSDK.create({ network: 'regtest', satProvider: { getSatSnapshot: async () => snapshot },
    chainValidator: async copy => { copy.publications.splice(0); snapshot.publications.splice(0); } });
  const result = await detached.lifecycle.resolveAssetFromSat('123');
  expect(result.status).toBe('accepted');
  if (result.status !== 'accepted') throw new Error(result.status);
  expect(result.resolution.chainEvidence.assurance).toBe('node-validated');
});

test("cross-checks enumeration against an independently configured second index and carries the assurance into DID metadata", async () => {
  const { snapshot } = await boundary();
  const agreeing = structuredClone(snapshot);
  const sdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => snapshot },
    independentEnumeration: {
      label: "second-ord-instance",
      provider: { getSatSnapshot: async () => agreeing },
    },
  });
  const result = await sdk.lifecycle.resolveAssetFromSat("123");
  if (result.status !== "accepted") throw new Error(result.status);
  expect(result.resolution.enumerationAssurance).toBe("cross-checked");
  expect(result.resolution.enumerationSource).toBe("second-ord-instance");
  const metadata = await sdk.did.resolveDIDWithMetadata("did:btco:reg:123");
  expect(metadata.didDocumentMetadata.enumerationAssurance).toBe(
    "cross-checked",
  );
  expect(metadata.didDocumentMetadata.enumerationSource).toBe(
    "second-ord-instance",
  );
});

test("without an independent source configured, resolution still accepts but only claims provider-asserted enumeration", async () => {
  const { snapshot } = await boundary();
  const sdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => snapshot },
  });
  const result = await sdk.lifecycle.resolveAssetFromSat("123");
  if (result.status !== "accepted") throw new Error(result.status);
  expect(result.resolution.enumerationAssurance).toBe("provider-asserted");
});

test("fails closed when the independent enumeration source sees a publication the primary provider omitted", async () => {
  const { snapshot } = await boundary();
  const omittedTx = "9".repeat(64);
  const independent = structuredClone(snapshot);
  independent.publications.push({
    ...independent.publications[0],
    id: omittedTx + "i0",
    revealTxid: omittedTx,
  });
  const sdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => snapshot },
    independentEnumeration: {
      label: "second-ord-instance",
      provider: { getSatSnapshot: async () => independent },
    },
  });
  const result = await sdk.lifecycle.resolveAssetFromSat("123");
  expect(result.status).toBe("inconsistent-evidence");
});

test("fails closed when the independent source's own snapshot is incomplete, unhealthy or unstable, rather than granting cross-checked for free", async () => {
  const { snapshot } = await boundary();
  const cases: [string, (s: SatSnapshot) => SatSnapshot][] = [
    ["incomplete enumeration", (s) => ({ ...s, enumerationComplete: false })],
    ["unhealthy index", (s) => ({ ...s, indexHealthy: false })],
    [
      "unstable tip",
      (s) => ({ ...s, tipAfter: { ...s.tipAfter, hash: "1".repeat(64) } }),
    ],
    [
      "identical but malformed tips (equal is not the same as valid)",
      (s) => {
        const malformed = { height: -1, hash: "not-a-real-hash" };
        return {
          ...s,
          tipBefore: malformed,
          tipAfter: malformed,
          indexTip: malformed,
        };
      },
    ],
  ];
  for (const [, corrupt] of cases) {
    const independent = corrupt(structuredClone(snapshot));
    const sdk = OriginalsSDK.create({
      network: "regtest",
      satProvider: { getSatSnapshot: async () => snapshot },
      independentEnumeration: {
        label: "second-ord-instance",
        provider: { getSatSnapshot: async () => independent },
      },
    });
    const result = await sdk.lifecycle.resolveAssetFromSat("123");
    expect(result.status).toBe("incomplete");
  }
});

test("fails closed when a configured independent enumeration source cannot be reached, rather than silently degrading to provider-asserted", async () => {
  const { snapshot } = await boundary();
  const sdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => snapshot },
    independentEnumeration: {
      label: "second-ord-instance",
      provider: {
        getSatSnapshot: async () => {
          throw new Error("second index unreachable");
        },
      },
    },
  });
  const result = await sdk.lifecycle.resolveAssetFromSat("123");
  expect(result.status).toBe("incomplete");
});

test("an unreachable independent enumeration source does not discard an already-established node-validated chain evidence", async () => {
  const { snapshot } = await boundary();
  const sdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => snapshot },
    chainValidator: async () => ({ source: "local-core-node" }),
    independentEnumeration: {
      label: "second-ord-instance",
      provider: {
        getSatSnapshot: async () => {
          throw new Error("second index unreachable");
        },
      },
    },
  });
  const result = await sdk.lifecycle.resolveAssetFromSat("123");
  expect(result.status).toBe("incomplete");
  if (result.status === "accepted") throw new Error("accepted");
  expect(result.chainEvidence.assurance).toBe("node-validated");
  expect(result.chainEvidence.source).toBe("local-core-node");
});

test("cross-checks ownership against the same independently configured second index and carries the assurance into DID metadata", async () => {
  const { snapshot } = await boundary();
  const agreeing = structuredClone(snapshot);
  const sdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => snapshot },
    independentEnumeration: {
      label: "second-ord-instance",
      provider: { getSatSnapshot: async () => agreeing },
    },
  });
  const result = await sdk.lifecycle.resolveAssetFromSat("123");
  if (result.status !== "accepted") throw new Error(result.status);
  expect(result.resolution.enumerationAssurance).toBe("cross-checked");
  expect(result.resolution.ownershipAssurance).toBe("cross-checked");
  const metadata = await sdk.did.resolveDIDWithMetadata("did:btco:reg:123");
  expect(metadata.didDocumentMetadata.ownershipAssurance).toBe(
    "cross-checked",
  );
});

test("without an independent source configured, resolution still accepts but only claims provider-asserted ownership", async () => {
  const { snapshot } = await boundary();
  const sdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => snapshot },
  });
  const result = await sdk.lifecycle.resolveAssetFromSat("123");
  if (result.status !== "accepted") throw new Error(result.status);
  expect(result.resolution.ownershipAssurance).toBe("provider-asserted");
});

test("fails closed when the independent enumeration source disagrees about who currently holds the sat", async () => {
  const { snapshot } = await boundary();
  const disagreeing = structuredClone(snapshot);
  disagreeing.ownership = { owner: "a-different-holder", satpoint: disagreeing.ownership.satpoint };
  const sdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => snapshot },
    independentEnumeration: {
      label: "second-ord-instance",
      provider: { getSatSnapshot: async () => disagreeing },
    },
  });
  const result = await sdk.lifecycle.resolveAssetFromSat("123");
  expect(result.status).toBe("inconsistent-evidence");
});

// Real Core/ord coverage for these tip cases and actual transfers runs in
// scripts/regtest/ownership-check.ts via the standard regtest journey.
test("does not cross-check ownership against an independent source observing a different chain tip, even when the values happen to match", async () => {
  const { snapshot } = await boundary();
  const staleTip = { height: snapshot.tipBefore.height - 1, hash: "9".repeat(64) };
  const stale = structuredClone(snapshot);
  stale.tipBefore = staleTip;
  stale.tipAfter = staleTip;
  stale.indexTip = staleTip;
  const sdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => snapshot },
    independentEnumeration: {
      label: "second-ord-instance",
      provider: { getSatSnapshot: async () => stale },
    },
  });
  const result = await sdk.lifecycle.resolveAssetFromSat("123");
  if (result.status !== "accepted") throw new Error(result.status);
  // Enumeration is still corroborated (an older tip's ids are a safe subset to compare),
  // but ownership from a different tip must not be able to confer cross-checked, even
  // though its value happens to equal the primary snapshot's.
  expect(result.resolution.enumerationAssurance).toBe("cross-checked");
  expect(result.resolution.ownershipAssurance).toBe("provider-asserted");
});

test("a differing owner at a different independent chain tip does not fail resolution (the comparison is skipped, not evaluated)", async () => {
  const { snapshot } = await boundary();
  const staleTip = { height: snapshot.tipBefore.height - 1, hash: "9".repeat(64) };
  const staleDisagreeing = structuredClone(snapshot);
  staleDisagreeing.tipBefore = staleTip;
  staleDisagreeing.tipAfter = staleTip;
  staleDisagreeing.indexTip = staleTip;
  staleDisagreeing.ownership = { owner: "an-old-holder", satpoint: staleDisagreeing.ownership.satpoint };
  const sdk = OriginalsSDK.create({
    network: "regtest",
    satProvider: { getSatSnapshot: async () => snapshot },
    independentEnumeration: {
      label: "second-ord-instance",
      provider: { getSatSnapshot: async () => staleDisagreeing },
    },
  });
  const result = await sdk.lifecycle.resolveAssetFromSat("123");
  if (result.status !== "accepted") throw new Error(result.status);
  expect(result.resolution.ownershipAssurance).toBe("provider-asserted");
});
