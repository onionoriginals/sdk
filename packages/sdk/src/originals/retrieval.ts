/**
 * The whole-operation retrieval budget of `OriginalsSDK.loadPublished`
 * (issue #970). PROVISIONAL: implementation limits, not protocol rules.
 *
 * - Every request counts, failed and optional ones included.
 * - Bytes count as responses arrive. Each request is told what it may still
 *   take, and a response larger than that is never kept.
 * - The whole call has a deadline and honours the caller's signal, so many
 *   slow optional files cannot multiply the per-request timeout.
 * - The request plan derived from an unverified asset log is checked for
 *   shape (section 4 state rules) and size before any of it is requested.
 *
 * An exhausted budget is a `limit-exceeded` OriginalsError (section 6),
 * RETRIEVAL_BUDGET_EXCEEDED; a caller's abort is RETRIEVAL_ABORTED. Neither is
 * ever a result.
 */
import { OriginalsError, type ErrorCategory } from "@originals/vh";
import { isJsonObject, parseJson } from "@originals/vh/json";
import { ORIGINALS_LIMITS, checkAsset, checkAuthorRef } from "@originals/vh/originals";
import { RETRIEVAL_LIMITS, type HostedFetch, type RetrievalLimits } from "./hosting.js";
import { ZIP_LIMITS, type ZipLimits } from "./zip.js";

/** W3C DID syntax: `did:` method `:` method-specific-id. */
const DID = /^did:[a-z0-9]+:(?:[A-Za-z0-9._%-]*:)*[A-Za-z0-9._%-]+$/;

/** `index` is the line's 0-based index; reports name it 1-based. */
function unplannable(category: ErrorCategory, index: number, cause: string, message: string): never {
  throw new OriginalsError(category, "SNAPSHOT_LOG_INVALID", `the hosted asset log cannot be retrieved from: line ${index + 1}: ${message}`, { line: index + 1, cause });
}

/**
 * The author DIDs and resource digests a hosted asset log asks for. Every
 * line must parse and carry a well-formed author reference and asset state
 * (section 4 state rules, as the verifier checks them); otherwise nothing is
 * requested and SNAPSHOT_LOG_INVALID is thrown, with the rule's category.
 */
export function retrievalPlan(log: string): { authors: string[]; digests: string[] } {
  const lines = log.length === 0 ? [] : log.trimEnd().split("\n");
  if (lines.length > ORIGINALS_LIMITS.entries) unplannable("limit-exceeded", ORIGINALS_LIMITS.entries, "LOG_TOO_LONG", `history exceeds ${ORIGINALS_LIMITS.entries} entries`);
  const authors = new Set<string>();
  const digests = new Set<string>();
  lines.forEach((line, i) => {
    try {
      const entry = parseJson(line);
      if (!isJsonObject(entry) || !isJsonObject(entry.state)) unplannable("invalid-evidence", i, "ENTRY_STATE", "an entry is an object with a state object");
      const author = checkAuthorRef(entry.state.author);
      if (!DID.test(author.did)) unplannable("invalid-evidence", i, "STATE_AUTHOR", "state.author.did is not a DID");
      authors.add(author.did);
      for (const r of checkAsset(entry.state.asset).resources) digests.add(r.digest);
    } catch (error) {
      if (error instanceof OriginalsError && error.code !== "SNAPSHOT_LOG_INVALID") unplannable(error.category, i, error.code, error.message);
      throw error;
    }
  });
  return { authors: [...authors], digests: [...digests] };
}

type Limit = "requests" | "bytes" | "archive-bytes" | "archive-entries" | "time";

export class Retrieval {
  private requests = 0;
  private bytes = 0;
  private archiveBytes = 0;
  private readonly limits: Required<RetrievalLimits>;
  private readonly archive: Required<ZipLimits>;
  private readonly controller = new AbortController();
  private readonly deadline: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private timedOut = false;
  private readonly caller?: AbortSignal;
  private readonly onCallerAbort = () => this.controller.abort();

  constructor(private readonly fetch: HostedFetch, limits: RetrievalLimits = {}, archive: ZipLimits = {}, signal?: AbortSignal) {
    this.archive = { maxEntries: archive.maxEntries ?? ZIP_LIMITS.maxEntries, maxTotalBytes: archive.maxTotalBytes ?? ZIP_LIMITS.maxTotalBytes };
    this.limits = {
      maxRequests: limits.maxRequests ?? RETRIEVAL_LIMITS.maxRequests,
      maxTotalBytes: limits.maxTotalBytes ?? this.archive.maxTotalBytes,
      maxFileBytes: limits.maxFileBytes ?? RETRIEVAL_LIMITS.maxFileBytes,
      requestTimeoutMs: limits.requestTimeoutMs ?? RETRIEVAL_LIMITS.requestTimeoutMs,
      timeoutMs: limits.timeoutMs ?? RETRIEVAL_LIMITS.timeoutMs,
    };
    this.caller = signal;
    if (signal?.aborted) this.controller.abort();
    signal?.addEventListener("abort", this.onCallerAbort, { once: true });
    this.deadline = Date.now() + this.limits.timeoutMs;
    this.timer = setTimeout(() => {
      this.timedOut = true;
      this.controller.abort();
    }, this.limits.timeoutMs);
  }

