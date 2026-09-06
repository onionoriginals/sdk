import { base64 } from '@scure/base';
import { StructuredError } from '@originals/cel';
import type { AssetResource, AssetResourceInput } from '../types/common.js';

/** JSON encoding for raw bytes in version-2 asset envelopes. */
export interface EncodedResourceContent {
  encoding: 'base64';
  /** Canonical RFC 4648 base64, with padding and without whitespace. */
  data: string;
}

export type SerializedAssetResource = Omit<AssetResource, 'content'> & {
  /** Version 1 accepts UTF-8 strings; version 2 requires an explicit byte encoding. */
  content?: EncodedResourceContent | string;
};

/** Copy an input view (including Buffer subarrays) before an asynchronous boundary. */
export function resourceContentBytes(content: unknown): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content);
  if (content instanceof Uint8Array) return new Uint8Array(content);
  throw new StructuredError('INVALID_RESOURCE_CONTENT', 'Resource content must be a Uint8Array or a UTF-8 string.');
}

/** Keep the runtime resource independent of caller-owned objects and byte buffers. */
export function normalizeResource(resource: AssetResourceInput): AssetResource {
  if (!resource || typeof resource !== 'object') {
    throw new StructuredError('INVALID_RESOURCE', 'Invalid resource: must be an object.');
  }
  if ('contentBase64' in resource) {
    throw new StructuredError('INVALID_RESOURCE_CONTENT', 'ResourceManager base64 snapshots must be decoded with importResource before use as asset resources.');
  }
  const { content, ...fields } = resource;
  if (content === undefined) return { ...fields };
  const bytes = resourceContentBytes(content);
  if (fields.size !== undefined && fields.size !== bytes.byteLength) {
    throw new StructuredError('RESOURCE_SIZE_MISMATCH', `Resource ${resource.id}: declared size does not match its byte length.`);
  }
  return { ...fields, content: bytes, size: bytes.byteLength };
}

export function encodeResource(resource: AssetResource): SerializedAssetResource {
  const normalized = normalizeResource(resource);
  const { content, ...fields } = normalized;
  return content === undefined ? fields : { ...fields, content: { encoding: 'base64', data: base64.encode(content) } };
}

/** Decode only the representation declared by the envelope version. Never coerce JSON byte objects. */
export function decodeResource(resource: SerializedAssetResource, version: number): AssetResource {
  const { content, ...fields } = resource;
  if (content === undefined) return normalizeResource(fields);
  let bytes: Uint8Array;
  if (version === 1) {
    if (typeof content !== 'string') {
      throw new StructuredError('ENVELOPE_INVALID', 'Version-1 resource content must be a UTF-8 string.');
    }
    bytes = new TextEncoder().encode(content);
  } else {
    if (!content || typeof content !== 'object' || Array.isArray(content) ||
      Object.keys(content).length !== 2 ||
      !Object.prototype.hasOwnProperty.call(content, 'encoding') || !Object.prototype.hasOwnProperty.call(content, 'data') ||
      content.encoding !== 'base64' || typeof content.data !== 'string') {
      throw new StructuredError('ENVELOPE_INVALID', 'Version-2 resource content must be exactly { encoding: "base64", data: string }.');
    }
    try {
      bytes = base64.decode(content.data);
      if (base64.encode(bytes) !== content.data) throw new Error('Non-canonical base64');
    } catch {
      throw new StructuredError('ENVELOPE_INVALID', 'Resource content must contain canonical padded base64 without whitespace.');
    }
  }
  try {
    return normalizeResource({ ...fields, content: bytes });
  } catch (error) {
    throw new StructuredError('ENVELOPE_INVALID', (error as Error).message);
  }
}
