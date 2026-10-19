/**
 * did:webvh on VH-Log (decentralized-identity/didwebvh PR 302, spec-exp, method
 * value `did:webvh:1.0`), for verifying author DIDs and web aliases. Logs are
 * passed directly; retrieval from the DID's HTTPS location lands with the
 * SSRF-safe fetcher (plan 011, PR 7).
 *
 * Domains must already be ASCII (IDNA A-labels). IDNA2008 processing of
 * Unicode domains is not implemented, so such DIDs are rejected rather than
 * mapped (fail closed).
 */
import { OriginalsError, fail } from "../errors.js";
import { isJsonObject, type JsonObject } from "../json/index.js";
import { verifyLog, type Specialisation, type VersionRules } from "../log/index.js";
import {
  checkResolutionOptions,
  entriesOf,
  failure,
  finishResolution,
  type DidVhResolution,
  type DidVhResolutionOptions,
} from "../didvh/index.js";

export const DID_WEBVH_1_0: VersionRules = Object.freeze({
  vhLog: "vh-log:1.0",
  rank: 1,
  entrySuites: ["eddsa-jcs-2022"],
  witnessSuites: ["eddsa-jcs-2022"],
}) as VersionRules;

export interface DidWebvhParts {
  scid: string;
  /** ASCII domain name. */
  host: string;
  port?: number;
  /** Percent-decoded deployment path segments. */
  path: string[];
}

