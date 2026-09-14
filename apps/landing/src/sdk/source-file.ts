import type { AssetSource } from './engine';

export const MAX_SOURCE_BYTES = 32 * 1024;
export class SourceFileError extends Error {
  constructor(readonly reason: 'too-big' | 'empty') { super(reason); }
}

// A stranger brings their own bytes — any bytes, not only PNG/SVG/text. The
// browser usually sets `file.type` correctly; this only fills the gap for
// extensions browsers commonly leave blank (drag-drop, some OSes for .md/.csv).
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
};

/** Read file bytes once, preserving even bytes that are not valid UTF-8. */
export async function readAssetFile(file: File): Promise<AssetSource> {
  if (file.size > MAX_SOURCE_BYTES) throw new SourceFileError('too-big');
  const content = new Uint8Array(await file.arrayBuffer());
  if (content.byteLength > MAX_SOURCE_BYTES) throw new SourceFileError('too-big');
  if (!content.byteLength) throw new SourceFileError('empty');
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  const contentType = file.type || (extension && EXTENSION_CONTENT_TYPES[extension]) || 'application/octet-stream';
  // "Non-empty" means non-zero bytes, full stop — a whitespace-only text file
  // still has real bytes to hash and publish verbatim, same as any other
  // upload. (The Write tab's own textarea has a separate, content-aware
  // "nothing typed" check; that's a distinct affordance from a file upload.)
  return { content, filename: file.name, contentType };
}
