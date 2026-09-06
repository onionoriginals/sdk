import { base58 } from "@scure/base";
import { CelError, requireThat } from "./errors.js";
import { validateDigest } from "./primitives.js";
import { MAX_SATOSHI_SUPPLY } from "../utils/satoshi-validation.js";

export type BitcoinNetwork = "mainnet" | "signet" | "regtest" | "testnet";
export type AssetDid =
  | { method: "cel"; did: string }
  | {
      method: "webvh";
      did: string;
      scid: string;
      logUrl: string;
      methodBinding: "unverified";
    }
  | { method: "btco"; did: string; network: BitcoinNetwork; sat: string };
/** Parse a bare canonical asset alias. WebVH syntax never proves its separate method-log binding. */
export function parseAssetDid(did: unknown): AssetDid {
  requireThat(
    typeof did === "string" && did.length <= 8192,
    "CEL_DID",
    "Expected a bare asset DID",
  );
  if (did.startsWith("did:cel:")) {
    validateDigest(did.slice(8));
    return { method: "cel", did };
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
    return { method: "btco", did, network, sat: match[2] };
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
  // Unicode IDNA2008 method validation needs its own implementation, not WHATWG's UTS-46 substitute.
  if (
    [...decoded].some((c) => c.charCodeAt(0) > 127) ||
    /(^|\.)xn--/i.test(decoded)
  )
    throw new CelError(
      "unsupported",
      "CEL_WEBVH_IDNA",
      "WebVH IDNA2008 validation is not available in this core",
    );
  const match = /^([^:]+)(?::([1-9]\d{0,4}))?$/.exec(decoded);
  requireThat(
    match && (!match[2] || +match[2] <= 65535),
    "CEL_DID",
    "Invalid WebVH port",
  );
  const host = match[1];
  requireThat(
    host.length <= 253 &&
      host.includes(".") &&
      host
        .split(".")
        .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),
    "CEL_DID",
    "Expected canonical fully qualified DNS name",
  );
  let parsed: URL;
  try {
    parsed = new URL("https://" + decoded);
  } catch {
    throw new CelError("invalid", "CEL_DID", "Invalid WebVH DNS host");
  }
  requireThat(
    parsed.hostname === host && !/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname),
    "CEL_DID",
    "WebVH requires DNS, not an IP address",
  );
  requireThat(
    domain === host + (match[2] ? "%3A" + match[2] : ""),
    "CEL_DID",
    "Noncanonical WebVH domain spelling",
  );
  const encodedPath = path.map((segment) => {
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
      value &&
        value !== "." &&
        value !== ".." &&
        !value.includes("/") &&
        !value.includes("\\") &&
        !value.includes("\0") &&
        value.trim() === value,
      "CEL_DID",
      "Invalid decoded WebVH path",
    );
    const encoded = encodeURIComponent(value).replace(
      /[!'()*]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    );
    requireThat(
      encoded === segment,
      "CEL_DID",
      "Noncanonical WebVH path spelling",
    );
    return encoded;
  });
  return {
    method: "webvh",
    did,
    scid,
    logUrl:
      "https://" +
      decoded +
      "/" +
      (encodedPath.length ? encodedPath.join("/") : ".well-known") +
      "/did.jsonl",
    methodBinding: "unverified",
  };
}
