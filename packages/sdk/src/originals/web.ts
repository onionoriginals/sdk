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
import { FETCH_LIMITS } from "@originals/vh/fetch";
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
   * local development, where a dev server proxies the host). The URL's path
   * and query are kept. Without it, only `https:` URLs are fetched.
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
 * A `HostedFetch` over the platform's `fetch`, for browsers and other
 * runtimes where `@originals/vh/fetch`'s `safeFetch` (which resolves and
 * vets addresses with Node) is not available. It refuses as `safeFetch`
 * does, every refusal an `unavailable-bytes` OriginalsError:
 *
 * - `FETCH_SCHEME`: not `https:` (unless `origin` is given)
 * - `FETCH_REDIRECT`: any redirect, which is never followed (P8.5)
 * - `FETCH_STATUS`: any status but 2xx, with `details.status`
 * - `FETCH_TOO_LARGE`: past `maxBytes`, by declared length or as it arrives,
 *   with `details.bytesRead`
 * - `FETCH_ABORTED` / `FETCH_FAILED`: the request was aborted, or the network failed
 *
 * Credentials are never sent and nothing is served from the HTTP cache. A
 * browser cannot vet the addresses a hostname resolves to: a server
 * retrieving on others' behalf should use `safeFetch` instead.
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
    if (options.origin !== undefined) target = new URL(`${target.pathname}${target.search}`, options.origin);
    else if (target.protocol !== "https:") refuse("FETCH_SCHEME", `only https is retrieved, not ${target.protocol}`);
    const maxBytes = request?.maxBytes ?? FETCH_LIMITS.maxResourceBytes;
    let response: Response;
    try {
      response = await doFetch(target.href, { signal: request?.signal, redirect: "manual", credentials: "omit", cache: "no-store" });
    } catch (error) {
      if (request?.signal?.aborted) return refuse("FETCH_ABORTED", `${url}: the request was aborted`, { bytesRead: 0 });
      return refuse("FETCH_FAILED", `${url} could not be retrieved: ${(error as Error)?.message ?? String(error)}`, { bytesRead: 0 });
    }
    const close = () => void response.body?.cancel().catch(() => undefined);
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      close();
      return refuse("FETCH_REDIRECT", `${url} redirects; redirects are not followed`, { bytesRead: 0 });
    }
    if (!response.ok) {
      close();
      return refuse("FETCH_STATUS", `${url} answered ${response.status}`, { status: response.status, bytesRead: 0 });
    }
    const declared = Number(response.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      close();
      return refuse("FETCH_TOO_LARGE", `${url} is ${declared} bytes; the cap is ${maxBytes}`, { bytesRead: 0 });
    }
    const bytes = await readCapped(response, maxBytes, url);
    options.cache?.set(url, bytes);
    return bytes;
  };
}

async function readCapped(response: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  if (!response.body) {
    const all = new Uint8Array(await response.arrayBuffer());
    if (all.length > maxBytes) refuse("FETCH_TOO_LARGE", `${url} exceeds the ${maxBytes}-byte cap`, { bytesRead: all.length });
    return all;
  }
  // Typed locally: DOM and Bun's lib disagree on the reader's type.
  const reader = response.body.getReader() as unknown as { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      size += value.length;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        refuse("FETCH_TOO_LARGE", `${url} exceeds the ${maxBytes}-byte cap`, { bytesRead: size });
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof OriginalsError) throw error;
    refuse("FETCH_FAILED", `${url} could not be read: ${(error as Error)?.message ?? String(error)}`, { bytesRead: size });
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
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
