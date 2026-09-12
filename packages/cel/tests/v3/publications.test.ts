import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { base58 } from "@scure/base";
import fixtures from "../../../../docs/research/cel-core-vectors/histories.json";
import {
  resolveSat,
  createLocalSigner,
  signEvent,
  createNonce,
  digestBytes,
  encodeDocument,
  verifyHistory,
  type SatSnapshot,
} from "../../src/v3/index.js";

// These are declared provider observations, not Bitcoin RPC evidence.
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function observations(
  scenario: (typeof fixtures.cases)[number],
): SatSnapshot {
  const tip = { height: 110, hash: hash(scenario.snapshot.tipBefore) };
  const blocks = new Map<
    number,
    { height: number; hash: string; txids: string[] }
  >();
  for (const pub of scenario.publications) {
    if (!pub.position) continue;
    const [height, txIndex] = pub.position;
    const block = blocks.get(height) ?? {
      height,
      hash: hash(scenario.snapshot.tipBefore + ":" + height),
      txids: [],
    };
    while (block.txids.length <= txIndex)
      block.txids.push(hash(height + ":" + block.txids.length));
    blocks.set(height, block);
  }
  return {
    network: scenario.snapshot.network as "regtest",
    sat: scenario.snapshot.sat,
    tipBefore: tip,
    tipAfter: { height: 110, hash: hash(scenario.snapshot.tipAfter) },
    indexTip: tip,
    indexHealthy: true,
    enumerationComplete: scenario.snapshot.enumerationComplete,
    blocks: [...blocks.values()],
    ownership: {
      owner: scenario.snapshot.owner,
      satpoint: hash("current location") + ":0:0",
    },
    publications: scenario.publications.map((pub) => {
      const [height, txIndex, index] = pub.position ?? [102, 1, 0],
        block = blocks.get(height);
      const txid = hash(height + ":" + txIndex);
      return {
        id: txid + "i" + index,
        revealTxid: txid,
        network: pub.network as "regtest",
        sat: pub.sat,
        confirmed: pub.confirmed,
        ...(pub.position
          ? {
              creation: {
                height,
                blockHash: block!.hash,
                transactionIndex: txIndex,
                inscriptionIndex: index,
              },
            }
          : {}),
        body:
          "capabilityUnavailable" in pub && pub.capabilityUnavailable
            ? { status: "unsupported" as const }
            : !pub.complete
              ? { status: "unavailable" as const }
              : {
                  status: "complete" as const,
                  mediaType:
                    "unrelated" in pub && pub.unrelated
                      ? "text/plain"
                      : "application/cel",
                  bytes: new TextEncoder().encode(
                    JSON.stringify({
                      log: pub.entries.map(
                        (id) =>
                          fixtures.entries[id as keyof typeof fixtures.entries],
                      ),
                    }),
                  ),
                  metadata: null,
                },
      };
    }),
  };
}

test("accepts the complete boundary at a stable declared snapshot, with possession separate from authority", () => {
  const scenario = fixtures.cases[0],
    result = resolveSat(observations(scenario));
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") throw new Error(result.status);
  expect(result.state.head).toBe(scenario.expected.headDigest);
  expect(result.state.controller).toBe(fixtures.actors.A);
  expect(result.scope).toBe("sat");
  expect(result.crossSatCanonicality).toBe("unknown");
  expect(result.ownership.owner).toBe("A");
});

for (const scenario of fixtures.cases)
  test(`worked history: ${scenario.id}`, () => {
    const snapshot = observations(scenario);
    const expectedStatus =
      scenario.expected.status === "accepted-at-declared-snapshot"
        ? "accepted"
        : scenario.expected.status;
    for (const publications of [
      snapshot.publications,
      [...snapshot.publications].reverse(),
    ]) {
      const result = resolveSat(
        { ...snapshot, publications },
        "expectedDid" in scenario.snapshot
          ? { expectedDid: scenario.snapshot.expectedDid as string }
          : {},
      );
      expect(result.status).toBe(expectedStatus);
      if (result.status === "accepted") {
        expect(result.state.head).toBe(scenario.expected.headDigest);
        expect(result.state.controller).toBe(
          fixtures.actors[
            scenario.expected.controller as keyof typeof fixtures.actors
          ],
        );
        expect(result.state.name).toBe(scenario.expected.name);
        expect(result.state.metadata).toEqual(scenario.expected.metadata);
        expect(result.state.active).toBe(scenario.expected.active);
        expect(result.state.aliases).toEqual([result.state.assetId, ...scenario.expected.aliases]);
        expect(result.state.resources[0].digestMultibase).toBe(
          scenario.expected.resourceDigest,
        );
        expect(result.state.resources[0].version).toBe(
          scenario.expected.resourceVersion,
        );
        expect(result.ownership.owner).toBe(scenario.expected.owner);
      } else expect("state" in result).toBe(false);
    }
  });

