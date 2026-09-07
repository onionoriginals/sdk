import { expect, test } from "bun:test";
import {
  createLocalSigner,
  signEvent,
  verifyEntry,
  type Algorithm,
} from "../../src/v3/index.js";
import corpus from "../../../../docs/research/cel-profile-vectors/profile-documents.json";
import { createPublicKey, verify } from "node:crypto";
import { base58 } from "@scure/base";
import { canonicalize } from "json-canonicalize";
import { createHash } from "node:crypto";

for (const [algorithm, size, spki, hash] of [
  ["Ed25519", 32, "302a300506032b6570032100", null],
  [
    "P-256",
    32,
    "3039301306072a8648ce3d020106082a8648ce3d030107032200",
    "sha256",
  ],
  ["P-384", 48, "3046301006072a8648ce3d020106052b81040022033200", "sha384"],
] as const)
  test(`writes ${algorithm} proofs accepted by independent Node/OpenSSL verification`, async () => {
    const signer = createLocalSigner(algorithm, new Uint8Array(size).fill(7));
    const event = structuredClone(corpus.accepted[0].document.log[0].event);
    event.operation.data.controller = signer.controller;
    const entry = await signEvent(event, signer, {
      created: "2026-09-05T00:00:00.000Z",
    });
    expect(verifyEntry(entry).signers).toEqual([signer.controller]);
    const { proofValue, ...configuration } = entry.proof[0];
    const message = Buffer.concat(
      [configuration, event].map((v) =>
        createHash(hash ?? "sha256")
          .update(canonicalize(v)!)
          .digest(),
      ),
    );
    const key = createPublicKey({
      format: "der",
      type: "spki",
      key: Buffer.concat([
        Buffer.from(spki, "hex"),
        base58.decode(signer.controller.slice(9)).slice(2),
      ]),
    });
    expect(
      verify(
        hash,
        message,
        { key, dsaEncoding: "ieee-p1363" },
        base58.decode(proofValue.slice(1)),
      ),
    ).toBe(true);
  });

test("an unsupported signer or failed signer cannot produce an unsigned successful entry", async () => {
  expect(() =>
    createLocalSigner("secp256k1" as Algorithm, new Uint8Array(32).fill(7)),
  ).toThrow();
  const signer = createLocalSigner("Ed25519", new Uint8Array(32).fill(7));
  await expect(
    signEvent(corpus.accepted[0].document.log[0].event, {
      ...signer,
      sign: async () => new Uint8Array(64),
    }),
  ).rejects.toThrow();
});
