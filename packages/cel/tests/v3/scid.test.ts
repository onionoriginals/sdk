import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { base58, base64urlnopad } from "@scure/base";
import {
  SCID_PLACEHOLDER,
  deriveScid,
  verifyScid,
  createLocalSigner,
  signEvent,
  canonicalizeValue,
  eventDigest,
  verifyHistory,
  assetDigest,
  validateEvent,
  encodeDocument,
  parseDocument,
  deriveAssetId,
  jcsSigningMessage,
  verifyJcsSignature,
  verifyEntry,
  validateDocument,
} from "../../src/v3/index.js";

const signer = createLocalSigner("Ed25519", new Uint8Array(32).fill(19));
const template = {
  previousEvent: SCID_PLACEHOLDER,
  operation: {
    type: "create" as const,
    data: {
      profile: "originals/cel/3" as const,
      controller: signer.controller,
      createdAt: "2026-09-05T00:00:00Z",
      nonce: "AAAAAAAAAAAAAAAAAAAAAA",
      resources: [],
      metadata: {
        literal: "{SCID}",
        nested: { previousEvent: "application value" },
      },
    },
  },
};

function published() {
  return { ...template, previousEvent: deriveScid(template) };
}

test("SCID is deterministic JCS UTF-8 SHA-256 in canonical u multibase/multihash", () => {
  const before = JSON.stringify(template);
  const scid = deriveScid(template);
  const reordered = {
    operation: template.operation,
    previousEvent: SCID_PLACEHOLDER,
  };
  expect(deriveScid(reordered)).toBe(scid);
  const bytes = base64urlnopad.decode(scid.slice(1));
  expect(scid[0]).toBe("u");
  expect([...bytes.slice(0, 2)]).toEqual([0x12, 0x20]);
  expect(bytes.length).toBe(34);
  expect(Buffer.from(bytes.slice(2))).toEqual(
    createHash("sha256").update(canonicalizeValue(template), "utf8").digest(),
  );
  expect(JSON.stringify(template)).toBe(before);
});

test("creation and verification substitute only genesis previousEvent", () => {
  const event = published();
  const before = JSON.stringify(event);
  expect(verifyScid(event, event.previousEvent)).toBe(true);
  expect(deriveScid(event)).toBe(deriveScid(template));
  expect(event.operation.data.metadata.literal).toBe(SCID_PLACEHOLDER);
  expect(JSON.stringify(event)).toBe(before);
  expect(verifyScid(template, event.previousEvent)).toBe(false);
  expect(() => validateEvent(template)).toThrow();
  expect(() => deriveScid({ operation: template.operation })).toThrow();
});

test("protected content binds genesis; substitution and tampering fail", () => {
  const a = published();
  const bTemplate = {
    ...template,
    operation: {
      ...template.operation,
      data: { ...template.operation.data, name: "History B" },
    },
  };
  const b = { ...bTemplate, previousEvent: deriveScid(bTemplate) };
  expect(a.previousEvent).not.toBe(b.previousEvent);
  expect(verifyScid(b, a.previousEvent)).toBe(false);
  expect(
    verifyScid({ ...b, previousEvent: a.previousEvent }, a.previousEvent),
  ).toBe(false);
  expect(
    verifyScid({ ...a, previousEvent: b.previousEvent }, a.previousEvent),
  ).toBe(false);
  expect(() =>
    validateEvent({ ...b, previousEvent: a.previousEvent }),
  ).toThrow();
  for (const expected of ["bad", a.previousEvent + "=", null])
    expect(verifyScid(a, expected)).toBe(false);
  expect(verifyScid({ ...a, extra: "uncommitted?" }, a.previousEvent)).toBe(
    false,
  );
  const nested = structuredClone(template);
  nested.operation.data.metadata.nested.previousEvent = SCID_PLACEHOLDER;
  expect(deriveScid(nested)).not.toBe(a.previousEvent);
});

test("external storage and transport do not affect SCID; committed URLs do", async () => {
  const entry = await signEvent(template, signer);
  const mirrors = [
    {
      url: "https://one.example/history",
      path: "/one",
      id: "db1",
      bytes: encodeDocument({ log: [entry] }, "json"),
      format: "json" as const,
    },
    {
      url: "ipfs://mirror",
      path: "/two",
      id: "db2",
      bytes: encodeDocument({ log: [entry] }, "cbor"),
      format: "cbor" as const,
    },
  ];
  for (const mirror of mirrors) {
    const document = parseDocument(mirror.bytes, mirror.format);
    expect(verifyScid(document.log[0].event, entry.event.previousEvent)).toBe(
      true,
    );
    expect(assetDigest(verifyHistory(document).state.assetId)).toBe(
      entry.event.previousEvent!,
    );
  }
  const withUrl = (url: string) => ({
    ...template,
    operation: {
      ...template.operation,
      data: { ...template.operation.data, metadata: { url } },
    },
  });
  expect(deriveScid(withUrl("https://one.example"))).not.toBe(
    deriveScid(withUrl("https://two.example")),
  );
});

