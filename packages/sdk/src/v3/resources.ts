import { base64 } from "@scure/base";
import {
  CelError,
  digestBytes,
  type CelDocument,
  type Resource,
} from "@originals/cel/v3";
import type {
  AssetResource,
  AssetResourceInput,
  ResourceAttachment,
} from "./types.js";
import {
  byteBudget,
  checkAttachmentBudget,
  record,
  fields,
  list,
  requireAsset,
} from "./envelope.js";

export function bytes(input: unknown): Uint8Array {
  if (typeof input === "string") {
    byteBudget(input.length);
    const content = new TextEncoder().encode(input);
    byteBudget(content.length);
    return content;
  }
  if (input instanceof Uint8Array) {
    byteBudget(input.byteLength);
    return new Uint8Array(input);
  }
  throw new CelError(
    "invalid",
    "ASSET_RESOURCE_BYTES",
    "Resource content must be bytes or a UTF-8 string",
  );
}

export function attachment(
  id: string,
  version: number,
  content: Uint8Array,
): ResourceAttachment {
  return {
    id,
    version,
    digestMultibase: digestBytes(content),
    content: { encoding: "base64", data: base64.encode(content) },
  };
}

export function prepareResources(inputs: AssetResourceInput[]): {
  descriptors: Resource[];
  attachments: ResourceAttachment[];
} {
  const descriptors: Resource[] = [],
    attachments: ResourceAttachment[] = [];
  let inputBytes = 0;
  for (const raw of list(inputs)) {
    const input = record(raw);
    fields(input, ["id", "mediaType", "content"], ["url"]);
    requireAsset(
      typeof input.id === "string" && typeof input.mediaType === "string",
      "ASSET_RESOURCES",
      "Resource id and mediaType must be strings",
    );
    // Check a byte view before copying; UTF-8 is encoded once, then checked before hashing/base64.
    if (input.content instanceof Uint8Array)
      byteBudget(inputBytes + input.content.byteLength);
    if (typeof input.content === "string")
      byteBudget(inputBytes + input.content.length);
    const content = bytes(input.content);
    inputBytes += content.byteLength;
    byteBudget(inputBytes);
    const blob = attachment(input.id, 1, content);
    const urls = Object.prototype.hasOwnProperty.call(input, "url")
      ? list(input.url)
      : undefined;
    if (urls)
      requireAsset(
        urls.every((url) => typeof url === "string"),
        "ASSET_RESOURCES",
        "Resource URLs must be strings",
      );
    descriptors.push({
      id: input.id,
      mediaType: input.mediaType,
      digestMultibase: blob.digestMultibase,
      ...(urls ? { url: urls } : {}),
    });
    attachments.push(blob);
  }
  checkAttachmentBudget(attachments);
  return { descriptors, attachments };
}

// Index descriptors only AFTER verifyHistory has authenticated the entire log.
// This catalog records historical versions; it makes no authority decisions.
export function resourceCatalog(document: CelDocument): AssetResource[] {
  const catalog: AssetResource[] = [],
    versions = new Map<string, number>();
  for (const {
    event: { operation },
  } of document.log) {
    if (operation.type !== "create" && operation.type !== "update") continue;
    for (const resource of operation.data.resources ?? []) {
      const version = (versions.get(resource.id) ?? 0) + 1;
      versions.set(resource.id, version);
      catalog.push({
        id: resource.id,
        mediaType: resource.mediaType,
        digestMultibase: resource.digestMultibase,
        ...(resource.url ? { url: [...resource.url] } : {}),
        version,
      });
    }
  }
  return catalog;
}

export function bindResources(
  document: CelDocument,
  attachments: ResourceAttachment[],
): AssetResource[] {
  const catalog = resourceCatalog(document),
    seen = new Set<string>();
  for (const blob of attachments) {
    const key = JSON.stringify([blob.id, blob.version]);
    const resource = catalog.find(
      (r) => r.id === blob.id && r.version === blob.version,
    );
    if (
      !resource ||
      seen.has(key) ||
      blob.digestMultibase !== resource.digestMultibase
    ) {
      throw new CelError(
        "invalid",
        "ASSET_RESOURCE_BINDING",
        "Resource id, version and digest must match exactly one authenticated entry",
      );
    }
    seen.add(key);
    let content: Uint8Array;
    try {
      if (blob.content.encoding !== "base64") throw new Error("encoding");
      content = base64.decode(blob.content.data);
      if (base64.encode(content) !== blob.content.data)
        throw new Error("canonical");
    } catch {
      throw new CelError(
        "invalid",
        "ASSET_RESOURCE_ENCODING",
        "Resource bytes require canonical padded base64",
      );
    }
    if (digestBytes(content) !== resource.digestMultibase)
      throw new CelError(
        "invalid",
        "ASSET_RESOURCE_DIGEST",
        "Resource bytes differ from the authenticated digest",
      );
    resource.content = content;
  }
  return catalog;
}
