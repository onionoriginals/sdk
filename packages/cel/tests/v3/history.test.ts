import { expect, test } from "bun:test";
import {
  verifyHistory,
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
