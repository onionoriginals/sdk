import { expect, test } from "bun:test";
import {
  verifyHistory,
  checkpointFromHistory,
  createLocalSigner,
  signEvent,
} from "../../src/v3/index.js";
import corpus from "../../../../docs/research/cel-profile-vectors/profile-documents.json";
const genesis = corpus.accepted[0].document.log[0];
const A = createLocalSigner(
  "Ed25519",
  new Uint8Array(
    Buffer.from(
      "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
      "hex",
    ),
  ),
);
const B = createLocalSigner("P-256", new Uint8Array(32).fill(7));
const profile = "originals/cel/3";

test("rotation retires A, keeps historical signatures valid and requires B for the next entry", async () => {
  const initial = verifyHistory({ log: [genesis] });
  const rotation = await signEvent(
    {
      previousEvent: initial.state.head,
      operation: {
        type: "rotateKey",
        data: {
          profile,
          newController: B.controller,
          rotatedAt: "2026-09-05T00:00:00Z",
        },
      },
    },
    A,
  );
  const rotated = verifyHistory({ log: [rotation] }, { prefix: initial });
  expect(rotated.state.controller).toBe(B.controller);
  expect(initial.state.controller).toBe(A.controller);
  const event = {
    previousEvent: rotated.state.head,
    operation: { type: "update", data: { profile, name: "Updated" } },
  };
  expect(() =>
    verifyHistory({ log: [rotation] }, { prefix: structuredClone(initial) }),
  ).toThrow();
  const retired = await signEvent(event, A);
  expect(() =>
    verifyHistory({ log: [retired] }, { prefix: rotated }),
  ).toThrow();
  const updated = await signEvent(event, B);
  const result = verifyHistory({ log: [genesis, rotation, updated] });
  expect(result.state.name).toBe("Updated");
  expect(result.state.controllers).toEqual([
    { controller: A.controller, fromEntry: 0, throughEntry: 1 },
    { controller: B.controller, fromEntry: 2 },
  ]);
});

for (const id of [
  "valid-signature-wrong-chain-link",
  "valid-log-wrong-requested-DID",
])
  test(`history rejects ${id}`, () => {
    const vector = corpus.rejected.find((v) => v.id === id)!;
    expect(() =>
      verifyHistory(vector.document, {
        expectedDid:
          "expectedDid" in vector ? (vector.expectedDid as string) : undefined,
      }),
    ).toThrow();
  });

test("a first-time verifier with no checkpoint gets authenticated-history freshness only", () => {
  const result = verifyHistory({ log: [genesis] });
  expect(result.freshness).toBe("unknown");
});

test("checkpointFromHistory is a portable claim a different call can independently confirm", async () => {
  const initial = verifyHistory({ log: [genesis] });
  const checkpoint = checkpointFromHistory(initial);
  expect(checkpoint).toEqual({
    assetId: initial.state.assetId,
    head: initial.state.head,
    entryCount: initial.state.entryCount,
  });

  // A fresh, unrelated verifyHistory call - not the same object, no WeakSet membership -
  // still confirms the checkpoint equals the presented history.
  const same = verifyHistory({ log: [genesis] }, { checkpoint });
  expect(same.freshness).toBe("checkpoint-consistent");

  // Extending past a checkpoint is also consistent.
  const rotation = await signEvent(
    {
      previousEvent: initial.state.head,
      operation: {
        type: "rotateKey",
        data: {
          profile,
          newController: B.controller,
          rotatedAt: "2026-09-05T00:00:00Z",
        },
      },
    },
    A,
  );
  const extended = verifyHistory({ log: [genesis, rotation] }, { checkpoint });
  expect(extended.freshness).toBe("checkpoint-consistent");
  expect(extended.state.controller).toBe(B.controller);

  // The same boundary check also holds chained through a same-process prefix.
  const chained = verifyHistory(
    { log: [rotation] },
    { prefix: initial, checkpoint },
  );
  expect(chained.freshness).toBe("checkpoint-consistent");
});

test("checkpoint consistency fails closed on wrong asset, rollback, or fork", async () => {
  const initial = verifyHistory({ log: [genesis] });
  const rotation = await signEvent(
    {
      previousEvent: initial.state.head,
      operation: {
        type: "rotateKey",
        data: {
          profile,
          newController: B.controller,
          rotatedAt: "2026-09-05T00:00:00Z",
        },
      },
    },
    A,
  );
  const rotated = verifyHistory({ log: [genesis, rotation] });
  const rotatedCheckpoint = checkpointFromHistory(rotated);

  // A checkpoint for a different asset never matches, valid-looking or not.
  expect(() =>
    verifyHistory(
      { log: [genesis] },
      {
        checkpoint: {
          assetId: "ni:///sha-256;" + "A".repeat(43),
          head: initial.state.head,
          entryCount: 1,
        },
      },
    ),
  ).toThrow();

  // A shorter presented history than a previously-observed checkpoint is a rollback.
  expect(() =>
    verifyHistory({ log: [genesis] }, { checkpoint: rotatedCheckpoint }),
  ).toThrow();

  // A different, equally-signed continuation from the same point at the same entry count
  // is an equivocation/fork the checkpoint must catch, not just a signature failure.
  const altEntry = await signEvent(
    {
      previousEvent: initial.state.head,
      operation: { type: "update", data: { profile, name: "Fork" } },
    },
    A,
  );
  expect(() =>
    verifyHistory(
      { log: [genesis, altEntry] },
      { checkpoint: rotatedCheckpoint },
    ),
  ).toThrow();
});
