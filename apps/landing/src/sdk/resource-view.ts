import { base64, hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';

/** Raw content crosses the SDK boundary as bytes; text decoding is a view concern. */
export type ResourceContent = string | Uint8Array;
export function contentBytes(content: ResourceContent): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
}
export function contentByteLength(content: ResourceContent): number {
  return typeof content === 'string' ? new TextEncoder().encode(content).length : content.byteLength;
}
export function resourceMatchesSource(
  source: { content: ResourceContent; contentType: string },
  resource: { content: ResourceContent; contentType: string; hash: string },
): boolean {
  // Text previews can strip a BOM or replace invalid UTF-8. Compare source
  // bytes to the committed hash, never to that presentation string.
  return source.contentType === resource.contentType && hex.encode(sha256(contentBytes(source.content))) === resource.hash;
}
export function textMediaType(type: string): boolean {
  return type.startsWith('text/') || type === 'image/svg+xml' || type === 'application/json';
}
export function resourceView(content: Uint8Array | undefined, type: string): ResourceContent {
  const bytes = content ?? new Uint8Array();
  if (textMediaType(type)) {
    try {
      // Retain a UTF-8 BOM and keep non-UTF-8 files as bytes. Re-encoding a
      // snapshot must preserve fee byte counts and the original resource.
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch { /* Display decoding belongs in contentText; preserve these bytes. */ }
  }
  return new Uint8Array(bytes);
}
export function contentText(content: ResourceContent): string {
  return typeof content === 'string' ? content : new TextDecoder().decode(content);
}
export function resourceDataUrl(content: ResourceContent, contentType: string): string {
  return `data:${contentType};base64,${base64.encode(contentBytes(content))}`;
}
