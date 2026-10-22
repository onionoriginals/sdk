/**
 * `@originals/vh/fetch`: SSRF-safe retrieval of logs, witness files and
 * resources (P8.5 and the VH-Log retrieval rules; plan 011, PR 7b).
 *
 * - HTTPS only, no credentials in the URL.
 * - Every address a hostname resolves to must be public; IP literals are
 *   checked the same way. The connection goes to a vetted address, so a
 *   second DNS answer cannot rebind it.
 * - Redirects are never followed: a 3xx is a refusal.
 * - Size is bounded by the declared length and by the bytes that arrive, and
 *   the whole request is bounded in time. A caller's `signal` (for example a
 *   whole-operation deadline) can end it sooner.
 *
 * Every refusal is an `unavailable-bytes` error: the caller reports the item
 * as unavailable, never as verified. A refused response is closed at once
 * (its request is aborted, so the socket is released), and a refusal after
 * the response arrived carries `details.bytesRead`: the body bytes actually
 * read before it was refused (0 for a redirect, a non-2xx status or an
 * oversized declared length, which are refused unread). A whole-operation
 * budget can count them. The default transport and resolver use
 * Node's `https` and `dns`, loaded lazily, so importing this entry is safe in
 * a browser; fetching with the defaults needs Node.
 */
import { OriginalsError } from "../errors.js";

export const FETCH_LIMITS = Object.freeze({
  /** PROVISIONAL (P7.7; P14.13): the profile's cap on one retrieved log file. */
  maxBytes: 16 * 1024 * 1024,
  /** PROVISIONAL (P8.5; P14.13, section 14): the cap on one retrieved resource. */
  maxResourceBytes: 64 * 1024 * 1024,
  timeoutMs: 15_000,
});

export interface FetchResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
}

/** Make one GET request to `url`, connecting to `address`. Tests inject one. */
export type FetchTransport = (request: { url: URL; address: string; signal: AbortSignal }) => Promise<FetchResponse>;

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  /** Ends the request early, as a timeout does; the refusal is FETCH_ABORTED. */
  signal?: AbortSignal;
  /** Resolve a hostname to every address it has. Defaults to Node's `dns.lookup` with `all: true`. */
  resolve?: (hostname: string) => Promise<string[]>;
  transport?: FetchTransport;
}

export interface FetchedFile {
  url: string;
  bytes: Uint8Array;
  mediaType?: string;
}

function refuse(code: string, message: string, details?: Record<string, unknown>): never {
  throw new OriginalsError("unavailable-bytes", code, message, details);
}

// ---------------------------------------------------------------------------
// Address classification

function ipv4(text: string): number[] | undefined {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p))) return undefined;
  const bytes = parts.map(Number);
  return bytes.every((b) => b <= 255) ? bytes : undefined;
}

