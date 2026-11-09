/**
 * Helpers every web app built on the SDK wrote for itself (Easel, Commission
 * Desk, the landing): reading hosted files from a browser, talking to an
 * `@originals/host` shared host, naming and uploading a hosted publication,
 * and reading a report's reasons. Browser-safe: no Node built-ins.
 *
 * Nothing here changes what verifies. A fetch only supplies bytes the SDK
 * then verifies (P9.1); a submission is checked by the host (P6.7) and its
 * answer by the SDK; the reasons helpers only sort what a report says.
 */
import { OriginalsError } from "@originals/vh";
import { FETCH_LIMITS, isPublicAddress } from "@originals/vh/fetch";
import type { AliasEvidence, AuthorDidEvidence } from "@originals/vh/originals";
import { didWebvhFilesUrl } from "@originals/vh/webvh";
import { base64 } from "@scure/base";
import type { EvidenceContents } from "./evidence.js";
import { HOSTED_PREFIX, hostedFiles, type HostedFetch } from "./hosting.js";
import type { HostAnswer, SharedHost, Submission } from "./shared.js";

// ---------------------------------------------------------------- reading hosted files

export interface WebFetchOptions {
  /**
   * Send every request to this origin instead (`http://localhost:5173` in
   * local development, where a dev server proxies the host). Only the URL's
   * path and query are kept, set on this origin: a path beginning `//` stays
   * a path and never names another host. The origin is the caller's own
   * configuration and is trusted as given, loopback included; it must be
   * `http:` or `https:`.
   */
  origin?: string;
  /** The fetch to use; defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Each response's bytes are kept here by URL, so a page can show exactly the bytes the SDK verified. */
  cache?: Map<string, Uint8Array>;
}

type Refuse = (code: string, message: string, details?: Record<string, unknown>) => never;

const refuse: Refuse = (code, message, details) => {
  throw new OriginalsError("unavailable-bytes", code, message, details);
};

/**
 * A host that is not public by its name alone, with no DNS: an IP literal
 * (the URL parser has already normalised `2130706433`, `0x7f000001` and
 * `127.1` to dotted form) that `safeFetch` would refuse, or `localhost` and
 * its subdomains, which always name loopback (RFC 6761). Any other name is
 * left to the platform: a browser cannot see what it resolves to.
 */
function nonPublicHost(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, "");
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  const literal = name.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(name);
  return literal && !isPublicAddress(name);
}

/** The reader of a body, typed locally: DOM and Bun's lib disagree on its type. */
type BodyReader = { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> };

/**
 * A `HostedFetch` over the platform's `fetch`, for browsers and other
 * runtimes where `@originals/vh/fetch`'s `safeFetch` (which resolves and
 * vets addresses with Node) is not available. It refuses as `safeFetch`
 * does, every refusal an `unavailable-bytes` OriginalsError:
 *
 * - `FETCH_URL`: the URL, or the configured `origin`, is not a usable URL
 * - `FETCH_SCHEME`: not `https:` (unless `origin` is given)
 * - `FETCH_PRIVATE_ADDRESS`: without `origin`, the host is an IP literal
 *   that is not public (loopback, private, link-local, ...) or `localhost`
 *   (P8.5). Checked on the parsed host with no DNS: a browser cannot vet
 *   what a name resolves to.
 * - `FETCH_REDIRECT`: any redirect, which is never followed (P8.5)
 * - `FETCH_STATUS`: any status but 2xx, with `details.status`
 * - `FETCH_TOO_LARGE`: past `maxBytes`, by declared length or as it arrives
 * - `FETCH_TIMEOUT`: `timeoutMs` ran out, before the headers or while the
 *   body arrived
 * - `FETCH_ABORTED`: the caller's `signal` aborted, at any point
 * - `FETCH_FAILED`: the network failed
 *
 * Every refusal after the request was made carries `details.bytesRead`, and
 * a refused body is cancelled. Credentials are never sent and nothing is
 * served from the HTTP cache. A server retrieving on others' behalf should
 * use `safeFetch` instead, which also vets the addresses names resolve to.
 */