test("signing substitutes before proof creation and chaining uses final event digest", async () => {
  const genesis = await signEvent(template, signer);
  const implicit = await signEvent({ operation: template.operation }, signer);
  expect(implicit.event).toEqual(genesis.event);
  const scid = genesis.event.previousEvent!;
  expect(verifyScid(genesis.event, scid)).toBe(true);
  const initial = verifyHistory({ log: [genesis] });
  expect(assetDigest(initial.state.assetId)).toBe(scid);
  expect(initial.state.head).toBe(eventDigest(genesis.event));
  expect(initial.state.head).not.toBe(scid);
  const update = (previousEvent: string) =>
    signEvent(
      {
        previousEvent,
        operation: {
          type: "update",
          data: { profile: "originals/cel/3", name: "updated" },
        },
      },
      signer,
    );
  const next = await update(initial.state.head);
  const complete = verifyHistory(
    { log: [genesis, next] },
    { expectedAssetId: initial.state.assetId },
  );
  expect(complete.state.assetId).toBe(initial.state.assetId);
  expect(complete.state.head).toBe(eventDigest(next.event));
  expect(() =>
    verifyHistory(
      { log: [genesis, next] },
      { expectedAssetId: "ni:///sha-256;" + "A".repeat(43) },
    ),
  ).toThrow();
  const wrongLink = await update(scid);
  expect(() => verifyHistory({ log: [genesis, wrongLink] })).toThrow();
  await expect(
    signEvent(
      {
        ...genesis.event,
        operation: {
          ...template.operation,
          data: { ...template.operation.data, name: "tampered" },
        },
      },
      signer,
    ),
  ).rejects.toThrow();
});

// Bypass signEvent's construction guards: an attacker controlling a valid key
// can sign arbitrary bytes. Verification must enforce SCID binding itself.
async function rawSigned(event: Parameters<typeof jcsSigningMessage>[0]) {
  const configuration = {
    type: "DataIntegrityProof" as const,
    cryptosuite: "eddsa-jcs-2022" as const,
    verificationMethod: signer.controller + "#" + signer.controller.slice(8),
    proofPurpose: "assertionMethod" as const,
  };
  const signature = await signer.sign(
    jcsSigningMessage(event, configuration, signer.algorithm),
  );
  expect(
    verifyJcsSignature(event, configuration, signature, signer.controller),
  ).toBe(true);
  return {
    event,
    proof: [{ ...configuration, proofValue: "z" + base58.encode(signature) }],
  };
}

test("valid controller signatures cannot override a false genesis SCID", async () => {
  const event = published();
  const expected = deriveAssetId(event);
  const tampered = {
    ...event,
    operation: {
      ...event.operation,
      data: { ...event.operation.data, name: "attacker change" },
    },
  };
  const forged = await rawSigned(tampered);
  expect(verifyScid(tampered, event.previousEvent)).toBe(false);
  expect(() => verifyEntry(forged)).toThrow("Genesis SCID");
  expect(() => validateDocument({ log: [forged] })).toThrow("Genesis SCID");
  expect(() =>
    verifyHistory({ log: [forged] }, { expectedAssetId: expected }),
  ).toThrow("Genesis SCID");
  expect(() =>
    parseDocument(JSON.stringify({ log: [forged] }), "json"),
  ).toThrow("Genesis SCID");
});

test("stripping and re-signing SCID cannot downgrade a pinned history to legacy identity", async () => {
  const event = published();
  const expected = deriveAssetId(event);
  const stripped = await rawSigned({ operation: event.operation });
  // Legacy compatibility is deliberate, but it must yield a DIFFERENT history.
  expect(verifyHistory({ log: [stripped] }).state.assetId).not.toBe(expected);
  expect(() =>
    verifyHistory({ log: [stripped] }, { expectedAssetId: expected }),
  ).toThrow("Requested identity");
  expect(verifyScid(stripped.event, event.previousEvent)).toBe(false);
  const other = await signEvent(
    {
      ...template,
      operation: {
        ...template.operation,
        data: { ...template.operation.data, name: "another history" },
      },
    },
    signer,
  );
  expect(() =>
    verifyHistory({ log: [other] }, { expectedAssetId: expected }),
  ).toThrow("Requested identity");
});

test("SCID APIs reject hostile representations without invoking input accessors", async () => {
  const event = published();
  let invoked = false;
  const accessor = { ...event };
  Object.defineProperty(accessor, "previousEvent", {
    enumerable: true,
    get() {
      invoked = true;
      return event.previousEvent;
    },
  });
  expect(verifyScid(accessor, event.previousEvent)).toBe(false);
  expect(() => deriveScid(accessor)).toThrow();
  await expect(signEvent(accessor, signer)).rejects.toThrow();
  expect(invoked).toBe(false);
  const digest = base64urlnopad.decode(event.previousEvent.slice(1));
  digest[0] = 0x13;
  for (const previousEvent of [
    "u" + base64urlnopad.encode(digest),
    event.previousEvent + "=",
    "{scid}",
    null,
  ]) {
    const malformed = { ...event, previousEvent };
    expect(verifyScid(malformed, previousEvent)).toBe(false);
    expect(() => deriveScid(malformed)).toThrow();
  }
  expect(
    verifyScid(
      {
        previousEvent: event.previousEvent,
        operation: {
          type: "update",
          data: { profile: "originals/cel/3", name: "not genesis" },
        },
      },
      event.previousEvent,
    ),
  ).toBe(false);
});