  /** Release the timer and the caller's signal. */
  close(): void {
    clearTimeout(this.timer);
    this.caller?.removeEventListener("abort", this.onCallerAbort);
  }

  private exceeded(limit: Limit, message: string): never {
    const { maxRequests, maxTotalBytes, timeoutMs } = this.limits;
    throw new OriginalsError("limit-exceeded", "RETRIEVAL_BUDGET_EXCEEDED", `loadPublished stopped: ${message}`, {
      limit, requests: this.requests, bytes: this.bytes, maxRequests, maxTotalBytes, timeoutMs,
      archiveBytes: this.archiveBytes, maxArchiveBytes: this.archive.maxTotalBytes, maxArchiveEntries: this.archive.maxEntries,
    });
  }

  /** Throw if the caller aborted or the deadline passed. The caller's abort wins. */
  private checkRunning(): void {
    if (this.caller?.aborted) {
      throw new OriginalsError("incomplete-evidence", "RETRIEVAL_ABORTED", "loadPublished stopped: the caller aborted", { requests: this.requests, bytes: this.bytes });
    }
    if (this.timedOut || Date.now() >= this.deadline) this.exceeded("time", `the ${this.limits.timeoutMs} ms deadline passed`);
  }

  /** Refuse a plan of `requests` more requests and `files` snapshot files before making any of them. */
  plan(requests: number, files: number): void {
    if (files > this.archive.maxEntries) this.exceeded("archive-entries", `the snapshot would have ${files} files; at most ${this.archive.maxEntries}`);
    if (this.requests + requests > this.limits.maxRequests) {
      this.exceeded("requests", `${this.requests} requests made and ${requests} more planned; at most ${this.limits.maxRequests}`);
    }
  }

  /**
   * Make one request. An optional file that is unavailable gives undefined;
   * any other failure throws. `archive` files are part of the snapshot.
   */
  async get(url: string, { required, archive }: { required: boolean; archive: boolean }): Promise<Uint8Array | undefined> {
    this.checkRunning();
    if (this.requests >= this.limits.maxRequests) this.exceeded("requests", `at most ${this.limits.maxRequests} requests`);
    this.requests++;
    const byteRoom = this.limits.maxTotalBytes - this.bytes;
    const archiveRoom = archive ? this.archive.maxTotalBytes - this.archiveBytes : Infinity;
    const room = Math.min(byteRoom, archiveRoom);
    const maxBytes = Math.max(0, Math.min(this.limits.maxFileBytes, room));
    const overBudget = (size?: number): never =>
      byteRoom <= archiveRoom
        ? this.exceeded("bytes", `${url} ${size === undefined ? "is larger than" : `is ${size} bytes, more than`} the ${byteRoom} bytes left of ${this.limits.maxTotalBytes}`)
        : this.exceeded("archive-bytes", `${url} would take the snapshot past the archive limit of ${this.archive.maxTotalBytes} bytes`);
    const unavailable = (error: OriginalsError): undefined => {
      if (required) throw error;
      return undefined;
    };

    const timeoutMs = Math.max(0, Math.min(this.limits.requestTimeoutMs, this.deadline - Date.now()));
    const request = new AbortController();
    const abort = () => request.abort();
    this.controller.signal.addEventListener("abort", abort, { once: true });
    if (this.controller.signal.aborted) request.abort();
    const timer = setTimeout(abort, timeoutMs);
    // A fetcher that ignores the signal is not waited for.
    const stopped = new Promise<never>((_, reject) => {
      request.signal.addEventListener("abort", () => reject(new OriginalsError("unavailable-bytes", "FETCH_TIMEOUT", `${url} did not answer within ${timeoutMs} ms`)), { once: true });
    });
    stopped.catch(() => undefined);
    let data: Uint8Array;
    try {
      const pending = Promise.resolve(this.fetch(url, { maxBytes, timeoutMs, signal: request.signal }));
      // Once abandoned, a late failure is not an unhandled rejection.
      pending.catch(() => undefined);
      data = await Promise.race([pending, stopped]);
    } catch (error) {
      this.checkRunning();
      if (error instanceof OriginalsError && error.code === "FETCH_TOO_LARGE" && room < this.limits.maxFileBytes) overBudget();
      if (error instanceof OriginalsError && error.category === "unavailable-bytes") return unavailable(error);
      throw error;
    } finally {
      clearTimeout(timer);
      this.controller.signal.removeEventListener("abort", abort);
    }
    this.checkRunning();
    if (!(data instanceof Uint8Array)) throw new OriginalsError("invalid-evidence", "FETCH_RESULT", `the fetcher returned no bytes for ${url}`);
    if (data.length > room) overBudget(data.length);
    if (data.length > maxBytes) {
      return unavailable(new OriginalsError("unavailable-bytes", "FETCH_TOO_LARGE", `${url} is ${data.length} bytes; the cap is ${maxBytes}`));
    }
    this.bytes += data.length;
    if (archive) this.archiveBytes += data.length;
    return data;
  }
}