export function hostedFetch(options: WebFetchOptions = {}): HostedFetch {
  const doFetch: (url: string, init: RequestInit) => Promise<Response> = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return async (url, request) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return refuse("FETCH_URL", `${url} is not a URL`);
    }
    if (options.origin !== undefined) {
      let base: URL;
      try {
        base = new URL(options.origin);
      } catch {
        return refuse("FETCH_URL", `the origin ${options.origin} is not a URL`);
      }
      if (base.protocol !== "https:" && base.protocol !== "http:") refuse("FETCH_URL", `the origin ${options.origin} is not http or https`);
      // Set on the origin, never resolved against it: `//evil.example/p` is a path here, not an authority.
      const path = target.pathname;
      const search = target.search;
      target = new URL(base.origin);
      target.pathname = path;
      target.search = search;
    } else {
      if (target.protocol !== "https:") refuse("FETCH_SCHEME", `only https is retrieved, not ${target.protocol}`);
      if (nonPublicHost(target.hostname)) refuse("FETCH_PRIVATE_ADDRESS", `${target.hostname} is not a public address`);
    }
    const maxBytes = request?.maxBytes ?? FETCH_LIMITS.maxResourceBytes;
    const timeoutMs = request?.timeoutMs ?? FETCH_LIMITS.timeoutMs;
    const signal = request?.signal;
    if (signal?.aborted) return refuse("FETCH_ABORTED", `${url} was not requested: the caller aborted`, { bytesRead: 0 });

    // One controller ends the request, headers and body alike, at the timeout or when the caller aborts.
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    // Raced against every await, so an injected fetch or body that ignores the signal still stops.
    const stopped = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    stopped.catch(() => undefined);

    let response: Response | undefined;
    let reader: BodyReader | undefined;
    let size = 0;
    let succeeded = false;
    try {
      response = await Promise.race([doFetch(target.href, { signal: controller.signal, redirect: "manual", credentials: "omit", cache: "no-store" }), stopped]);
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        refuse("FETCH_REDIRECT", `${url} redirects; redirects are not followed`, { bytesRead: 0 });
      }
      if (!response.ok) refuse("FETCH_STATUS", `${url} answered ${response.status}`, { status: response.status, bytesRead: 0 });
      const declared = Number(response.headers.get("content-length") ?? NaN);
      if (Number.isFinite(declared) && declared > maxBytes) refuse("FETCH_TOO_LARGE", `${url} is ${declared} bytes; the cap is ${maxBytes}`, { bytesRead: 0 });

      let bytes: Uint8Array;
      if (!response.body) {
        bytes = new Uint8Array(await Promise.race([response.arrayBuffer(), stopped]));
        size = bytes.length;
        if (size > maxBytes) refuse("FETCH_TOO_LARGE", `${url} exceeds the ${maxBytes}-byte cap`, { bytesRead: size });
      } else {
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done, value } = await Promise.race([reader.read(), stopped]);
          if (done || !value) break;
          size += value.length;
          if (size > maxBytes) refuse("FETCH_TOO_LARGE", `${url} exceeds the ${maxBytes}-byte cap`, { bytesRead: size });
          chunks.push(value);
        }
        bytes = new Uint8Array(size);
        let at = 0;
        for (const c of chunks) {
          bytes.set(c, at);
          at += c.length;
        }
      }
      succeeded = true;
      options.cache?.set(url, bytes);
      return bytes;
    } catch (error) {
      if (error instanceof OriginalsError) throw error;
      if (controller.signal.aborted) {
        if (timedOut) return refuse("FETCH_TIMEOUT", `${url} did not answer within ${timeoutMs} ms`, { bytesRead: size });
        return refuse("FETCH_ABORTED", `${url}: the request was aborted`, { bytesRead: size });
      }
      return refuse("FETCH_FAILED", `${url} could not be retrieved: ${(error as Error)?.message ?? String(error)}`, { bytesRead: size });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (!succeeded) {
        // A refused response is released: its body cancelled, its request aborted.
        if (reader) void reader.cancel().catch(() => undefined);
        else void response?.body?.cancel().catch(() => undefined);
        controller.abort();
      }
    }
  };
}