function ipv6(text: string): number[] | undefined {
  let s = text;
  if (s.includes(".")) {
    // A trailing dotted IPv4 part (::ffff:1.2.3.4) becomes its two hex groups.
    const lastColon = s.lastIndexOf(":");
    const v4 = ipv4(s.slice(lastColon + 1));
    if (!v4) return undefined;
    s = `${s.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const group = (h: string) => (h === "" ? [] : h.split(":"));
  const head = group(halves[0]);
  const rest = halves.length === 2 ? group(halves[1]) : [];
  if (![...head, ...rest].every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return undefined;
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const words = [...head, ...new Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest].map((g) => parseInt(g, 16));
  return words.flatMap((w) => [w >> 8, w & 0xff]);
}

function v4Public([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this network, private, loopback, multicast and reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // shared address space
  if (a === 169 && b === 254) return false; // link-local, including cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

/** True only for a syntactically valid, globally routable unicast address. */
export function isPublicAddress(address: string): boolean {
  const text = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const v4 = ipv4(text);
  if (v4) return v4Public(v4);
  const v6 = ipv6(text);
  if (!v6) return false;
  const zero = (from: number, to: number) => v6.slice(from, to).every((b) => b === 0);
  if (zero(0, 10) && v6[10] === 0xff && v6[11] === 0xff) return v4Public(v6.slice(12)); // IPv4-mapped
  if (zero(0, 8) && v6[8] === 0xff && v6[9] === 0xff && zero(10, 12)) return v4Public(v6.slice(12)); // IPv4-translated
  if (v6[0] === 0x00 && v6[1] === 0x64 && v6[2] === 0xff && v6[3] === 0x9b && zero(4, 12)) return v4Public(v6.slice(12)); // NAT64
  if (zero(0, 16) || (zero(0, 15) && v6[15] === 1)) return false; // unspecified, loopback
  if (zero(0, 12)) return false; // IPv4-compatible (deprecated)
  if ((v6[0] & 0xfe) === 0xfc) return false; // unique local
  if (v6[0] === 0xfe && (v6[1] & 0xc0) === 0x80) return false; // link-local
  if (v6[0] === 0xff) return false; // multicast
  if (v6[0] === 0x20 && v6[1] === 0x01 && v6[2] === 0x0d && v6[3] === 0xb8) return false; // documentation
  if (v6[0] === 0x00 && v6[1] === 0x64 && v6[2] === 0xff && v6[3] === 0x9b && v6[4] === 0x00 && v6[5] === 0x01) return false; // local-use NAT64
  if (v6[0] === 0x20 && v6[1] === 0x02) return false; // 6to4, which embeds an IPv4 address
  if (v6[0] === 0x20 && v6[1] === 0x01 && (v6[2] & 0xfe) === 0x00) return false; // IETF protocol assignments, incl. Teredo
  if (v6[0] === 0xfe && (v6[1] & 0xc0) === 0xc0) return false; // site-local (deprecated)
  if (v6[0] === 0x01 && v6[1] === 0x00 && zero(2, 8)) return false; // discard-only
  return true;
}

// ---------------------------------------------------------------------------
// Defaults (Node, loaded lazily)

async function nodeResolve(hostname: string): Promise<string[]> {
  const dns = await import("node:dns/promises");
  const answers = await dns.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => a.address);
}

const nodeTransport: FetchTransport = async ({ url, address, signal }) => {
  const https = await import("node:https");
  return new Promise<FetchResponse>((resolve, reject) => {
    const request = https.request(
      {
        host: address,
        // TLS verifies the certificate against the hostname, not the address. SNI never carries
        // an IP address (RFC 6066), so an IP-literal locator sends none.
        ...(/^[\d.]+$|^\[/.test(url.hostname) ? {} : { servername: url.hostname }),
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { host: url.host, accept: "*/*" },
        signal,
        agent: false,
      },
      (response) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(response.headers)) if (typeof v === "string") headers[k] = v;
        resolve({ status: response.statusCode ?? 0, headers, body: response as AsyncIterable<Uint8Array> });
      },
    );
    request.on("error", reject);
    request.end();
  });
};

// ---------------------------------------------------------------------------

/** Retrieve one file under the rules above. */
export async function safeFetch(locator: string, options: SafeFetchOptions = {}): Promise<FetchedFile> {
  const maxBytes = options.maxBytes ?? FETCH_LIMITS.maxBytes;
  const timeoutMs = options.timeoutMs ?? FETCH_LIMITS.timeoutMs;
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    refuse("FETCH_URL", `${locator} is not a URL`);
  }
  if (url.protocol !== "https:") refuse("FETCH_SCHEME", `only https is retrieved, not ${url.protocol}`);
  if (url.username || url.password) refuse("FETCH_CREDENTIALS", "a locator may not carry credentials");

  if (options.signal?.aborted) refuse("FETCH_ABORTED", `${url.href} was not requested: the caller aborted`);

  // The whole request, DNS included, is bounded in time and by the caller's signal.
  const controller = new AbortController();
  let callerAborted = false;
  const onCallerAbort = () => {
    callerAborted = true;
    controller.abort();
  };
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const done = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  };
  const stopped = (what: string, details?: Record<string, unknown>): never =>
    callerAborted ? refuse("FETCH_ABORTED", `${what}: the caller aborted`, details) : refuse("FETCH_TIMEOUT", `${what} within ${timeoutMs} ms`, details);
  const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("timeout"))));
  aborted.catch(() => undefined);
  const host = url.hostname;
  const literal = host.startsWith("[") || ipv4(host) !== undefined;
  let addresses: string[];
  if (literal) addresses = [host.replace(/^\[|\]$/g, "")];
  else {
    try {
      addresses = await Promise.race([(options.resolve ?? nodeResolve)(host), aborted]);
    } catch {
      done();
      if (controller.signal.aborted) stopped(`${host} did not resolve`);
      refuse("FETCH_DNS", `${host} does not resolve`);
    }
  }
  if (addresses.length === 0) {
    done();
    refuse("FETCH_DNS", `${host} does not resolve`);
  }
  const blocked = addresses.find((a) => !isPublicAddress(a));
  if (blocked) {
    done();
    refuse("FETCH_PRIVATE_ADDRESS", `${host} resolves to ${blocked}, which is not a public address`);
  }

  let size = 0;
  let succeeded = false;
  // A refusal of an arrived response reports the body bytes read so far.
  const refuseRead = (code: string, message: string): never => refuse(code, message, { bytesRead: size });
  try {
    const response = await (options.transport ?? nodeTransport)({ url, address: addresses[0], signal: controller.signal });
    if (response.status >= 300 && response.status < 400) refuseRead("FETCH_REDIRECT", `${url.href} redirects; redirects are not followed`);
    if (response.status < 200 || response.status >= 300) refuseRead("FETCH_STATUS", `${url.href} answered ${response.status}`);
    const declared = Number(response.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) refuseRead("FETCH_TOO_LARGE", `${url.href} is ${declared} bytes; the cap is ${maxBytes}`);
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) refuseRead("FETCH_TOO_LARGE", `${url.href} exceeds the ${maxBytes}-byte cap`);
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.length;
    }
    const mediaType = response.headers["content-type"];
    succeeded = true;
    return { url: url.href, bytes, ...(mediaType ? { mediaType } : {}) };
  } catch (error) {
    if (error instanceof OriginalsError) throw error;
    if (controller.signal.aborted) stopped(`${url.href} did not answer`, { bytesRead: size });
    return refuse("FETCH_FAILED", `${url.href} could not be retrieved`, { bytesRead: size });
  } finally {
    done();
    // Any refusal closes the response: aborting the request destroys its socket (#962 review R5).
    if (!succeeded) controller.abort();
  }
}