test("does not accept conflicting confirmed and pending records for one inscription", () => {
  const snapshot = observations(fixtures.cases[0]);
  snapshot.publications.push({ ...snapshot.publications[0], confirmed: false });
  expect(resolveSat(snapshot).status).toBe("inconsistent-evidence");
});

test("accepts raw resource bytes with full CEL metadata and binds the exact byte digest", () => {
  const snapshot = observations(fixtures.cases[0]),
    publication = snapshot.publications[0];
  const body = publication.body;
  if (body.status !== "complete") throw new Error("fixture");
  publication.body = {
    status: "complete",
    mediaType: "image/png",
    bytes: new TextEncoder().encode("version zero fixture bytes"),
    metadata: encodeDocument(
      { log: [fixtures.entries.G, fixtures.entries.W, fixtures.entries.T] },
      "cbor",
    ),
  };
  const result = resolveSat(snapshot);
  expect(result.status).toBe("accepted");
  if (result.status === "accepted")
    expect(result.publications[0].inlineResourceIds).toEqual(["art.png"]);
  publication.body.bytes[0] ^= 1;
  const mismatched = resolveSat(snapshot);
  expect(mismatched.status).toBe("accepted");
  if (mismatched.status === "accepted") {
    expect(mismatched.state.head).toBe(fixtures.entryDigests.T);
    expect(mismatched.publications[0].inlineResourceIds).toEqual([]);
    expect(mismatched.publications[0].inlineContentStatus).toBe("unmatched");
  }
});

test("missing metadata, an orphaned block, and a false transaction position cannot produce a current head", () => {
  const missing = observations(fixtures.cases[0]);
  delete (missing.publications[0].body as { metadata?: unknown }).metadata;
  expect(resolveSat(missing).status).toBe("incomplete");
  const orphan = observations(fixtures.cases[0]);
  orphan.publications[0].creation!.blockHash = hash("orphan");
  expect(resolveSat(orphan).status).toBe("chain-changed");
  const position = observations(fixtures.cases[0]);
  position.publications[0].creation!.transactionIndex = 0;
  expect(resolveSat(position).status).toBe("inconsistent-evidence");
  const suffix = observations(fixtures.cases[0]);
  suffix.publications[0].creation!.inscriptionIndex = 10;
  expect(resolveSat(suffix).status).toBe("inconsistent-evidence");
});

test("a signed malformed WebVH migration cannot abort selection of a later valid boundary", async () => {
  const snapshot = observations(fixtures.cases[0]);
  const A = createLocalSigner(
    "Ed25519",
    new Uint8Array(
      Buffer.from(
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
        "hex",
      ),
    ),
  );
  const event = structuredClone(fixtures.entries.W.event);
  event.operation.data.to = event.operation.data.to.replace(
    "example.com",
    "example.123",
  );
  const badMigration = await signEvent(event, A);
  const block = {
    height: 100,
    hash: hash("malformed-host-block"),
    txids: [hash("malformed-host-tx")],
  };
  snapshot.blocks.push(block);
  snapshot.publications.push({
    network: "regtest",
    sat: snapshot.sat,
    confirmed: true,
    id: block.txids[0] + "i0",
    revealTxid: block.txids[0],
    creation: {
      height: 100,
      blockHash: block.hash,
      transactionIndex: 0,
      inscriptionIndex: 0,
    },
    body: {
      status: "complete",
      mediaType: "application/cel",
      bytes: encodeDocument(
        { log: [fixtures.entries.G, badMigration] },
        "json",
      ),
      metadata: null,
    },
  });
  const result = resolveSat(snapshot);
  expect(result.status).toBe("accepted");
  if (result.status === "accepted") {
    expect(result.state.head).toBe(fixtures.entryDigests.T);
    expect(result.diagnostics).toContainEqual({
      inscriptionId: block.txids[0] + "i0",
      code: "CEL_DID",
    });
  }
});

