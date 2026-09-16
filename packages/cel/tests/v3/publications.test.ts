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
  encodeValue,
  eventDigest,
  verifyHistory,
  normalizeSatpoint,
  normalizeInscriptionId,
  jcsSigningMessage,
  decodeController,
  type SatSnapshot,
  type IndependentContentEvidence,
  type CelSigner,
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
  expect(result.trajectoryAssurance).toBe("not-independently-derived");
});

// #594: `ownership` is a single point-in-time observation. This resolver never
// walks the UTXO/transfer graph, so it cannot independently derive how the sat
// arrived at that owner/satpoint — every accepted result must say so honestly,
// unconditionally, regardless of how many publications or observations agree.
test("every accepted resolution reports sat trajectory as not independently derived", () => {
  for (const scenario of fixtures.cases) {
    const result = resolveSat(observations(scenario));
    if (result.status === "accepted")
      expect(result.trajectoryAssurance).toBe("not-independently-derived");
  }
});

function completeContentEvidence(
  snapshot: SatSnapshot,
): IndependentContentEvidence[] {
  return snapshot.publications
    .filter((p) => p.body.status === "complete")
    .map((p) => {
      const body = p.body as { mediaType: string; bytes: Uint8Array; metadata: Uint8Array | null };
      return {
        inscriptionId: p.id,
        mediaType: body.mediaType,
        contentDigest: digestBytes(body.bytes),
        metadataDigest: body.metadata === null ? null : digestBytes(body.metadata),
      };
    });
}

test("content assurance defaults to provider-asserted with no independent evidence configured", () => {
  const result = resolveSat(observations(fixtures.cases[0]));
  expect(result.status).toBe("accepted");
  if (result.status === "accepted")
    expect(result.contentAssurance).toBe("provider-asserted");
});

test("cross-checks content when independent evidence agrees for every accepted publication", () => {
  const snapshot = observations(fixtures.cases[0]);
  const result = resolveSat(snapshot, {
    independentContent: completeContentEvidence(snapshot),
  });
  expect(result.status).toBe("accepted");
  if (result.status === "accepted")
    expect(result.contentAssurance).toBe("cross-checked");
});

test("partial independent content coverage does not upgrade assurance, and does not fail", () => {
  const snapshot = observations(fixtures.cases[0]);
  const evidence = completeContentEvidence(snapshot);
  expect(evidence.length).toBeGreaterThan(0);
  const result = resolveSat(snapshot, {
    independentContent: evidence.slice(0, evidence.length - 1),
  });
  expect(result.status).toBe("accepted");
  if (result.status === "accepted")
    expect(result.contentAssurance).toBe("provider-asserted");
});

test("fails closed when independent content evidence disagrees with a substituted body", () => {
  const snapshot = observations(fixtures.cases[0]);
  const evidence = completeContentEvidence(snapshot);
  // Simulate a compromised indexer: the on-chain content an independent
  // Bitcoin node derived disagrees with what the provider actually served.
  evidence[0] = {
    ...evidence[0],
    contentDigest: digestBytes(new TextEncoder().encode("forged content")),
  };
  const result = resolveSat(snapshot, { independentContent: evidence });
  expect(result.status).toBe("inconsistent-evidence");
  expect("state" in result).toBe(false);
});

test("fails closed when independent content evidence disagrees only on media type", () => {
  const snapshot = observations(fixtures.cases[0]);
  const evidence = completeContentEvidence(snapshot);
  evidence[0] = { ...evidence[0], mediaType: "image/png" };
  const result = resolveSat(snapshot, { independentContent: evidence });
  expect(result.status).toBe("inconsistent-evidence");
});

test("fails closed when independent metadata evidence disagrees while body and media type still agree", () => {
  // A compromised indexer could serve the correct main content/media type
  // (satisfying those two checks) while substituting the CEL metadata tag
  // that actually drives history — body/media agreement alone must not be
  // enough to earn cross-checked assurance.
  const snapshot = observations(fixtures.cases[0]);
  const evidence = completeContentEvidence(snapshot);
  expect(evidence[0].metadataDigest).toBeNull();
  evidence[0] = {
    ...evidence[0],
    metadataDigest: digestBytes(new TextEncoder().encode("forged metadata")),
  };
  const result = resolveSat(snapshot, { independentContent: evidence });
  expect(result.status).toBe("inconsistent-evidence");
});

test("cross-checks content when independent evidence reports the same inscription id in a different hex case (#808)", () => {
  const snapshot = observations(fixtures.cases[0]);
  const evidence = completeContentEvidence(snapshot).map((e) => ({
    ...e,
    inscriptionId: e.inscriptionId.toUpperCase(),
  }));
  const result = resolveSat(snapshot, { independentContent: evidence });
  expect(result.status).toBe("accepted");
  if (result.status === "accepted")
    expect(result.contentAssurance).toBe("cross-checked");
});

