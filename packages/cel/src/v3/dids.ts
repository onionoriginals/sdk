import { normalizeAssetId } from "./identity.js";
import { base58 } from "@scure/base";
import { CelError, requireThat } from "./errors.js";
import { validateDigest } from "./primitives.js";
import { MAX_SATOSHI_SUPPLY } from "../utils/satoshi-validation.js";

export type BitcoinNetwork = "mainnet" | "signet" | "regtest" | "testnet";
export type AssetAlias =
  | { layer: "cel"; did: string }
  | {
      layer: "webvh";
      did: string;
      scid: string;
      logUrl: string;
      methodBinding: "unverified";
    }
  | { layer: "btco"; did: string; network: BitcoinNetwork; sat: string };

/**
 * Canonically percent-encode a decoded WebVH path segment for the HTTPS log
 * path spelling: `encodeURIComponent`, then force-escape the sub-delims
 * `encodeURIComponent` itself leaves literal (`!'()*`). RFC 3986 leaves the
 * unreserved `~` untouched, so this spelling does too. Module-private: the
 * DID spelling below is the only one authoring code needs.
 */
function encodeWebVHHttpPathSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Canonically percent-encode a decoded WebVH path segment for the DID
 * method-specific-id spelling: the HTTPS spelling above, except DID Core's
 * `idchar` excludes a literal `~`, so it must read back as `%7E`. Authoring
 * code (e.g. `WebVHManager.createDIDWebVH`) uses this so a caller-supplied
 * DECODED path segment survives a canonical did:webvh round-trip instead of
 * failing {@link parseAssetAlias}'s allow-list on first publish. Input is
 * always the decoded segment: a pre-encoded `hello%21world` is encoded again
 * (`hello%2521world`).
 */
export function encodeWebVHPathSegment(value: string): string {
  return encodeWebVHHttpPathSegment(value).replace(/~/g, "%7E");
}

/** A decoded WebVH path segment `parseAssetAlias` reads back: non-empty, not `.`/`..`, no `/`, `\`, NUL, no edge whitespace, well-formed UTF-16. */
export function isWebVHPathSegment(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value === "." ||
    value === ".." ||
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
  | { ok: false; reason: "invalid" | "reserved" } {
  if (!Array.isArray(paths) || !paths.every(isWebVHPathSegment))
    return { ok: false, reason: "invalid" };
  // [".well-known"] would host its log where the no-path DID's lives.
  if (paths[0]?.toLowerCase() === ".well-known")
    return { ok: false, reason: "reserved" };
  return { ok: true, segments: paths.map(encodeWebVHPathSegment) };
}

/** Host checks shared by `parseAssetAlias` and `canonicalizeWebVHDomain`; `code` names the failing seam. */
function assertWebVHDnsHost(host: string, code: string): void {
  // Unicode IDNA2008 method validation needs its own implementation, not WHATWG's UTS-46 substitute.
  if ([...host].some((c) => c.charCodeAt(0) > 127) || /(^|\.)xn--/i.test(host))
    throw new CelError(
      "unsupported",
      "CEL_WEBVH_IDNA",
      "WebVH IDNA2008 validation is not available in this core",
    );
  requireThat(
    host.length <= 253 &&
      host.includes(".") &&
      host
        .split(".")
        .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),
    code,
    "Expected canonical fully qualified DNS name",
  );
  let parsed: URL;
  try {
    parsed = new URL("https://" + host);
  } catch {
    throw new CelError("invalid", code, "Invalid WebVH DNS host");
  }
  // URL equality also rejects WHATWG IPv4 shorthands such as `1.2.3`.
  requireThat(
    parsed.hostname === host && !/^\d+\.\d+\.\d+\.\d+$/.test(host),
    code,
    "WebVH requires DNS, not an IP address",
  );
}

/** Trim, lowercase and validate an authoring-input WebVH host[:port]; returns the WHATWG `URL#host` spelling (default :443 dropped, port leading zeros removed). */
export function canonicalizeWebVHDomain(
  domain: string,
  options: { allowLocalhost?: boolean } = {},
): string {
  const match = /^([^:]*)(?::(\d{1,5}))?$/.exec(String(domain).trim().toLowerCase());
  const port = match?.[2] === undefined ? 443 : +match[2];
  requireThat(
    match && port >= 1 && port <= 65535,
    "INVALID_DOMAIN",
    `Invalid WebVH domain: ${JSON.stringify(domain)} is not host[:port] with a port of 1-65535`,
  );
  const host = match[1];
  if (!(options.allowLocalhost && host === "localhost"))
    assertWebVHDnsHost(host, "INVALID_DOMAIN");
  return port === 443 ? host : `${host}:${port}`;
}