const SCID = /^[1-9A-HJ-NP-Za-km-z]{46}$/;
const IDCHAR_OR_PCT = /^(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+$/;

function invalid(message: string): never {
  throw new OriginalsError("invalid-evidence", "WEBVH_DID_INVALID", message);
}

function decodeOnce(component: string): string {
  if (/%(?![0-9A-Fa-f]{2})/.test(component)) invalid("invalid percent-encoding");
  try {
    return decodeURIComponent(component);
  } catch {
    return invalid("invalid percent-encoding");
  }
}

/** Parse and validate a bare did:webvh DID (did:webvh "Method-Specific Identifier"). */
export function parseDidWebvh(did: string): DidWebvhParts {
  if (typeof did !== "string" || !did.startsWith("did:webvh:")) invalid("not a did:webvh DID");
  const rest = did.slice("did:webvh:".length);
  if (/[/?#]/.test(rest)) invalid("a did:webvh DID has no path, query or fragment");
  const [scid, domainComponent, ...pathComponents] = rest.split(":");
  if (!SCID.test(scid ?? "")) invalid("the SCID segment is not 46 base58btc characters");
  if (!domainComponent) invalid("the domain is missing");

  // Domain, with an optional %3A port at the end.
  const portMatch = /%3A(\d{1,5})$/i.exec(domainComponent);
  const domainPart = portMatch ? domainComponent.slice(0, portMatch.index) : domainComponent;
  if (/%3A/i.test(domainPart)) invalid("a percent-encoded colon may appear only as the port separator");
  if (!/^(?:[A-Za-z0-9-]|%[0-9A-Fa-f]{2})+(?:\.(?:[A-Za-z0-9-]|%[0-9A-Fa-f]{2})+)+$/.test(domainPart)) invalid("the domain is not a dotted domain name");
  const host = decodeOnce(domainPart);
  if (!/^[\x21-\x7e]+$/.test(host)) invalid("Unicode domains must be given as IDNA A-labels");
  const labels = host.split(".");
  if (host.length > 253 || labels.some((l) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(l))) invalid("the domain has an invalid DNS label");
  // A last label that a URL parser reads as a number makes the host an IPv4 address.
  if (/^(?:\d+|0x[0-9a-f]*)$/i.test(labels[labels.length - 1])) invalid("the domain must not be an IP address");
  let port: number | undefined;
  if (portMatch) {
    port = Number(portMatch[1]);
    if (port < 1 || port > 65535) invalid("the port must be between 1 and 65535");
  }

  const path = pathComponents.map((component) => {
    if (!IDCHAR_OR_PCT.test(component)) invalid("a path segment has characters outside idchar");
    const decoded = decodeOnce(component);
    if (decoded === "." || decoded === ".." || /[/\\]/.test(decoded) || decoded.includes("\u0000") || /^\s|\s$/.test(decoded)) invalid("a path segment is not allowed");
    return decoded;
  });
  return { scid, host, ...(port ? { port } : {}), path };
}

function encodeSegment(segment: string): string {
  return Array.from(new TextEncoder().encode(segment), (b) => {
    const c = String.fromCharCode(b);
    return /[A-Za-z0-9._~-]/.test(c) ? c : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

function origin(parts: DidWebvhParts): string {
  return `https://${parts.host}${parts.port ? `:${parts.port}` : ""}`;
}

/** The DID-to-HTTPS transformation: where `did.jsonl` is published. */
export function didWebvhLogUrl(did: string): string {
  const parts = parseDidWebvh(did);
  const path = parts.path.map(encodeSegment).join("/");
  return `${origin(parts)}/${path ? `${path}/` : ".well-known/"}did.jsonl`;
}

/** The base URL of the implicit `#files` service. */
export function didWebvhFilesUrl(did: string): string {
  const parts = parseDidWebvh(did);
  const path = parts.path.map(encodeSegment).join("/");
  return `${origin(parts)}/${path ? `${path}/` : ""}`;
}

function withImplicitServices(document: JsonObject): JsonObject {
  const did = document.id as string;
  const services = Array.isArray(document.service) ? [...(document.service as JsonObject[])] : [];
  const has = (fragment: string) => services.some((s) => isJsonObject(s) && (s.id === `${did}#${fragment}` || s.id === `#${fragment}`));
  const files = didWebvhFilesUrl(did);
  if (!has("files")) services.push({ id: `${did}#files`, type: ["PathHandler", "PathService"], path: "/", serviceEndpoint: files });
  if (!has("whois")) {
    services.push({
      "@context": "https://identity.foundation/linked-vp/contexts/v1",
      id: `${did}#whois`, type: ["PathHandler", "PathService", "whois"], path: "/whois", serviceEndpoint: `${files}whois.vp`,
    });
  }
  return { ...document, service: services };
}

/** The did:webvh specialisation: the state is the DID document. */
export const didWebvh: Specialisation = {
  name: "did:webvh",
  versionParameter: "method",
  versions: { "did:webvh:1.0": DID_WEBVH_1_0 },
  extraParameters: { portable: (value) => typeof value === "boolean" },
  keys: { kind: "updateKeys" },
  validateEntry: ({ entry, previous, scid, active }) => {
    if (previous && entry.parameters.portable === true) {
      fail("invalid-evidence", "WEBVH_PORTABLE_LATE", "portable can be enabled only in the first entry");
    }
    const id = entry.state.id;
    let parts: DidWebvhParts;
    try {
      parts = parseDidWebvh(id as string);
    } catch {
      return fail("invalid-evidence", "WEBVH_STATE_ID", "state.id is not a valid did:webvh DID");
    }
    if (parts.scid !== scid) fail("invalid-evidence", "WEBVH_STATE_ID", "state.id does not carry the log's SCID");
    const prior = previous?.entry.state.id;
    if (prior !== undefined && prior !== id) {
      if (active.extra.portable !== true) fail("invalid-evidence", "WEBVH_NOT_PORTABLE", "the DID moved, but portable was not set at genesis");
      const aka = entry.state.alsoKnownAs;
      if (!Array.isArray(aka) || !aka.includes(prior)) fail("invalid-evidence", "WEBVH_MOVE_ALSO_KNOWN_AS", "a moved DID must list its prior DID in alsoKnownAs");
    }
  },
};

export async function resolveDidWebvh(did: string, options: DidVhResolutionOptions): Promise<DidVhResolution> {
  let parts: DidWebvhParts;
  try {
    parts = parseDidWebvh(did);
  } catch (error) {
    if (error instanceof OriginalsError) return failure("invalidDid", error.message, error.code);
    throw error;
  }
  const invalidOptions = checkResolutionOptions(options);
  if (invalidOptions) return invalidOptions;
  const entries = entriesOf(options);
  if (!Array.isArray(entries)) return entries;
  const log = await verifyLog(entries, { specialisation: didWebvh, witnessFile: options.didWitness, now: options.now, limits: options.limits });
  if (log.entries.length > 0) {
    if (log.scid !== parts.scid) return failure("invalidDid", "the log's SCID is not the DID's");
    if (!log.entries.some((v) => v.entry.state.id === did)) return failure("invalidDid", "no entry's state.id is the DID being resolved");
  }
  return finishResolution(log, entries, options, (selected) => withImplicitServices(selected.entry.state));
}