test("rejects malformed independent content evidence rather than ignoring it", () => {
  const snapshot = observations(fixtures.cases[0]);
  const result = resolveSat(snapshot, {
    independentContent: [
      // @ts-expect-error deliberately missing contentDigest/metadataDigest for the test
      { inscriptionId: snapshot.publications[0].id, mediaType: "text/plain" },
    ],
  });
  expect(result.status).toBe("incomplete");
});

test("rejects independent content evidence with a non-string, non-null metadataDigest", () => {
  const snapshot = observations(fixtures.cases[0]);
  const evidence = completeContentEvidence(snapshot);
  const result = resolveSat(snapshot, {
    independentContent: [
      // @ts-expect-error deliberately invalid metadataDigest type for the test
      { ...evidence[0], metadataDigest: 12345 },
    ],
  });
  expect(result.status).toBe("incomplete");
});

test("rejects duplicate inscription ids in independent content evidence", () => {
  const snapshot = observations(fixtures.cases[0]);
  const evidence = completeContentEvidence(snapshot);
  const result = resolveSat(snapshot, {
    independentContent: [evidence[0], evidence[0]],
  });
  expect(result.status).toBe("incomplete");
});

test("rejects duplicate inscription ids that differ only in hex case, even with conflicting content (#808)", () => {
  // Distinct content digests: if the dedup check ever regressed to comparing
  // raw (non-normalized) ids, these two entries would coexist under
  // different-case map keys instead of being rejected as a duplicate, and
  // the conflicting second entry could be silently ignored rather than
  // surfaced. Same-content variants wouldn't distinguish that from a
  // correctly normalized dedup check.
  const snapshot = observations(fixtures.cases[0]);
  const evidence = completeContentEvidence(snapshot);
  const result = resolveSat(snapshot, {
    independentContent: [
      evidence[0],
      {
        ...evidence[0],
        inscriptionId: evidence[0].inscriptionId.toUpperCase(),
        contentDigest: digestBytes(new TextEncoder().encode("conflicting content")),
      },
    ],
  });
  expect(result.status).toBe("incomplete");
});

test("an independent source reporting an unknown inscription id does not itself break resolution", () => {
  const snapshot = observations(fixtures.cases[0]);
  const evidence = completeContentEvidence(snapshot);
  evidence.push({
    inscriptionId: "f".repeat(64) + "i9",
    mediaType: "text/plain",
    contentDigest: digestBytes(new TextEncoder().encode("unrelated")),
    metadataDigest: null,
  });
  const result = resolveSat(snapshot, { independentContent: evidence });
  expect(result.status).toBe("accepted");
  if (result.status === "accepted")
    expect(result.contentAssurance).toBe("cross-checked");
});

