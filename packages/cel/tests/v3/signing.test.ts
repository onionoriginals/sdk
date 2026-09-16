import { expect, test } from "bun:test";
import {
  CelError,
  createLocalSigner,
  jcsSigningMessage,
  signEvent,
  verifyEntry,
  verifyJcsSignature,
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

test("jcsSigningMessage, createLocalSigner, and signEvent report the same FailureStatus for an unsupported algorithm (#700)", async () => {
  const catchStatus = (fn: () => unknown) => {
    try {
      fn();
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CelError);
      return (e as CelError).status;
    }
  };

  const fromMessage = catchStatus(() =>
    jcsSigningMessage({}, {}, "secp256k1" as Algorithm),
  );
  const fromLocalSigner = catchStatus(() =>
    createLocalSigner("secp256k1" as Algorithm, new Uint8Array(32).fill(7)),
  );

  expect(fromMessage).toBe("unsupported");
  expect(fromLocalSigner).toBe("unsupported");
  expect(fromMessage).toBe(fromLocalSigner);

  const signer = createLocalSigner("Ed25519", new Uint8Array(32).fill(7));
  await expect(
    signEvent(corpus.accepted[0].document.log[0].event, {
      ...signer,
      algorithm: "secp256k1" as Algorithm,
    }),
  ).rejects.toMatchObject({ status: "unsupported", code: "CEL_ALGORITHM" });
});

for (const [algorithm, secretSize, size] of [
  ["Ed25519", 32, 64],
  ["P-256", 32, 64],
  ["P-384", 48, 96],
] as const)
  test(`verifyJcsSignature rejects a wrong-length ${algorithm} signature as a CelError instead of throwing a raw RangeError (#725)`, () => {
    const signer = createLocalSigner(algorithm, new Uint8Array(secretSize).fill(9));
    const document = corpus.accepted[0].document.log[0].event;
    const configuration = {
      type: "DataIntegrityProof",
      cryptosuite: "unused",
      verificationMethod: `${signer.controller}#key`,
      proofPurpose: "assertionMethod",
      created: "2026-09-05T00:00:00.000Z",
    };

    for (const wrongLength of [size - 1, size + 1, 0]) {
      let threw: unknown;
      try {
        verifyJcsSignature(
          document,
          configuration,
          new Uint8Array(wrongLength),
          signer.controller,
        );
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeInstanceOf(CelError);
      expect(threw).toMatchObject({ status: "invalid", code: "CEL_SIGNATURE" });
    }

    // A correctly-shaped but cryptographically wrong signature still just
    // returns false rather than throwing.
    expect(
      verifyJcsSignature(
        document,
        configuration,
        new Uint8Array(size).fill(1),
        signer.controller,
      ),
    ).toBe(false);
  });
