/**
 * did:webvh authoring-input checks: decoded path segments and host[:port]
 * domains, canonicalized to the spelling a did:webvh identifier uses.
 */
import { StructuredError } from '../utils/telemetry.js';

function requireThat(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new StructuredError(code, message);
}

/**
 * Canonically percent-encode a decoded WebVH path segment for the HTTPS log
 * path spelling: `encodeURIComponent`, then force-escape the sub-delims
 * `encodeURIComponent` itself leaves literal (`!'()*`). RFC 3986 leaves the
 * unreserved `~` untouched, so this spelling does too.
 */
function encodeWebVHHttpPathSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Canonically percent-encode a decoded WebVH path segment for the DID
 * method-specific-id spelling: the HTTPS spelling above, except DID Core's
 * `idchar` excludes a literal `~`, so it must read back as `%7E`. Input is
 * always the decoded segment: a pre-encoded `hello%21world` is encoded again
 * (`hello%2521world`).
 */
export function encodeWebVHPathSegment(value: string): string {
  return encodeWebVHHttpPathSegment(value).replace(/~/g, '%7E');
}

/** A decoded WebVH path segment: non-empty, not `.`/`..`, no `/`, `\`, NUL, no edge whitespace, well-formed UTF-16. */
export function isWebVHPathSegment(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    /[/\\\0]/.test(value) ||
    value.trim() !== value
  )
    return false;
  try {
    encodeURIComponent(value); // throws on a lone surrogate
    return true;
  } catch {
    return false;
  }
}

/** Authoring only: validate decoded `paths`, reserve a leading `.well-known` (case-insensitive), return DID-spelling segments. */
export function canonicalWebVHPaths(
  paths: unknown,
):
  | { ok: true; segments: string[] }
  | { ok: false; reason: 'invalid'; index?: number }
  | { ok: false; reason: 'reserved' } {
  if (!Array.isArray(paths)) return { ok: false, reason: 'invalid' };
  // Array.from turns holes into undefined; Array#every would skip them.
  const segments: unknown[] = Array.from(paths);
  const index = segments.findIndex((segment) => !isWebVHPathSegment(segment));
  if (index !== -1) return { ok: false, reason: 'invalid', index };
  const valid = segments as string[];
  // [".well-known"] would host its log where the no-path DID's lives.
  if (valid[0]?.toLowerCase() === '.well-known')
    return { ok: false, reason: 'reserved' };
  return { ok: true, segments: valid.map(encodeWebVHPathSegment) };
}

function assertWebVHDnsHost(host: string, code: string, allowPunycode = false): void {
  // Unicode IDNA2008 method validation needs its own implementation, not WHATWG's UTS-46 substitute.
  if (
    [...host].some((c) => c.charCodeAt(0) > 127) ||
    (!allowPunycode && /(^|\.)xn--/i.test(host))
  )
    throw new StructuredError('WEBVH_IDNA_UNSUPPORTED', 'WebVH IDNA2008 validation is not available');
  requireThat(
    host.length <= 253 &&
      host.includes('.') &&
      host
        .split('.')
        .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),
    code,
    'Expected canonical fully qualified DNS name',
  );
  let parsed: URL;
  try {
    parsed = new URL('https://' + host);
  } catch {
    throw new StructuredError(code, 'Invalid WebVH DNS host');
  }
  // URL equality also rejects WHATWG IPv4 shorthands such as `1.2.3`.
  requireThat(
    parsed.hostname === host && !/^\d+\.\d+\.\d+\.\d+$/.test(host),
    code,
    'WebVH requires DNS, not an IP address',
  );
}

/**
 * Trim, lowercase and validate an authoring-input WebVH host[:port]; returns
 * the WHATWG `URL#host` spelling (default :443 dropped, port leading zeros
 * removed). `identity` admits `localhost` and punycode hosts.
 */
export function canonicalizeWebVHDomain(
  domain: string,
  options: { identity?: boolean } = {},
): string {
  // ASCII-only lowercase: String#toLowerCase folds U+212A KELVIN SIGN into "k".
  const lowered = String(domain).trim().replace(/[A-Z]+/g, (s) => s.toLowerCase());
  const match = /^([^:]*)(?::(\d+))?$/.exec(lowered);
  const port = match?.[2] === undefined ? 443 : +match[2];
  requireThat(
    match && port >= 1 && port <= 65535,
    'INVALID_DOMAIN',
    `Invalid WebVH domain: ${JSON.stringify(domain)} is not host[:port] with a port of 1-65535`,
  );
  const host = match[1];
  if (!(options.identity && host === 'localhost'))
    assertWebVHDnsHost(host, 'INVALID_DOMAIN', options.identity);
  return port === 443 ? host : `${host}:${port}`;
}
