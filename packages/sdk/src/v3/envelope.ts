import { base64 } from "@scure/base";
import {
  CelError,
  CEL_LIMITS,
  copyValue,
  validateDigest,
  validateDocument,
} from "@originals/cel/v3";
import type {
  AssetEnvelope,
  LocalResourceAttachment,
  ResourceAttachment,
} from "./types.js";

export const ASSET_ENVELOPE_FORMAT = 'originals/asset' as const;
export const ASSET_ENVELOPE_VERSION = 3 as const;

/** SDK interchange budgets, separate from the smaller limits on signed CEL metadata. */
export const ASSET_LIMITS = Object.freeze({
  bytes: 32 * 1024 * 1024,
  envelopeBytes: 64 * 1024 * 1024,
  attachments: 100_000,
  attachmentJsonBytes: 48 * 1024 * 1024,
});

export function requireAsset(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new CelError("invalid", code, message);
}

export function byteBudget(length: number): void {
  if (length > ASSET_LIMITS.bytes)
    throw new CelError(
      "limit",
      "ASSET_BYTES_LIMIT",
      "Retained asset bytes exceed the 32 MiB SDK budget",
    );
}

// Inspect data descriptors before reading values. No getters, toJSON, prototypes or coercion.
export function record(input: unknown): Record<string, unknown> {
  requireAsset(
    input !== null && typeof input === "object" && !Array.isArray(input),
    "ASSET_SHAPE",
    "Expected a plain data object",
  );
  const prototype = Object.getPrototypeOf(input) as unknown;
  requireAsset(
    prototype === Object.prototype || prototype === null,
    "ASSET_SHAPE",
    "Expected a plain data object",
  );
  requireAsset(
    Object.getOwnPropertySymbols(input).length === 0,
    "ASSET_SHAPE",
    "Symbol fields are not supported",
  );
  const output: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(input),
  )) {
    requireAsset(
      descriptor.enumerable && "value" in descriptor,
      "ASSET_SHAPE",
      "Only enumerable data fields are supported",
    );
    output[key] = descriptor.value as unknown;
  }
  return output;
}

export function fields(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): void {
  requireAsset(
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
      Object.keys(value).every(
        (key) => required.includes(key) || optional.includes(key),
      ),
    "ASSET_SHAPE",
    "Missing or unsupported asset fields",
  );
}

export function list(input: unknown): unknown[] {
  requireAsset(
    Array.isArray(input) && input.length <= ASSET_LIMITS.attachments,
    "ASSET_SHAPE",
    "Expected a bounded array",
  );
  const descriptors = Object.getOwnPropertyDescriptors(input);
  requireAsset(
    Object.getOwnPropertySymbols(input).length === 0 &&
      Object.keys(descriptors).length === input.length + 1,
    "ASSET_SHAPE",
    "Expected a dense array without extra fields",
  );
  const output: unknown[] = [];
  for (let i = 0; i < input.length; i++) {
    const descriptor = descriptors[String(i)];
    requireAsset(
      descriptor?.enumerable && "value" in descriptor,
      "ASSET_SHAPE",
      "Array entries must be data values",
    );
    output.push(descriptor.value as unknown);
  }
  return output;
}

