import { expect, test } from "bun:test";
import corpus from "../../../../docs/research/cel-profile-vectors/profile-documents.json";
import {
  parseDocument,
  verifyEntry,
  encodeDocument,
  validateDocument,
  CelError,
} from "../../src/v3/index.js";

for (const vector of corpus.accepted)
  test(`reference representation and proofs: ${vector.id}`, () => {
    for (const document of [
      parseDocument(JSON.stringify(vector.document), "json"),
      parseDocument(new Uint8Array(Buffer.from(vector.cborHex, "hex")), "cbor"),
    ]) {
      expect(document).toEqual(vector.document);
      for (const [index, entry] of document.log.entries())
        expect(verifyEntry(entry).digest).toBe(
          vector.expected.entries[index][0].eventDigest,
        );
    }
    if (vector.id !== "single-proof-object")
      expect(
        Buffer.from(encodeDocument(vector.document, "cbor")).toString("hex"),
      ).toBe(vector.cborHex);
  });

test("recognizes CCG reference and previousLog shapes as unsupported application features", () => {
  const entry = corpus.accepted[0].document.log[0];
  const reference = {
    digestMultibase: corpus.accepted[0].expected.head,
    url: ["https://example.com/log.cel"],
  };
  const ccg = [
    {
      log: [
        {
          event: { operation: { type: "create", dataReference: reference } },
          proof: entry.proof,
        },
      ],
    },
    { log: [entry], previousLog: { ...reference, proof: entry.proof } },
  ];
  for (const value of ccg) {
    try {
      validateDocument(value);
      throw new Error("unexpected acceptance");
    } catch (error) {
      expect(error).toBeInstanceOf(CelError);
      expect((error as CelError).status).toBe("unsupported");
    }
  }
});

for (const vector of corpus.rejected.filter(
  (v) =>
    ![
      "valid-signature-wrong-chain-link",
      "valid-log-wrong-requested-DID",
    ].includes(v.id),
))
  test(`rejects profile/proof case: ${vector.id}`, () => {
    expect(() =>
      parseDocument(JSON.stringify(vector.document), "json").log.forEach(
        verifyEntry,
      ),
    ).toThrow();
  });

test("authenticates the saved Ed25519 creation and derives its identity from the event", () => {
  const vector = corpus.accepted[0];
  const document = parseDocument(JSON.stringify(vector.document), "json");
  const result = verifyEntry(document.log[0]);
  expect(result.digest).toBe(vector.expected.head);
  expect(result.signers).toEqual([
    vector.document.log[0].event.operation.data.controller,
  ]);
  expect(Buffer.from(encodeDocument(document, "cbor")).toString("hex")).toBe(
    vector.cborHex,
  );
});

test("CCG reference recognition does not inherit resource URL count limits", () => {
  const entry = corpus.accepted[0].document.log[0];
  const reference = {
    digestMultibase: corpus.accepted[0].expected.head,
    url: Array.from({ length: 17 }, (_, i) => `https://example.com/${i}`),
  };
  for (const document of [
    {
      log: [
        {
          event: { operation: { type: "create", dataReference: reference } },
          proof: entry.proof,
        },
      ],
    },
    { log: [entry], previousLog: { ...reference, proof: entry.proof } },
  ]) {
    try {
      validateDocument(document);
      throw new Error("unexpected acceptance");
    } catch (error) {
      expect(error).toBeInstanceOf(CelError);
      expect((error as CelError).status).toBe("unsupported");
    }
  }
});
