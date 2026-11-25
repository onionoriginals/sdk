import { createHash } from 'node:crypto';

/**
 * Waits before each retry of a download that failed transiently (a timeout, a dropped connection, a
 * 5xx or 429): 5 s, then 20 s. A digest mismatch or another 4xx is never retried.
 */
export const DOWNLOAD_RETRY_DELAYS_MS: readonly number[] = Object.freeze([5_000, 20_000]);

class Permanent extends Error {}

async function attempt(url: string, path: string, expected: string, timeoutMs: number) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    const message = `Download failed: ${response.status} ${url}`;
    throw response.status >= 500 || response.status === 429 ? new Error(message) : new Permanent(message);
  }
  // Bun 1.3.5's Bun.write(path, response) can ignore a fetch abort after
  // headers arrive. Reading the body explicitly keeps the deadline effective.
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Permanent(`SHA256 mismatch: ${path}`);
  await Bun.write(path, bytes);
}

/**
 * Download one pinned archive; publish it to the cache only after verification. Each try has its
 * own deadline (`timeoutMs`); a transient failure is retried after each of `retryDelaysMs`.
 */
export async function downloadArchive(url: string, path: string, expected: string, timeoutMs = 120_000, retryDelaysMs: readonly number[] = DOWNLOAD_RETRY_DELAYS_MS) {
  for (let i = 0; ; i++) {
    try {
      return await attempt(url, path, expected, timeoutMs);
    } catch (error) {
      if (error instanceof Permanent) throw new Error(error.message);
      if (i >= retryDelaysMs.length) throw error;
      console.log(`Download of ${url} failed (${(error as Error).name}: ${(error as Error).message}); retrying in ${retryDelaysMs[i]} ms`);
      await new Promise((r) => setTimeout(r, retryDelaysMs[i]));
    }
  }
}
