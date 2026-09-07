import type { AssetSource } from './engine';

export const MAX_SOURCE_BYTES = 32 * 1024;
export class SourceFileError extends Error {
  constructor(readonly reason: 'too-big' | 'empty' | 'wrong-type') { super(reason); }
}
/** Read file bytes once, preserving even bytes that are not valid UTF-8. */
export async function readAssetFile(file: File): Promise<AssetSource> {
  if (file.size > MAX_SOURCE_BYTES) throw new SourceFileError('too-big');
  const content = new Uint8Array(await file.arrayBuffer());
  if (content.byteLength > MAX_SOURCE_BYTES) throw new SourceFileError('too-big');
  if (!content.byteLength) throw new SourceFileError('empty');
  const isPng = file.type === 'image/png' || /\.png$/i.test(file.name);
  const isSvg = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
  const isText = file.type.startsWith('text/') || /\.(txt|md|json|csv)$/i.test(file.name);
  if (!isPng && !isSvg && !isText) throw new SourceFileError('wrong-type');
  if (isPng && ![137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => content[i] === value)) {
    throw new SourceFileError('wrong-type');
  }
  if (!isPng && !new TextDecoder().decode(content).trim()) throw new SourceFileError('empty');
  return { content, filename: file.name, contentType: isPng ? 'image/png' : isSvg ? 'image/svg+xml' : 'text/plain' };
}