/** Parse a bare canonical asset alias. WebVH syntax never proves its separate method-log binding.
 * The `layer` discriminator names the Originals lifecycle stage (cel/webvh/btco); it is not a
 * claim that every alias is a DID. Only the webvh/btco spellings are actual DID methods.
 */
export function parseAssetAlias(did: unknown): AssetAlias {
  requireThat(
    typeof did === "string" && did.length <= 8192,
    "CEL_DID",
    "Expected a bare asset alias",
  );
  if (did.startsWith("ni:")) {
    return { layer: "cel", did: normalizeAssetId(did) };
  }
  // Retained parser compatibility for reading authenticated SDK 3 history/aliases;
  // this is an Originals 3.0 alias, not DID-method resolution, and is not offered
  // as new migration/authoring input.
  if (did.startsWith("did:cel:")) {
    validateDigest(did.slice(8));
    return { layer: "cel", did };
  }
  if (did.startsWith("did:btco:")) {
    const match = /^did:btco:(?:(reg|sig|test):)?(0|[1-9]\d{0,15})$/.exec(did);
    requireThat(
      match && BigInt(match[2]) <= BigInt(MAX_SATOSHI_SUPPLY),
      "CEL_DID",
      "Invalid network or canonical sat number",
    );
    const network: BitcoinNetwork =
      match[1] === "reg"
        ? "regtest"
        : match[1] === "sig"
          ? "signet"
          : match[1] === "test"
            ? "testnet"
            : "mainnet";
    return { layer: "btco", did, network, sat: match[2] };
  }
  requireThat(
    did.startsWith("did:webvh:"),
    "CEL_DID",
    "Unsupported asset DID method",
  );
  const [scid, domain, ...path] = did.slice(10).split(":");
  requireThat(
    /^[1-9A-HJ-NP-Za-km-z]{46}$/.test(scid),
    "CEL_DID",
    "Invalid WebVH SCID encoding",
  );
  const multihash = base58.decode(scid);
  requireThat(
    multihash.length === 34 &&
      multihash[0] === 0x12 &&
      multihash[1] === 0x20 &&
      base58.encode(multihash) === scid,
    "CEL_DID",
    "WebVH SCID must be a SHA-256 multihash",
  );
  requireThat(
    typeof domain === "string" &&
      /^(?:[A-Za-z0-9.-]|%[0-9A-Fa-f]{2})+$/.test(domain),
    "CEL_DID",
    "Invalid WebVH domain",
  );
  let decoded: string;
  try {
    decoded = decodeURIComponent(domain);
  } catch {
    throw new CelError("invalid", "CEL_DID", "Invalid WebVH domain encoding");
  }
  const [host, ...port] = decoded.split(":");
  assertWebVHDnsHost(host, "CEL_DID");
  requireThat(
    port.length === 0 ||
      (port.length === 1 && /^[1-9]\d{0,4}$/.test(port[0]) && +port[0] <= 65535),
    "CEL_DID",
    "Invalid WebVH port",
  );
  requireThat(
    domain === host + (port.length ? "%3A" + port[0] : ""),
    "CEL_DID",
    "Noncanonical WebVH domain spelling",
  );
  // A path segment is canonicalized two ways: the DID method-specific-id spelling
  // (DID Core's `idchar` excludes a literal `~`, so it must read back as `%7E`) and
  // the WebVH HTTPS log path spelling (RFC 3986 leaves the unreserved `~` literal).
  // They agree on every other escaped character; only `~` diverges between the two.
  const httpEncodedPath = path.map((segment) => {
    requireThat(
      /^(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+$/.test(segment),
      "CEL_DID",
      "Invalid WebVH path component",
    );
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      throw new CelError("invalid", "CEL_DID", "Invalid WebVH path encoding");
    }
    requireThat(
      isWebVHPathSegment(value),
      "CEL_DID",
      "Invalid decoded WebVH path",
    );
    const httpEncoded = encodeWebVHHttpPathSegment(value);
    const didEncoded = encodeWebVHPathSegment(value);
    requireThat(
      didEncoded === segment,
      "CEL_DID",
      "Noncanonical WebVH path spelling",
    );
    return httpEncoded;
  });
  return {
    layer: "webvh",
    did,
    scid,
    logUrl:
      "https://" +
      decoded +
      "/" +
      (httpEncodedPath.length ? httpEncodedPath.join("/") : ".well-known") +
      "/did.jsonl",
    methodBinding: "unverified",
  };
}
