import { CelError, requireThat } from "./errors.js";
import {
  copyValue,
  decodeValue,
  encodeValue,
  type JsonObject,
  type JsonValue,
} from "./values.js";
import {
  decodeBase58,
  decodeBase64,
  decodeController,
  validateDigest,
  ALGORITHMS,
  hashJson,
} from "./primitives.js";
import type {
  CelDocument,
  CelEntry,
  CelEvent,
  ControllerProof,
} from "./types.js";

function object(value: JsonValue | undefined): JsonObject {
  requireThat(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "CEL_SHAPE",
    "Expected object",
  );
  return value;
}
function fields(
  value: JsonObject,
  required: string[],
  optional: string[] = [],
): void {
  requireThat(
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
      Object.keys(value).every(
        (key) => required.includes(key) || optional.includes(key),
      ),
    "CEL_FIELDS",
    "Missing or unsupported member",
  );
}
function string(
  value: JsonValue | undefined,
  max = 262144,
): asserts value is string {
  requireThat(
    typeof value === "string" && [...value].length <= max,
    "CEL_STRING",
    "Expected string within field limit",
  );
}
function time(value: JsonValue | undefined): void {
  string(value, 64);
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?Z$/.exec(
      value,
    );
  const date = new Date(value);
  requireThat(
    match &&
      +match[1] > 0 &&
      Number.isFinite(+date) &&
      date.getUTCFullYear() === +match[1] &&
      date.getUTCMonth() + 1 === +match[2] &&
      date.getUTCDate() === +match[3],
    "CEL_TIME",
    "Invalid Originals UTC timestamp",
  );
}
function urls(value: JsonValue): void {
  requireThat(
    Array.isArray(value) && value.length >= 1 && value.length <= 16,
    "CEL_URL",
    "Expected 1–16 URLs",
  );
  for (const item of value) {
    string(item, 8192);
    requireThat(
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(item) &&
        ![...item].some(
          (c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127 || c === "\\",
        ) &&
        !/%(?![0-9a-fA-F]{2})/.test(item),
      "CEL_URL",
      "Invalid absolute URL",
    );
    try {
      const parsed = new URL(item);
      requireThat(
        !/^https?:$/.test(parsed.protocol) ||
          (/^https?:\/\//i.test(item) && !!parsed.hostname),
        "CEL_URL",
        "HTTP URL requires authority",
      );
    } catch {
      throw new CelError("invalid", "CEL_URL", "Invalid absolute URL");
    }
  }
}
function media(value: JsonValue): void {
  string(value, 255);
  requireThat(
    /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(
      value,
    ),
    "CEL_MEDIA_TYPE",
    "Expected bare lowercase media type",
  );
}
function resources(value: JsonValue, update: boolean): void {
  requireThat(
    Array.isArray(value) &&
      value.length >= (update ? 1 : 0) &&
      value.length <= 1024,
    "CEL_RESOURCES",
    "Invalid resource count",
  );
  const ids = new Set<string>();
  for (const v of value) {
    const r = object(v);
    fields(
      r,
      [
        "id",
        "mediaType",
        "digestMultibase",
        ...(update ? ["previousDigestMultibase"] : []),
      ],
      ["url"],
    );
    string(r.id);
    requireThat(
      r.id.length > 0 && !ids.has(r.id),
      "CEL_RESOURCE_ID",
      "Empty or duplicate resource id",
    );
    ids.add(r.id);
    media(r.mediaType);
    validateDigest(r.digestMultibase);
    if (update) validateDigest(r.previousDigestMultibase);
    if (Object.prototype.hasOwnProperty.call(r, "url")) urls(r.url);
  }
}
function reference(value: JsonValue): void {
  const r = object(value);
  fields(r, ["digestMultibase"], ["mediaType", "url"]);
  validateDigest(r.digestMultibase);
  if (Object.prototype.hasOwnProperty.call(r, "mediaType")) {
    string(r.mediaType);
    requireThat(r.mediaType.length > 0, "CEL_REFERENCE", "Empty media type");
  }
  if (Object.prototype.hasOwnProperty.call(r, "url")) {
    requireThat(
      Array.isArray(r.url) && r.url.length > 0,
      "CEL_REFERENCE",
      "CCG reference URLs must be a nonempty array",
    );
    for (const url of r.url) {
      string(url);
      try {
        new URL(url);
      } catch {
        throw new CelError(
          "invalid",
          "CEL_REFERENCE",
          "Invalid CCG reference URL",
        );
      }
    }
  }
}
function eventShape(value: JsonValue): void {
  const event = object(value);
  fields(event, ["operation"], ["previousEvent"]);
  const operation = object(event.operation);
  if (Object.prototype.hasOwnProperty.call(operation, "dataReference")) {
    fields(operation, ["type", "dataReference"]);
    string(operation.type);
    reference(operation.dataReference);
    if (Object.prototype.hasOwnProperty.call(event, "previousEvent"))
      validateDigest(event.previousEvent);
    throw new CelError(
      "unsupported",
      "CEL_DATA_REFERENCE",
      "CCG dataReference is outside the Originals inline-data profile",
    );
  }
  fields(operation, ["type", "data"]);
  string(operation.type);
  const data = object(operation.data);
  if (data.profile !== "originals/cel/3")
    throw new CelError(
      "unsupported",
      "CEL_PROFILE",
      "Unsupported or missing Originals profile",
    );
  if (operation.type === "create") {
    fields(event, ["operation"]);
    fields(
      data,
      ["profile", "controller", "createdAt", "nonce", "resources"],
      ["name", "metadata"],
    );
    decodeController(data.controller);
    time(data.createdAt);
    string(data.nonce);
    decodeBase64(data.nonce, 16);
    resources(data.resources, false);
  } else {
    fields(event, ["operation", "previousEvent"]);
    validateDigest(event.previousEvent);
    switch (operation.type) {
      case "update":
        fields(data, ["profile"], ["name", "metadata", "resources"]);
        requireThat(Object.keys(data).length > 1, "CEL_UPDATE", "Empty update");
        if (Object.prototype.hasOwnProperty.call(data, "resources"))
          resources(data.resources, true);
        break;
      case "rotateKey":
        fields(data, ["profile", "newController", "rotatedAt"]);
        decodeController(data.newController);
        time(data.rotatedAt);
        break;
      case "deactivate":
        fields(data, ["profile", "deactivatedAt"], ["reason"]);
        time(data.deactivatedAt);
        if (Object.prototype.hasOwnProperty.call(data, "reason"))
          string(data.reason);
        break;
      case "migrate":
        fields(data, ["profile", "from", "to", "layer", "migratedAt"]);
        string(data.from, 8192);
        string(data.to, 8192);
        time(data.migratedAt);
        requireThat(
          /^did:(cel|webvh):[^\s]+$/.test(data.from) &&
            (data.layer === "webvh" || data.layer === "btco") &&
            data.to.startsWith("did:" + data.layer + ":"),
          "CEL_MIGRATION",
          "Invalid migration alias/layer",
        );
        break;
      default:
        throw new CelError(
          "invalid",
          "CEL_OPERATION",
          "Unsupported Originals operation",
        );
    }
  }
  if (Object.prototype.hasOwnProperty.call(data, "name")) string(data.name);
  if (Object.prototype.hasOwnProperty.call(data, "metadata"))
    object(data.metadata);
}
function proofShape(value: JsonValue): void {
  const proof = object(value);
  fields(
    proof,
    ["type", "cryptosuite", "verificationMethod", "proofPurpose", "proofValue"],
    ["created"],
  );
  requireThat(
    proof.type === "DataIntegrityProof" &&
      proof.proofPurpose === "assertionMethod",
    "CEL_PROOF",
    "Expected Data Integrity assertion proof",
  );
  if (
    proof.cryptosuite !== "ecdsa-jcs-2019" &&
    proof.cryptosuite !== "eddsa-jcs-2022"
  )
    throw new CelError("unsupported", "CEL_SUITE", "Unsupported cryptosuite");
  string(proof.verificationMethod, 512);
  string(proof.proofValue, 133);
  const key = decodeController(proof.verificationMethod.split("#")[0]);
  requireThat(
    key.verificationMethod === proof.verificationMethod &&
      ALGORITHMS[key.algorithm].suite === proof.cryptosuite,
    "CEL_PROOF_KEY",
    "Verification method or suite does not match did:key",
  );
  requireThat(
    decodeBase58(proof.proofValue).length ===
      ALGORITHMS[key.algorithm].signature,
    "CEL_SIGNATURE",
    "Invalid signature length",
  );
  if (Object.prototype.hasOwnProperty.call(proof, "created"))
    time(proof.created);
}
function entryShape(value: JsonValue): void {
  const entry = object(value);
  fields(entry, ["event", "proof"]);
  eventShape(entry.event);
  const proofs = Array.isArray(entry.proof) ? entry.proof : [entry.proof];
  requireThat(
    proofs.length >= 1 && proofs.length <= 8,
    "CEL_PROOFS",
    "Expected 1–8 proofs",
  );
  proofs.forEach(proofShape);
}
/** Validate an event without trusting a type assertion or invoking input accessors. */
export function validateEvent(input: unknown): CelEvent {
  const value = copyValue(input);
  eventShape(value);
  return value as unknown as CelEvent;
}
/** Validate a proof's options, did:key relationship and canonical encodings, without authenticating its signature. */
export function validateProof(input: unknown): ControllerProof {
  const value = copyValue(input);
  proofShape(value);
  return value as unknown as ControllerProof;
}
/** Validate an entry's representation, without asserting authority. */
export function validateEntry(input: unknown): CelEntry {
  const value = copyValue(input);
  entryShape(value);
  return value as unknown as CelEntry;
}
/** Validate the new profile exclusively. Legacy wrappers are never translated. */
export function validateDocument(input: unknown): CelDocument {
  const value = object(copyValue(input));
  if (Object.prototype.hasOwnProperty.call(value, "previousLog")) {
    fields(value, ["log", "previousLog"]);
    const previous = object(value.previousLog);
    fields(previous, ["digestMultibase", "proof"], ["mediaType", "url"]);
    const { proof: _proof, ...ref } = previous;
    reference(ref);
    validateDocument({ log: value.log });
    const p = Array.isArray(previous.proof) ? previous.proof : [previous.proof];
    requireThat(
      p.length > 0,
      "CEL_PREVIOUS_LOG",
      "CCG previousLog requires proof",
    );
    for (const v of p) {
      const proof = object(v);
      requireThat(
        proof.type === "DataIntegrityProof",
        "CEL_PREVIOUS_LOG",
        "CCG previousLog requires Data Integrity proof",
      );
      for (const key of [
        "cryptosuite",
        "verificationMethod",
        "proofPurpose",
        "proofValue",
      ]) {
        string(proof[key]);
        requireThat(
          proof[key].length > 0,
          "CEL_PREVIOUS_LOG",
          "Incomplete previousLog proof",
        );
      }
    }
    throw new CelError(
      "unsupported",
      "CEL_PREVIOUS_LOG",
      "CCG previousLog is outside the Originals profile",
    );
  }
  fields(value, ["log"]);
  requireThat(
    Array.isArray(value.log) &&
      value.log.length >= 1 &&
      value.log.length <= 10000,
    "CEL_LOG",
    "Expected 1–10000 entries",
  );
  value.log.forEach(entryShape);
  return value as unknown as CelDocument;
}
/** Decode strict JSON or CBOR and validate all retained profile fields. No authority is implied. */
export function parseDocument(
  input: string | Uint8Array,
  format: "json" | "cbor",
): CelDocument {
  return validateDocument(decodeValue(input, format));
}
/** Serialize the profile losslessly. Proofs are always written as arrays. */
export function encodeDocument(
  input: unknown,
  format: "json" | "cbor",
): Uint8Array {
  const document = validateDocument(input);
  return encodeValue(
    {
      log: document.log.map((e) => ({
        event: e.event,
        proof: Array.isArray(e.proof) ? e.proof : [e.proof],
      })),
    },
    format,
  );
}
/** Derive an event's digest from the full validated event, excluding its proofs. */
export function eventDigest(input: unknown): string {
  return hashJson(validateEvent(input));
}
/** Derive genesis identity, never reading an unsigned or legacy declared DID. */
export function deriveDid(input: unknown): string {
  const event = validateEvent(input);
  requireThat(
    event.operation.type === "create",
    "CEL_GENESIS",
    "Genesis must be create",
  );
  return "did:cel:" + hashJson(event);
}