test("disagreeing evidence for a publication ignored as unrelated never blocks an otherwise valid history", () => {
  const scenario = fixtures.cases.find(
    (c) => c.id === "inspected-unrelated-bytes-do-not-poison",
  )!;
  const snapshot = observations(scenario);
  const evidence = completeContentEvidence(snapshot);
  const unrelated = snapshot.publications.find(
    (p) => p.body.status === "complete" && p.body.mediaType === "text/plain",
  )!;
  const entry = evidence.find((e) => e.inscriptionId === unrelated.id)!;
  expect(entry).toBeDefined();
  // The independent source disagrees only about content nothing in the
  // accepted history actually depends on: this inscription is ignored
  // (CEL_UNRELATED) rather than accepted.
  entry.contentDigest = digestBytes(new TextEncoder().encode("forged"));
  const result = resolveSat(snapshot, { independentContent: evidence });
  expect(result.status).toBe("accepted");
  if (result.status === "accepted") {
    expect(
      result.diagnostics.some(
        (d) => d.inscriptionId === unrelated.id && d.code === "CEL_UNRELATED",
      ),
    ).toBe(true);
    // Every ACCEPTED publication's evidence still agreed, so the disagreement
    // on an ignored, irrelevant publication does not downgrade assurance either.
    expect(result.contentAssurance).toBe("cross-checked");
  }
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
          ? { expectedAssetId: scenario.snapshot.expectedDid as string }
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

test("enumeration assurance defaults to provider-asserted with no independent source configured", () => {
  const result = resolveSat(observations(fixtures.cases[0]));
  expect(result.status).toBe("accepted");
  if (result.status === "accepted")
    expect(result.enumerationAssurance).toBe("provider-asserted");
});

test("cross-checks enumeration when an independent source agrees with the primary snapshot", () => {
  const snapshot = observations(fixtures.cases[0]);
  const result = resolveSat(snapshot, {
    independentEnumeration: {
      source: "second-ord-instance",
      inscriptionIds: snapshot.publications.map((p) => p.id),
    },
  });
  expect(result.status).toBe("accepted");
  if (result.status === "accepted") {
    expect(result.enumerationAssurance).toBe("cross-checked");
    expect(result.enumerationSource).toBe("second-ord-instance");
  }
});

test("cross-checks enumeration when an independent source reports the same inscription ids in a different hex case (#808)", () => {
  const snapshot = observations(fixtures.cases[0]);
  const result = resolveSat(snapshot, {
    independentEnumeration: {
      source: "second-ord-instance",
      inscriptionIds: snapshot.publications.map((p) => p.id.toUpperCase()),
    },
  });
  expect(result.status).toBe("accepted");
  if (result.status === "accepted")
    expect(result.enumerationAssurance).toBe("cross-checked");
});

test("does not report an enumeration source when no independent source was consulted", () => {
  const result = resolveSat(observations(fixtures.cases[0]));
  expect(result.status).toBe("accepted");
  if (result.status === "accepted")
    expect(result.enumerationSource).toBeUndefined();
});

test("rejects a non-string independent enumeration source label", () => {
  const snapshot = observations(fixtures.cases[0]);
  const result = resolveSat(snapshot, {
    independentEnumeration: {
      // @ts-expect-error deliberately malformed for the test
      source: 123,
      inscriptionIds: snapshot.publications.map((p) => p.id),
    },
  });
  expect(result.status).toBe("incomplete");
});

test("a fewer-inscriptions independent source still cross-checks (it just corroborates less)", () => {
  const snapshot = observations(fixtures.cases[0]);
  const result = resolveSat(snapshot, {
    independentEnumeration: { source: "lagging-index", inscriptionIds: [] },
  });
  expect(result.status).toBe("accepted");
  if (result.status === "accepted")
    expect(result.enumerationAssurance).toBe("cross-checked");
});

test("fails closed when an independent source reports an inscription the primary snapshot omitted", () => {
  const snapshot = observations(fixtures.cases[0]);
  const omitted =
    "f".repeat(64) + "i0"; // a plausible id the primary snapshot never listed
  const result = resolveSat(snapshot, {
    independentEnumeration: {
      source: "second-ord-instance",
      inscriptionIds: [...snapshot.publications.map((p) => p.id), omitted],
    },
  });
  expect(result.status).toBe("inconsistent-evidence");
  expect("state" in result).toBe(false);
});

test("rejects malformed independent enumeration evidence rather than ignoring it", () => {
  const snapshot = observations(fixtures.cases[0]);
  const result = resolveSat(snapshot, {
    independentEnumeration: {
      source: "second-ord-instance",
      // @ts-expect-error deliberately malformed for the test
      inscriptionIds: "not-an-array",
    },
  });
  expect(result.status).toBe("incomplete");
});

test("ownership assurance defaults to provider-asserted with no independent evidence", () => {
  const result = resolveSat(observations(fixtures.cases[0]));
  expect(result.status).toBe("accepted");
  if (result.status === "accepted")
    expect(result.ownershipAssurance).toBe("provider-asserted");
});

test("ownership assurance stays provider-asserted when independentEnumeration is configured for enumeration only", () => {
  const snapshot = observations(fixtures.cases[0]);
  const result = resolveSat(snapshot, {
    independentEnumeration: {
      source: "second-ord-instance",
      inscriptionIds: snapshot.publications.map((p) => p.id),
    },
  });
  expect(result.status).toBe("accepted");
  if (result.status === "accepted")
    expect(result.ownershipAssurance).toBe("provider-asserted");
});

test("cross-checks ownership when independent evidence agrees with the primary snapshot", () => {
  const snapshot = observations(fixtures.cases[0]);
  const result = resolveSat(snapshot, {
    independentEnumeration: {
      source: "second-ord-instance",
      inscriptionIds: snapshot.publications.map((p) => p.id),
      ownership: { ...snapshot.ownership },
    },
  });
  expect(result.status).toBe("accepted");
  if (result.status === "accepted")
    expect(result.ownershipAssurance).toBe("cross-checked");
});

test("fails closed when independent ownership evidence disagrees on the owner", () => {
  const snapshot = observations(fixtures.cases[0]);
  const result = resolveSat(snapshot, {
    independentEnumeration: {
      source: "second-ord-instance",
      inscriptionIds: snapshot.publications.map((p) => p.id),
      ownership: { ...snapshot.ownership, owner: "someone-else" },
    },
  });
  expect(result.status).toBe("inconsistent-evidence");
  expect("state" in result).toBe(false);
});

test("fails closed when independent ownership evidence disagrees on the satpoint", () => {
  const snapshot = observations(fixtures.cases[0]);
  const result = resolveSat(snapshot, {
    independentEnumeration: {
      source: "second-ord-instance",
      inscriptionIds: snapshot.publications.map((p) => p.id),
      ownership: { ...snapshot.ownership, satpoint: hash("a different location") + ":0:0" },
    },
  });
  expect(result.status).toBe("inconsistent-evidence");
  expect("state" in result).toBe(false);
});

test("rejects malformed independent ownership evidence rather than ignoring it", () => {
  const snapshot = observations(fixtures.cases[0]);
  const result = resolveSat(snapshot, {
    independentEnumeration: {
      source: "second-ord-instance",
      inscriptionIds: snapshot.publications.map((p) => p.id),
      // @ts-expect-error deliberately malformed for the test
      ownership: { owner: "A" },
    },
  });
  expect(result.status).toBe("incomplete");
});

test("cross-checks ownership when independent evidence reports the same satpoint in a different hex case", () => {
  const snapshot = observations(fixtures.cases[0]);
  const [txid, vout, offset] = (snapshot.ownership.satpoint as string).split(":");
  const result = resolveSat(snapshot, {
    independentEnumeration: {
      source: "second-ord-instance",
      inscriptionIds: snapshot.publications.map((p) => p.id),
      ownership: {
        ...snapshot.ownership,
        satpoint: `${txid.toUpperCase()}:${vout}:${offset}`,
      },
    },
  });
  expect(result.status).toBe("accepted");
  if (result.status === "accepted")
    expect(result.ownershipAssurance).toBe("cross-checked");
});

test("normalizeSatpoint lowercases only the txid component and passes through null/malformed values", () => {
  expect(normalizeSatpoint(null)).toBeNull();
  expect(normalizeSatpoint("AB".repeat(32) + ":0:0")).toBe("ab".repeat(32) + ":0:0");
  expect(normalizeSatpoint("ab".repeat(32) + ":3:12")).toBe("ab".repeat(32) + ":3:12");
  // Not the expected <txid>:<vout>:<offset> shape: returned unchanged rather than coerced.
  expect(normalizeSatpoint("not-a-satpoint")).toBe("not-a-satpoint");
  const nonHexTxid = "gg" + "ab".repeat(31) + ":0:0";
  expect(normalizeSatpoint(nonHexTxid)).toBe(nonHexTxid);
});

test("normalizeInscriptionId lowercases the txid and separator and passes through malformed values (#808)", () => {
  expect(normalizeInscriptionId("AB".repeat(32) + "i0")).toBe("ab".repeat(32) + "i0");
  expect(normalizeInscriptionId("AB".repeat(32) + "I12")).toBe("ab".repeat(32) + "i12");
  expect(normalizeInscriptionId("ab".repeat(32) + "i0")).toBe("ab".repeat(32) + "i0");
  // Not the expected <txid>i<index> shape: returned unchanged rather than coerced.
  expect(normalizeInscriptionId("not-an-inscription-id")).toBe("not-an-inscription-id");
  const nonHexTxid = "gg" + "ab".repeat(31) + "i0";
  expect(normalizeInscriptionId(nonHexTxid)).toBe(nonHexTxid);
});

test("does not accept conflicting confirmed and pending records for one inscription", () => {
  const snapshot = observations(fixtures.cases[0]);
  snapshot.publications.push({ ...snapshot.publications[0], confirmed: false });
  expect(resolveSat(snapshot).status).toBe("inconsistent-evidence");
});

test("reports pending, not not-found, when every observed publication is still unconfirmed", () => {
  const snapshot = observations(fixtures.cases[0]);
  for (const publication of snapshot.publications) publication.confirmed = false;
  const result = resolveSat(snapshot);
  expect(result.status).toBe("pending");
  if (result.status === "pending")
    expect(result.pending).toEqual(snapshot.publications.map((p) => p.id));
});

test("a sat with no observed publications at all is still not-found, not pending", () => {
  const snapshot = observations(fixtures.cases[0]);
  snapshot.publications = [];
  expect(resolveSat(snapshot).status).toBe("not-found");
});

test("an invalid confirmed boundary stays not-found even alongside an unrelated pending publication", () => {
  const scenario = fixtures.cases.find(
    (c) => c.id === "migration-from-must-match-current-alias",
  )!;
  const snapshot = observations(scenario);
  snapshot.publications.push({ ...snapshot.publications[0], confirmed: false, id: "a".repeat(64) + "i9", revealTxid: "a".repeat(64) });
  const result = resolveSat(snapshot);
  expect(result.status).toBe("not-found");
});

test("chain evidence defaults to provider-asserted when the snapshot omits it", () => {
  const result = resolveSat(observations(fixtures.cases[0]));
  expect(result.status).toBe("accepted");
  if (result.status === "accepted")
    expect(result.chainEvidence).toEqual({ assurance: "provider-asserted" });
});

test("an ordinary snapshot cannot self-assert independent validation", () => {
  const snapshot = observations(fixtures.cases[0]);
  snapshot.chainEvidence = { assurance: "node-validated", source: "core.example" };
  const result = resolveSat(snapshot);
  expect(result.status).toBe("accepted");
  if (result.status === "accepted")
    expect(result.chainEvidence).toEqual({ assurance: "provider-asserted" });
});

test("chain evidence never upgrades an unrecognized assurance value to node-validated", () => {
  const snapshot = observations(fixtures.cases[0]);
  // @ts-expect-error deliberately malformed provider input
  snapshot.chainEvidence = { assurance: "fabricated" };
  expect(resolveSat(snapshot).status).toBe("invalid");
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

test.each([
  { id: 'a', mediaType: 'application/octet-stream', expected: 'referenced' },
  { id: 'b', mediaType: 'text/plain', expected: 'bitcoin-inline' },
])('current availability follows accepted media type and digest: $id/$mediaType', async ({ id, mediaType, expected }) => {
  const a = new TextEncoder().encode('shared A content');
  const b = new TextEncoder().encode('different B content');
  const { log, afterBtco } = await twoResourceBoundary(a, b);
  const update = await signEvent({ previousEvent: afterBtco.state.head, operation: { type: 'update', data: {
    profile: 'originals/cel/3', resources: [{ id, mediaType, digestMultibase: digestBytes(a),
      previousDigestMultibase: digestBytes(id === 'a' ? a : b) }],
  } } }, A);
  const delta = { ...publicationAt([update], new Uint8Array(), 'text/plain'),
    id: 'e'.repeat(64) + 'i0', revealTxid: 'e'.repeat(64),
    creation: { height: 201, blockHash: 'f'.repeat(64), transactionIndex: 0, inscriptionIndex: 0 } };
  const tip = { height: 201, hash: 'f'.repeat(64) };
  const result = resolveSat({ ...emptySnapshot(), tipBefore: tip, tipAfter: tip, indexTip: tip,
    blocks: [...emptySnapshot().blocks, { height: 201, hash: tip.hash, txids: ['e'.repeat(64)] }],
    publications: [publicationAt(log, a, 'text/plain'), delta] });
  expect(result.status).toBe('accepted');
  if (result.status !== 'accepted') throw new Error(result.status);
  expect(result.resourceAvailability.find(resource => resource.id === id)?.availability).toBe(expected);
});

// #686: a recognized-but-unimplemented CCG shape chained onto a valid boundary must be
// reported as `unsupported-capability`, never silently ignored/dropped as though it were
// an invalid or unrelated candidate — resolveSat must not report a stale head as `accepted`
// while a real, uninspectable continuation sits on the same sat.
function unsupportedCapabilityDelta(
  boundaryLog: unknown[],
  boundaryResource: Uint8Array,
  rawDocument: unknown,
): SatSnapshot["publications"] {
  const delta: SatSnapshot["publications"][number] = {
    id: "e".repeat(64) + "i0",
    revealTxid: "e".repeat(64),
    network: "regtest",
    sat,
    confirmed: true,
    creation: {
      height: 201,
      blockHash: "f".repeat(64),
      transactionIndex: 0,
      inscriptionIndex: 0,
    },
    body: {
      status: "complete",
      mediaType: "application/cel",
      bytes: encodeValue(rawDocument, "json"),
      metadata: null,
    },
  };
  return [publicationAt(boundaryLog, boundaryResource, "text/plain"), delta];
}

function unsupportedCapabilitySnapshot(
  publications: SatSnapshot["publications"],
): SatSnapshot {
  const tip = { height: 201, hash: "f".repeat(64) };
  return {
    ...emptySnapshot(),
    tipBefore: tip,
    tipAfter: tip,
    indexTip: tip,
    blocks: [
      ...emptySnapshot().blocks,
      { height: 201, hash: tip.hash, txids: ["e".repeat(64)] },
    ],
    publications,
  };
}

// Signs a raw, unvalidated event directly (bypassing signEvent's validateEvent call),
// since eventShape/validateDocument reject dataReference/previousLog shapes outright —
// there is no other way to produce a genuinely authenticated proof over such an event.
async function signRawEvent(
  event: unknown,
  signer: CelSigner,
): Promise<{
  type: "DataIntegrityProof";
  cryptosuite: string;
  verificationMethod: string;
  proofPurpose: "assertionMethod";
  proofValue: string;
}> {
  const key = decodeController(signer.controller);
  const configuration = {
    type: "DataIntegrityProof" as const,
    cryptosuite: key.algorithm === "Ed25519" ? "eddsa-jcs-2022" : "ecdsa-jcs-2019",
    verificationMethod: key.verificationMethod,
    proofPurpose: "assertionMethod" as const,
  };
  const signature = await signer.sign(
    jcsSigningMessage(event, configuration, signer.algorithm),
  );
  return { ...configuration, proofValue: "z" + base58.encode(signature) };
}

// #686 review follow-up: dataReference/previousLog are rejected by eventShape/
// validateDocument before any proof is ever inspected — unlike CEL_WEBVH_IDNA, which can
// only be thrown after the entry's signature and controller authority have already been
// checked inside apply(). So an `unsupported-capability` result must itself require a
// genuine signature from the currently accepted controller, never just a raw,
// unauthenticated `previousEvent` string claiming to match the head.
test("resolveSat reports unsupported-capability for a chained CCG dataReference continuation genuinely authenticated by the current controller (#686)", async () => {
  const resourceA = new TextEncoder().encode("resource A bytes"),
    resourceB = new TextEncoder().encode("resource B bytes");
  const { log, afterBtco } = await twoResourceBoundary(resourceA, resourceB);
  const event = {
    previousEvent: afterBtco.state.head,
    operation: {
      type: "update",
      dataReference: {
        digestMultibase: digestBytes(
          new TextEncoder().encode("off-chain content"),
        ),
        mediaType: "text/plain",
      },
    },
  };
  const dataReferenceEntry = { event, proof: [await signRawEvent(event, A)] };
  const result = resolveSat(
    unsupportedCapabilitySnapshot(
      unsupportedCapabilityDelta(log, resourceA, { log: [dataReferenceEntry] }),
    ),
  );
  expect(result.status).toBe("unsupported-capability");
  if (result.status !== "unsupported-capability") throw new Error(result.status);
  expect(result.reason).toBe("CEL_DATA_REFERENCE");
});

// The permission-less-DoS case this fix closes: an attacker with no controller key at all
// can still make previousEvent match the accepted head, but an empty proof array can never
// authenticate that claim, so it must be exactly as ignorable as any other invalid
// candidate rather than permanently blocking resolution of a real Original.
test("resolveSat ignores an unauthenticated CCG dataReference candidate that merely claims to extend the head, rather than blocking resolution (#686 review follow-up)", async () => {
  const resourceA = new TextEncoder().encode("resource A bytes"),
    resourceB = new TextEncoder().encode("resource B bytes");
  const { log, afterBtco } = await twoResourceBoundary(resourceA, resourceB);
  const unauthenticatedDataReferenceEntry = {
    event: {
      previousEvent: afterBtco.state.head,
      operation: {
        type: "update",
        dataReference: {
          digestMultibase: digestBytes(
            new TextEncoder().encode("forged off-chain content"),
          ),
          mediaType: "text/plain",
        },
      },
    },
    proof: [],
  };
  const result = resolveSat(
    unsupportedCapabilitySnapshot(
      unsupportedCapabilityDelta(log, resourceA, {
        log: [unauthenticatedDataReferenceEntry],
      }),
    ),
  );
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") throw new Error(result.status);
  expect(result.state.head).toBe(afterBtco.state.head);
  expect(result.diagnostics).toContainEqual({
    inscriptionId: "e".repeat(64) + "i0",
    code: "CEL_DATA_REFERENCE",
  });
});

// A candidate can be validly signed and still not be authenticated: a signature from any
// key other than the sat's current controller must remain ignorable, exactly like an
// empty/missing proof, never treated as an uninspectable capability block.
test("resolveSat ignores a CCG dataReference candidate signed by a key other than the current controller, rather than blocking resolution (#686 review follow-up)", async () => {
  const resourceA = new TextEncoder().encode("resource A bytes"),
    resourceB = new TextEncoder().encode("resource B bytes");
  const { log, afterBtco } = await twoResourceBoundary(resourceA, resourceB);
  const impostor = createLocalSigner("Ed25519", new Uint8Array(32).fill(7));
  const event = {
    previousEvent: afterBtco.state.head,
    operation: {
      type: "update",
      dataReference: {
        digestMultibase: digestBytes(
          new TextEncoder().encode("forged off-chain content"),
        ),
        mediaType: "text/plain",
      },
    },
  };
  const wrongControllerEntry = {
    event,
    proof: [await signRawEvent(event, impostor)],
  };
  const result = resolveSat(
    unsupportedCapabilitySnapshot(
      unsupportedCapabilityDelta(log, resourceA, {
        log: [wrongControllerEntry],
      }),
    ),
  );
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") throw new Error(result.status);
  expect(result.state.head).toBe(afterBtco.state.head);
  expect(result.diagnostics).toContainEqual({
    inscriptionId: "e".repeat(64) + "i0",
    code: "CEL_DATA_REFERENCE",
  });
});

// The exact multi-entry attack found in review: `validateDocument` shape-checks every log
// entry, so the entry that actually throws the unsupported-shape error may be any later
// entry appended after a genuinely controller-signed one — a proof signs only its own
// event, never the whole log. A real signed first entry must not make the candidate as a
// whole "authenticated"; the offending entry itself still needs its own genuine signature.
test("resolveSat ignores a CCG dataReference candidate appended, unsigned, after a genuinely controller-signed entry (#686 review follow-up)", async () => {
  const resourceA = new TextEncoder().encode("resource A bytes"),
    resourceB = new TextEncoder().encode("resource B bytes");
  const { log, afterBtco } = await twoResourceBoundary(resourceA, resourceB);
  const signedUpdate = await signEvent(
    {
      previousEvent: afterBtco.state.head,
      operation: {
        type: "update",
        data: { profile: "originals/cel/3", metadata: { note: "real" } },
      },
    },
    A,
  );
  const unsignedDataReferenceEntry = {
    event: {
      previousEvent: eventDigest(signedUpdate.event),
      operation: {
        type: "update",
        dataReference: {
          digestMultibase: digestBytes(
            new TextEncoder().encode("forged off-chain content"),
          ),
          mediaType: "text/plain",
        },
      },
    },
    proof: [],
  };
  const result = resolveSat(
    unsupportedCapabilitySnapshot(
      unsupportedCapabilityDelta(log, resourceA, {
        log: [signedUpdate, unsignedDataReferenceEntry],
      }),
    ),
  );
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") throw new Error(result.status);
  expect(result.state.head).toBe(afterBtco.state.head);
  expect(result.diagnostics).toContainEqual({
    inscriptionId: "e".repeat(64) + "i0",
    code: "CEL_DATA_REFERENCE",
  });
});

// Positive counterpart: when the entry before the offending one AND the offending entry
// itself are both genuinely signed by the current controller, the candidate really is an
// authenticated attempt to extend the head with an unsupported shape, and must still
// report unsupported-capability rather than being silently (and now incorrectly) ignored.
test("resolveSat reports unsupported-capability when a genuinely controller-signed entry is followed by an equally authenticated CCG dataReference entry (#686 review follow-up)", async () => {
  const resourceA = new TextEncoder().encode("resource A bytes"),
    resourceB = new TextEncoder().encode("resource B bytes");
  const { log, afterBtco } = await twoResourceBoundary(resourceA, resourceB);
  const signedUpdate = await signEvent(
    {
      previousEvent: afterBtco.state.head,
      operation: {
        type: "update",
        data: { profile: "originals/cel/3", metadata: { note: "real" } },
      },
    },
    A,
  );
  const dataReferenceEvent = {
    previousEvent: eventDigest(signedUpdate.event),
    operation: {
      type: "update",
      dataReference: {
        digestMultibase: digestBytes(
          new TextEncoder().encode("off-chain content"),
        ),
        mediaType: "text/plain",
      },
    },
  };
  const signedDataReferenceEntry = {
    event: dataReferenceEvent,
    proof: [await signRawEvent(dataReferenceEvent, A)],
  };
  const result = resolveSat(
    unsupportedCapabilitySnapshot(
      unsupportedCapabilityDelta(log, resourceA, {
        log: [signedUpdate, signedDataReferenceEntry],
      }),
    ),
  );
  expect(result.status).toBe("unsupported-capability");
  if (result.status !== "unsupported-capability") throw new Error(result.status);
  expect(result.reason).toBe("CEL_DATA_REFERENCE");
});

// previousLog is always ignorable, even when its wrapped log is genuinely signed by the
// current controller: unlike dataReference (embedded inside the signed operation) or
// CEL_WEBVH_IDNA (reachable only after full signature authentication), the previousLog
// wrapper sits entirely outside any signed event and its own proof has no CCG-specified
// target. Authenticating only the wrapped log would not establish that the controller
// authorized the *wrapping* — anyone can wrap a copy of any log, controller-signed or not,
// in a previousLog envelope, which would let a permissionless observer flip a resolution
// from accepted to unsupported-capability at will. So resolveSat never blocks on
// CEL_PREVIOUS_LOG, regardless of what the wrapped log itself contains.
test("resolveSat ignores a chained CCG previousLog continuation even when its wrapped log is genuinely controller-signed, rather than blocking resolution (#686 review follow-up)", async () => {
  const resourceA = new TextEncoder().encode("resource A bytes"),
    resourceB = new TextEncoder().encode("resource B bytes");
  const { log, afterBtco } = await twoResourceBoundary(resourceA, resourceB);
  const update = await signEvent(
    {
      previousEvent: afterBtco.state.head,
      operation: {
        type: "update",
        data: { profile: "originals/cel/3", metadata: { note: "chained" } },
      },
    },
    A,
  );
  const previousLogDoc = {
    log: [update],
    previousLog: {
      digestMultibase: digestBytes(new TextEncoder().encode("earlier log bytes")),
      proof: [
        {
          type: "DataIntegrityProof",
          cryptosuite: "eddsa-jcs-2022",
          verificationMethod: "placeholder-verification-method",
          proofPurpose: "assertionMethod",
          proofValue: "placeholder-proof-value",
        },
      ],
    },
  };
  const result = resolveSat(
    unsupportedCapabilitySnapshot(
      unsupportedCapabilityDelta(log, resourceA, previousLogDoc),
    ),
  );
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") throw new Error(result.status);
  expect(result.state.head).toBe(afterBtco.state.head);
  expect(result.diagnostics).toContainEqual({
    inscriptionId: "e".repeat(64) + "i0",
    code: "CEL_PREVIOUS_LOG",
  });
});

// Same outcome with a wrapped entry signed by a key other than the current controller,
// confirming previousLog's ignorability does not depend on the wrapped log's signer.
test("resolveSat ignores a CCG previousLog candidate whose inner entry is not signed by the current controller, rather than blocking resolution (#686 review follow-up)", async () => {
  const resourceA = new TextEncoder().encode("resource A bytes"),
    resourceB = new TextEncoder().encode("resource B bytes");
  const { log, afterBtco } = await twoResourceBoundary(resourceA, resourceB);
  const impostor = createLocalSigner("Ed25519", new Uint8Array(32).fill(7));
  const update = await signEvent(
    {
      previousEvent: afterBtco.state.head,
      operation: {
        type: "update",
        data: { profile: "originals/cel/3", metadata: { note: "forged" } },
      },
    },
    impostor,
  );
  const previousLogDoc = {
    log: [update],
    previousLog: {
      digestMultibase: digestBytes(new TextEncoder().encode("earlier log bytes")),
      proof: [
        {
          type: "DataIntegrityProof",
          cryptosuite: "eddsa-jcs-2022",
          verificationMethod: "placeholder-verification-method",
          proofPurpose: "assertionMethod",
          proofValue: "placeholder-proof-value",
        },
      ],
    },
  };
  const result = resolveSat(
    unsupportedCapabilitySnapshot(
      unsupportedCapabilityDelta(log, resourceA, previousLogDoc),
    ),
  );
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") throw new Error(result.status);
  expect(result.state.head).toBe(afterBtco.state.head);
  expect(result.diagnostics).toContainEqual({
    inscriptionId: "e".repeat(64) + "i0",
    code: "CEL_PREVIOUS_LOG",
  });
});

// Negative control: a disallowed/unrelated profile on the same sat is fully inspected and
// intentionally rejected material, not a recognized-but-unimplemented CCG shape — it must
// remain ignorable and must never poison an otherwise valid accepted history the way an
// unsupported-capability result does.
test("resolveSat still treats a disallowed profile as ignorable, not unsupported-capability, on the same sat (#686)", async () => {
  const resourceA = new TextEncoder().encode("resource A bytes"),
    resourceB = new TextEncoder().encode("resource B bytes");
  const { log, afterBtco } = await twoResourceBoundary(resourceA, resourceB);
  const disallowedProfileEntry = {
    event: {
      previousEvent: afterBtco.state.head,
      operation: { type: "update", data: { profile: "not-originals/cel/3" } },
    },
    proof: [],
  };
  const result = resolveSat(
    unsupportedCapabilitySnapshot(
      unsupportedCapabilityDelta(log, resourceA, {
        log: [disallowedProfileEntry],
      }),
    ),
  );
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") throw new Error(result.status);
  expect(result.state.head).toBe(afterBtco.state.head);
  expect(result.diagnostics).toContainEqual({
    inscriptionId: "e".repeat(64) + "i0",
    code: "CEL_PROFILE",
  });
});

// An unrelated/non-extending confirmed inscription carrying a recognized-but-unimplemented
// CCG shape must not be able to block resolution of an otherwise valid, already-accepted
// history just by sharing the sat — Bitcoin possession never restores or grants CEL
// authority, so a later, unrelated holder inscribing arbitrary dataReference/previousLog
// bytes on the same sat must be exactly as ignorable as any other non-extending candidate.
test("resolveSat ignores an unrelated CCG dataReference candidate that does not extend the accepted head, rather than blocking resolution (#686 review follow-up)", async () => {
  const resourceA = new TextEncoder().encode("resource A bytes"),
    resourceB = new TextEncoder().encode("resource B bytes");
  const { log, afterBtco } = await twoResourceBoundary(resourceA, resourceB);
  const unrelatedDataReferenceEntry = {
    event: {
      previousEvent: digestBytes(new TextEncoder().encode("unrelated history head")),
      operation: {
        type: "update",
        dataReference: {
          digestMultibase: digestBytes(
            new TextEncoder().encode("unrelated off-chain content"),
          ),
          mediaType: "text/plain",
        },
      },
    },
    proof: [],
  };
  const result = resolveSat(
    unsupportedCapabilitySnapshot(
      unsupportedCapabilityDelta(log, resourceA, {
        log: [unrelatedDataReferenceEntry],
      }),
    ),
  );
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") throw new Error(result.status);
  expect(result.state.head).toBe(afterBtco.state.head);
  expect(result.diagnostics).toContainEqual({
    inscriptionId: "e".repeat(64) + "i0",
    code: "CEL_DATA_REFERENCE",
  });
});