test("unmatched inline bytes do not suppress an authorized rotation and continuation", () => {
  const scenario = fixtures.cases.find(
    (c) => c.id === "rotation-and-B-update-in-one-publication",
  )!;
  const snapshot = observations(scenario),
    publication = snapshot.publications[1];
  publication.body = {
    status: "complete",
    mediaType: "image/png",
    bytes: new TextEncoder().encode("unmatched inline bytes"),
    metadata: encodeDocument(
      { log: [fixtures.entries.R, fixtures.entries.Bupdate] },
      "cbor",
    ),
  };
  const result = resolveSat(snapshot);
  expect(result.status).toBe("accepted");
  if (result.status === "accepted") {
    expect(result.state.head).toBe(fixtures.entryDigests.Bupdate);
    expect(result.state.controller).toBe(fixtures.actors.B);
    expect(result.publications[1].inlineContentStatus).toBe("unmatched");
    expect(result.publications[1].inlineResourceIds).toEqual([]);
  }
});

// #378: a boundary/delta carries at most one inline resource body per publication.
// resourceAvailability must honestly report, per current resource, whether an accepted
// publication in *this* snapshot actually carried its exact current bytes on-chain.
const A = createLocalSigner(
  "Ed25519",
  new Uint8Array(
    Buffer.from(
      "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
      "hex",
    ),
  ),
);
const scid = base58.encode(
  Uint8Array.from([0x12, 0x20, ...createHash("sha256").update("378").digest()]),
);
const sat = "5000000001";

async function twoResourceBoundary(resourceA: Uint8Array, resourceB: Uint8Array) {
  const genesis = await signEvent(
    {
      operation: {
        type: "create",
        data: {
          profile: "originals/cel/3",
          controller: A.controller,
          createdAt: "2026-09-11T00:00:00Z",
          nonce: createNonce(),
          resources: [
            { id: "a", mediaType: "text/plain", digestMultibase: digestBytes(resourceA) },
            { id: "b", mediaType: "text/plain", digestMultibase: digestBytes(resourceB) },
          ],
        },
      },
    },
    A,
  );
  const initial = verifyHistory({ log: [genesis] });
  const toWebvh = await signEvent(
    {
      previousEvent: initial.state.head,
      operation: {
        type: "migrate",
        data: {
          profile: "originals/cel/3",
          from: initial.state.assetId,
          to: `did:webvh:${scid}:example.com:378`,
          layer: "webvh",
          migratedAt: "2026-09-11T00:00:01Z",
        },
      },
    },
    A,
  );
  const afterWebvh = verifyHistory({ log: [toWebvh] }, { prefix: initial });
  const toBtco = await signEvent(
    {
      previousEvent: afterWebvh.state.head,
      operation: {
        type: "migrate",
        data: {
          profile: "originals/cel/3",
          from: afterWebvh.state.alias,
          to: `did:btco:reg:${sat}`,
          layer: "btco",
          migratedAt: "2026-09-11T00:00:02Z",
        },
      },
    },
    A,
  );
  const afterBtco = verifyHistory({ log: [toBtco] }, { prefix: afterWebvh });
  expect(afterBtco.state.alias).toBe(`did:btco:reg:${sat}`);
  return { log: [genesis, toWebvh, toBtco], afterBtco };
}

function emptySnapshot(): Omit<SatSnapshot, "publications"> {
  const tip = { height: 200, hash: "b".repeat(64) };
  return {
    network: "regtest",
    sat,
    tipBefore: tip,
    tipAfter: tip,
    indexTip: tip,
    indexHealthy: true,
    enumerationComplete: true,
    blocks: [{ height: 200, hash: tip.hash, txids: ["c".repeat(64)] }],
    ownership: { owner: "holder", satpoint: "d".repeat(64) + ":0:0" },
  };
}