// ---------------------------------------------------------------- shared hosts over HTTP

/**
 * Where an alias's hosted files live, without the scheme and trailing slash:
 * `<domain>/<path...>`, the alias did:webvh's `#files` base. `@originals/host`
 * names the Original's submit route by it (`POST /api/originals/submit/<site key>`).
 */
export function siteKeyOf(aliasDid: string): string {
  return didWebvhFilesUrl(aliasDid).replace(/^https:\/\//, "").replace(/\/$/, "");
}

const logText = (log: AuthorDidEvidence["log"]): string | undefined =>
  log === undefined ? undefined : typeof log === "string" ? log : log.map((e) => `${JSON.stringify(e)}\n`).join("");

/**
 * A `Submission` as the JSON body `@originals/host`'s submit route parses
 * (PROVISIONAL wire format): `{ original, entry, resources: { <digest>: <base64> },
 * identities: [{ did, log, witness? }] }`. A did:btco identity has no log to
 * send: its history is read from Bitcoin (P5.13).
 */
export function encodeSubmission(submission: Submission): string {
  return JSON.stringify({
    original: submission.original,
    entry: submission.entry,
    resources: Object.fromEntries(Object.entries(submission.resources).map(([digest, bytes]) => [digest, base64.encode(bytes)])),
    identities: submission.identities.flatMap((i) => {
      const log = logText(i.log);
      return log === undefined ? [] : [{ did: i.did, log, ...(i.witness !== undefined ? { witness: i.witness } : {}) }];
    }),
  });
}

/** The host answered something other than accepted, already accepted or stale parent: an error, never an answer. */
export class SubmitRefusedError extends OriginalsError {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    const error = typeof (body as { error?: unknown } | null)?.error === "string" ? (body as { error: string }).error : undefined;
    super("invalid-evidence", "SUBMIT_REFUSED", `the host refused the save: ${status}${error ? ` ${error}` : ""}`, { status, body });
    this.name = "SubmitRefusedError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Read the submit route's answer: 200 accepted or already accepted, 409
 * stale parent (P6.7, P6.8). Anything else is a `SubmitRefusedError` with
 * the status and body, never an answer. `OriginalsSDK.submit` checks the
 * answer again before acting on it.
 */
export function readHostAnswer(status: number, body: unknown): HostAnswer {
  const b = body as Partial<Record<"status" | "checkpoint" | "head", unknown>> | null;
  if (status === 200 && (b?.status === "accepted" || b?.status === "already-accepted")) return b as HostAnswer;
  if (status === 409 && b?.status === "stale-parent") return b as HostAnswer;
  throw new SubmitRefusedError(status, body);
}

export interface HttpSharedHostOptions {
  /** The SDK that reads back the host's accepted log (`retrieveHosted`). */
  sdk: { retrieveHosted(aliasDid: string, fetch: HostedFetch): Promise<EvidenceContents> };
  /** The Original's did:webvh alias on that host. */
  aliasDid: string;
  /** Reads the alias's public files; `hostedFetch()` in a browser. */
  read: HostedFetch;
  /**
   * Sends one encoded submission and returns the HTTP status and parsed JSON
   * body. The transport is the app's (its own API, cookies, auth). Default:
   * `POST <submitBase>/<site key>` with `fetch`, the app's session cookie included.
   */
  send?: (siteKey: string, body: string) => Promise<{ status: number; body: unknown }>;
  /** For the default `send`: the submit route's base URL. Defaults to `/api/originals/submit`. */
  submitBase?: string;
}

/**
 * A `SharedHost` for an `@originals/host` instance (P6.7, P6.8): `submit`
 * posts the encoded submission to the Original's submit route; `accepted`
 * reads the host's accepted log through the alias's public URLs, which
 * `sync` and `reconcile` verify before using any of it.
 */
export function httpSharedHost(options: HttpSharedHostOptions): SharedHost {
  const siteKey = siteKeyOf(options.aliasDid);
  const send = options.send ?? (async (key: string, body: string) => {
    const response = await globalThis.fetch(`${options.submitBase ?? "/api/originals/submit"}/${key}`, {
      method: "POST", headers: { "content-type": "application/json" }, body, credentials: "include",
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      // Not JSON: kept as text for the refusal.
    }
    return { status: response.status, body: parsed };
  });
  return {
    async submit(submission) {
      const { status, body } = await send(siteKey, encodeSubmission(submission));
      return readHostAnswer(status, body);
    },
    accepted() {
      return options.sdk.retrieveHosted(options.aliasDid, options.read);
    },
  };
}

// ---------------------------------------------------------------- hosted publication

/**
 * The did:webvh alias an Original's state lists, its web publication (P3.6),
 * or undefined.
 */
export function webvhAlias(aliases: readonly string[]): string | undefined {
  return aliases.find((a) => a.startsWith("did:webvh:"));
}

/**
 * The alias path segment originals.build and the apps built on it use for an
 * Original: `o-` and the first 16 characters of its did:vh SCID, so an alias
 * is at `<domain>/user-<sub16>/o-<scid16>`. A naming convention, not a
 * protocol rule: any did:webvh whose log points back to the Original is an
 * alias (P3.6).
 */
export function aliasSegment(original: string): string {
  if (!original.startsWith("did:vh:") || original.length <= "did:vh:".length) {
    throw new OriginalsError("invalid-evidence", "INPUT_INVALID", `${original} is not a did:vh`);
  }
  return `o-${original.slice("did:vh:".length, "did:vh:".length + 16)}`;
}

/**
 * The order to upload a publication's files in: the alias log and witness
 * first, then the asset log, then signer histories and the manifest, then
 * resources. `@originals/host` labels a resource with the media type its
 * asset log signs, so that log must already be there (P9.7).
 */
export function uploadOrder(path: string): number {
  if (!path.startsWith(HOSTED_PREFIX)) return 0;
  if (path === `${HOSTED_PREFIX}asset/did.jsonl`) return 1;
  return path.startsWith(`${HOSTED_PREFIX}resources/`) ? 3 : 2;
}

/**
 * `hostedFiles` in upload order (`uploadOrder`, then by path), each with the
 * key to put it at on the host: `<site key>/<path>`. Upload them in this
 * order; a retry uploads the same files again (P9.2).
 */
export async function publicationUploads(
  sdk: Parameters<typeof hostedFiles>[0],
  did: string,
  alias: AliasEvidence,
  options: { checkpoint?: string } = {},
): Promise<Array<{ key: string; path: string; bytes: Uint8Array }>> {
  const base = siteKeyOf(alias.did);
  return [...(await hostedFiles(sdk, did, alias, options))]
    .sort(([a], [b]) => uploadOrder(a) - uploadOrder(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, bytes]) => ({ key: `${base}/${path}`, path, bytes }));
}

// ---------------------------------------------------------------- reading a report's reasons

/**
 * Reasons that say something true about an Original without anything being
 * wrong with what was verified. `not-anchored`: an unanchored Original is
 * valid only as of its checkpoint and is never current (P7.10); every
 * unanchored result carries it, so an app showing a valid, unanchored
 * Original shows `validAsOf` with it rather than a failure.
 */
export const INFORMATIONAL_REASONS: ReadonlySet<string> = new Set(["not-anchored"]);

/**
 * The reasons that need the user's attention: every reason but the
 * informational ones. An unanchored Original that verifies has none; any
 * other reason (incomplete identity evidence, a fork, a stale copy, a digest
 * failure) stays.
 */
export function blockingReasons(reasons: readonly string[]): string[] {
  return reasons.filter((r) => !INFORMATIONAL_REASONS.has(r));
}