// Reserve the combined byte/count/JSON budget before expensive decoding.
export class AttachmentBudget {
  #count = 0;
  #bytes = 0;
  #jsonBytes = 0;
  reserve(value: { content: ResourceAttachment["content"] }): void {
    if (this.#count >= ASSET_LIMITS.attachments)
      throw new CelError(
        "limit",
        "ASSET_ATTACHMENTS_LIMIT",
        "Too many retained resource attachments",
      );
    const { data } = value.content;
    const size =
      Math.floor(data.length / 4) * 3 -
      (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    byteBudget(this.#bytes + size);
    const jsonBytes =
      new TextEncoder().encode(JSON.stringify(value)).length + 1;
    if (this.#jsonBytes + jsonBytes > ASSET_LIMITS.attachmentJsonBytes)
      throw new CelError(
        "limit",
        "ASSET_ENVELOPE_LIMIT",
        "Retained resource records exceed 48 MiB, including descriptors",
      );
    this.#count++;
    this.#bytes += size;
    this.#jsonBytes += jsonBytes;
  }
}

function content(input: unknown): ResourceAttachment["content"] {
  const value = record(input);
  fields(value, ["encoding", "data"]);
  requireAsset(
    value.encoding === "base64" && typeof value.data === "string",
    "ASSET_RESOURCE_ENCODING",
    "Resource bytes require explicit base64",
  );
  return { encoding: "base64", data: value.data };
}

function canonicalContent(content: ResourceAttachment["content"]): void {
  try {
    requireAsset(
      base64.encode(base64.decode(content.data)) === content.data,
      "ASSET_RESOURCE_ENCODING",
      "Expected canonical padded base64",
    );
  } catch {
    throw new CelError(
      "invalid",
      "ASSET_RESOURCE_ENCODING",
      "Expected canonical padded base64",
    );
  }
}

export function copyAttachments(
  input: unknown,
  budget = new AttachmentBudget(),
): ResourceAttachment[] {
  return list(input).map((raw) => {
    const value = record(raw);
    fields(value, ["id", "version", "digestMultibase", "content"]);
    requireAsset(
      typeof value.id === "string" &&
        typeof value.version === "number" &&
        Number.isSafeInteger(value.version) &&
        value.version > 0,
      "ASSET_RESOURCE_BINDING",
      "Expected an exact resource id and positive integer version",
    );
    validateDigest(value.digestMultibase);
    copyValue(value.id);
    const result: ResourceAttachment = {
      id: value.id,
      version: value.version,
      digestMultibase: value.digestMultibase,
      content: content(value.content),
    };
    budget.reserve(result);
    canonicalContent(result.content);
    return result;
  });
}

export function copyLocalResources(
  input: unknown,
  budget = new AttachmentBudget(),
): LocalResourceAttachment[] {
  const seen = new Set<string>();
  return list(input).map((raw) => {
    const value = record(raw);
    fields(value, [
      "localResourceId",
      "id",
      "mediaType",
      "baseDigestMultibase",
      "baseVersion",
      "content",
    ]);
    requireAsset(
      typeof value.localResourceId === "string" &&
        value.localResourceId.length > 0 &&
        value.localResourceId.length <= 128 &&
        !seen.has(value.localResourceId),
      "ASSET_LOCAL_RESOURCE",
      "Retained resources require unique local ids",
    );
    seen.add(value.localResourceId);
    requireAsset(
      typeof value.id === "string" && typeof value.mediaType === "string",
      "ASSET_LOCAL_RESOURCE",
      "Invalid retained resource descriptor",
    );
    validateDigest(value.baseDigestMultibase);
    requireAsset(
      typeof value.baseVersion === "number" &&
        Number.isSafeInteger(value.baseVersion) &&
        value.baseVersion > 0,
      "ASSET_LOCAL_RESOURCE",
      "Retained bytes require a positive predecessor version",
    );
    copyValue({ id: value.id, mediaType: value.mediaType });
    const result: LocalResourceAttachment = {
      localResourceId: value.localResourceId,
      id: value.id,
      mediaType: value.mediaType,
      baseDigestMultibase: value.baseDigestMultibase,
      baseVersion: value.baseVersion,
      content: content(value.content),
    };
    budget.reserve(result);
    canonicalContent(result.content);
    return result;
  });
}

export function checkAttachmentBudget(
  attachments: { content: ResourceAttachment["content"] }[],
): void {
  const budget = new AttachmentBudget();
  for (const attachment of attachments) budget.reserve(attachment);
}

// Scan object keys before JSON.parse can collapse duplicates. JSON.parse still
// owns grammar validation; this scanner only bounds nesting/tokens and rejects
// duplicate *decoded* keys, including within the signed eventLog.
function parseEnvelopeJson(input: string): unknown {
  if (
    input.length > ASSET_LIMITS.envelopeBytes ||
    new TextEncoder().encode(input).length > ASSET_LIMITS.envelopeBytes
  )
    throw new CelError(
      "limit",
      "ASSET_ENVELOPE_LIMIT",
      "Envelope exceeds 64 MiB",
    );
  const stack: (
    { kind: "object"; keys: Set<string>; key: boolean } | { kind: "array" }
  )[] = [];
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|[{}[\]:,]|[^{}[\]:,\s]+/g;
  let count = 0;
  for (const match of input.matchAll(tokens)) {
    // The closed attachment records need fewer than 48 lexical tokens each;
    // a bounded CEL value needs fewer than 8, including its key/separators.
    // Keep every accepted object envelope readable after JSON serialization.
    if (++count > ASSET_LIMITS.attachments * 48 + CEL_LIMITS.values * 8 + 128)
      throw new CelError(
        "limit",
        "ASSET_ENVELOPE_LIMIT",
        "Too many envelope tokens",
      );
    const token = match[0],
      top = stack[stack.length - 1];
    if (token === "{" || token === "[") {
      stack.push(
        token === "{"
          ? { kind: "object", keys: new Set(), key: true }
          : { kind: "array" },
      );
      if (stack.length > 72)
        throw new CelError(
          "limit",
          "ASSET_ENVELOPE_LIMIT",
          "Envelope nesting exceeds 72",
        );
    } else if (token === "}" || token === "]") stack.pop();
    else if (token === "," && top?.kind === "object") top.key = true;
    else if (token.startsWith('"') && top?.kind === "object" && top.key) {
      const key = JSON.parse(token) as string;
      requireAsset(
        !top.keys.has(key),
        "ASSET_DUPLICATE_KEY",
        "Duplicate decoded JSON key",
      );
      top.keys.add(key);
      top.key = false;
    }
  }
  return JSON.parse(input) as unknown;
}

/** Parse the unsigned container without relaxing the signed CEL's own parser or limits. */
export function readEnvelope(input: unknown): AssetEnvelope {
  let raw = input;
  if (typeof input === "string") {
    try {
      raw = parseEnvelopeJson(input);
    } catch (error) {
      if (error instanceof CelError) throw error;
      throw new CelError(
        "invalid",
        "ASSET_ENVELOPE_JSON",
        "Envelope is not valid JSON",
      );
    }
  }
  const value = record(raw);
  if (value.format !== "originals/asset" || value.version !== 3)
    throw new CelError(
      "unsupported",
      "ASSET_ENVELOPE_VERSION",
      "Expected an originals/asset version-3 envelope; earlier formats are not translated",
    );
  fields(
    value,
    ["format", "version", "assetDid", "eventLog", "resources"],
    ["unverified"],
  );
  requireAsset(
    typeof value.assetDid === "string",
    "ASSET_ENVELOPE",
    "Envelope needs a genesis assetDid",
  );
  const budget = new AttachmentBudget();
  const envelope: AssetEnvelope = {
    format: "originals/asset",
    version: 3,
    assetDid: value.assetDid,
    eventLog: validateDocument(value.eventLog),
    resources: copyAttachments(value.resources, budget),
  };
  if (Object.prototype.hasOwnProperty.call(value, "unverified")) {
    const unverified = record(value.unverified);
    fields(unverified, ["localResources"]);
    envelope.unverified = {
      localResources: copyLocalResources(unverified.localResources, budget),
    };
  }
  checkAttachmentBudget([
    ...envelope.resources,
    ...(envelope.unverified?.localResources ?? []),
  ]);
  return envelope;
}
