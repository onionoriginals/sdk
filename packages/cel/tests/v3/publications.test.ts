import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fixtures from "../../../../docs/research/cel-core-vectors/histories.json";
import {
  resolveSat,
  createLocalSigner,
  signEvent,
  encodeDocument,
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
        expect(result.state.aliases).toEqual(scenario.expected.aliases);
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
