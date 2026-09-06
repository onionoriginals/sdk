import { createHash } from 'node:crypto';

/** Download one pinned archive; publish it to the cache only after verification. */
export async function downloadArchive(url: string, path: string, expected: string, timeoutMs = 120_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  // Bun 1.3.5's Bun.write(path, response) can ignore a fetch abort after
  // headers arrive. Reading the body explicitly keeps the deadline effective.
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`SHA256 mismatch: ${path}`);
  await Bun.write(path, bytes);
}