function publicationAt(
  log: unknown[],
  bytes: Uint8Array,
  mediaType: string,
): SatSnapshot["publications"][number] {
  return {
    id: "c".repeat(64) + "i0",
    revealTxid: "c".repeat(64),
    network: "regtest",
    sat,
    confirmed: true,
    creation: { height: 200, blockHash: "b".repeat(64), transactionIndex: 0, inscriptionIndex: 0 },
    body: {
      status: "complete",
      mediaType,
      bytes,
      metadata: encodeDocument({ log }, "cbor"),
    },
  };
}

test("a two-resource boundary reports bitcoin-inline only for the resource whose bytes were actually inlined", async () => {
  const resourceA = new TextEncoder().encode("resource A bytes"),
    resourceB = new TextEncoder().encode("resource B bytes");
  const { log } = await twoResourceBoundary(resourceA, resourceB);
  const snapshot: SatSnapshot = {
    ...emptySnapshot(),
    publications: [publicationAt(log, resourceA, "text/plain")],
  };
  const result = resolveSat(snapshot);
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") throw new Error(result.status);
  // Removing any host changes nothing here: "b" was never carried on-chain.
  expect(result.resourceAvailability).toEqual([
    { id: "a", version: 1, availability: "bitcoin-inline" },
    { id: "b", version: 1, availability: "referenced" },
  ]);
});

test("a delta changing two resources leaves only the resource re-inlined at its new digest recoverable", async () => {
  const resourceA1 = new TextEncoder().encode("resource A v1"),
    resourceB1 = new TextEncoder().encode("resource B v1"),
    resourceA2 = new TextEncoder().encode("resource A v2"),
    resourceB2 = new TextEncoder().encode("resource B v2");
  const { log: boundaryLog, afterBtco } = await twoResourceBoundary(
    resourceA1,
    resourceB1,
  );
  const update = await signEvent(
    {
      previousEvent: afterBtco.state.head,
      operation: {
        type: "update",
        data: {
          profile: "originals/cel/3",
          resources: [
            {
              id: "a",
              mediaType: "text/plain",
              digestMultibase: digestBytes(resourceA2),
              previousDigestMultibase: digestBytes(resourceA1),
            },
            {
              id: "b",
              mediaType: "text/plain",
              digestMultibase: digestBytes(resourceB2),
              previousDigestMultibase: digestBytes(resourceB1),
            },
          ],
        },
      },
    },
    A,
  );
  const boundaryPublication = publicationAt(boundaryLog, resourceA1, "text/plain");
  const deltaPublication: SatSnapshot["publications"][number] = {
    ...publicationAt([update], resourceA2, "text/plain"),
    id: "e".repeat(64) + "i0",
    revealTxid: "e".repeat(64),
    creation: { height: 201, blockHash: "f".repeat(64), transactionIndex: 0, inscriptionIndex: 0 },
  };
  const snapshot: SatSnapshot = {
    ...emptySnapshot(),
    tipBefore: { height: 201, hash: "f".repeat(64) },
    tipAfter: { height: 201, hash: "f".repeat(64) },
    indexTip: { height: 201, hash: "f".repeat(64) },
    blocks: [
      { height: 200, hash: "b".repeat(64), txids: ["c".repeat(64)] },
      { height: 201, hash: "f".repeat(64), txids: ["e".repeat(64)] },
    ],
    publications: [boundaryPublication, deltaPublication],
  };
  const result = resolveSat(snapshot);
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") throw new Error(result.status);
  expect(result.state.resources.map((r) => r.digestMultibase)).toEqual([
    digestBytes(resourceA2),
    digestBytes(resourceB2),
  ]);
  // "a" was re-inlined at its new digest; the boundary's stale bytes for "a" don't count,
  // and "b" was never carried on-chain at any digest it currently has: without a host,
  // only "a"'s bytes remain recoverable.
  expect(result.resourceAvailability).toEqual([
    { id: "a", version: 2, availability: "bitcoin-inline" },
    { id: "b", version: 2, availability: "referenced" },
  ]);
});
