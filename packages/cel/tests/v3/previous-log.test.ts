import { expect, test } from "bun:test";
import corpus from "../../../../docs/research/cel-profile-vectors/profile-documents.json";
import {
  CelError,
  parseDocument,
  validateDocument,
} from "../../src/v3/index.js";
import { encodeValue } from "../../src/v3/values.js";

const entry = corpus.accepted[0].document.log[0];
const proof = Array.isArray(entry.proof) ? entry.proof[0] : entry.proof;
const previousLog = {
  digestMultibase: corpus.accepted[0].expected.head,
  proof,
};
const malformedEntry = {
  event: { operation: { type: "bogus-unrecognized-op" } },
  proof: [],
};

function expectRejection(input: unknown, status: string, code?: string): void {
  // Exercise the runtime and both transport boundaries with the same JSON data.
  for (const validate of [
    () => validateDocument(input),
    () => parseDocument(JSON.stringify(input), "json"),
    () => parseDocument(encodeValue(input, "cbor"), "cbor"),
  ]) {
    let caught: unknown;
    try {
      validate();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CelError);
    expect((caught as CelError).status).toBe(status);
    if (code) expect((caught as CelError).code).toBe(code);
  }
}

for (const [name, log] of [
  ["valid Originals entry", [entry]],
  ["malformed operation", [malformedEntry]],
  ["malformed entry proof", [{ ...entry, proof: [] }]],
  ["non-object entry", [null]],
] as const) {
  test(`recognized previousLog takes precedence over ${name} (#878)`, () => {
    for (const previousProof of [proof, [proof]]) {
      expectRejection(
        { log, previousLog: { ...previousLog, proof: previousProof } },
        "unsupported",
        "CEL_PREVIOUS_LOG",
      );
    }
  });
}

const malformedReferences: [string, unknown][] = [
  ["null reference", null],
  ["missing digest", { proof }],
  ["invalid digest", { ...previousLog, digestMultibase: "not-a-digest" }],
  ["unknown member", { ...previousLog, extra: true }],
  ["empty media type", { ...previousLog, mediaType: "" }],
  ["empty URLs", { ...previousLog, url: [] }],
  ["relative URL", { ...previousLog, url: ["relative/log.cel"] }],
  ["missing proof", { digestMultibase: previousLog.digestMultibase }],
  ["empty proofs", { ...previousLog, proof: [] }],
  ["null proof", { ...previousLog, proof: null }],
  ["wrong proof type", { ...previousLog, proof: { ...proof, type: "Other" } }],
  ["mixed valid and invalid proofs", { ...previousLog, proof: [proof, {}] }],
];
for (const key of [
  "cryptosuite",
  "verificationMethod",
  "proofPurpose",
  "proofValue",
]) {
  const missing: Record<string, unknown> = { ...proof };
  delete missing[key];
  malformedReferences.push(
    [`missing ${key}`, { ...previousLog, proof: missing }],
    [`empty ${key}`, { ...previousLog, proof: { ...proof, [key]: "" } }],
    [`non-string ${key}`, { ...previousLog, proof: { ...proof, [key]: 1 } }],
  );
}
for (const [name, reference] of malformedReferences) {
  test(`malformed previousLog remains invalid: ${name}`, () => {
    for (const log of [[entry], [malformedEntry]])
      expectRejection({ log, previousLog: reference }, "invalid");
  });
}

for (const [name, document] of [
  ["missing log", { previousLog }],
  ["non-array log", { log: {}, previousLog }],
  ["empty log", { log: [], previousLog }],
  ["unknown outer member", { log: [entry], previousLog, extra: true }],
] as const) {
  test(`previousLog does not bypass outer structure: ${name}`, () => {
    expectRejection(document, "invalid");
  });
}

test("previousLog does not bypass the entry-count limit", () => {
  expectRejection(
    { log: Array(10001).fill(null), previousLog },
    "invalid",
    "CEL_LOG",
  );
});

test("previousLog does not bypass plain JSON input validation", () => {
  let accessed = false;
  expect(() =>
    validateDocument({
      log: [
        {
          get event() {
            accessed = true;
            return {};
          },
        },
      ],
      previousLog,
    }),
  ).toThrow(CelError);
  expect(accessed).toBe(false);
});

test("malformed Originals entries remain invalid without previousLog", () => {
  expectRejection({ log: [malformedEntry] }, "invalid", "CEL_FIELDS");
  expectRejection({ log: [{ ...entry, proof: [] }] }, "invalid", "CEL_PROOFS");
  expect(validateDocument({ log: [entry] }).log).toEqual([entry]);
});
