/**
 * `@originals/sdk/did`: creating and updating did:webvh DIDs in a browser,
 * with no Node built-ins and no bundler shims. The root `@originals/sdk`
 * entry re-exports the whole SDK (DID managers with Node-only log storage,
 * the credential stack, Bitcoin providers), so a web app that imported
 * `createDIDOriginal` from it needed Vite shims for `fs`, `crypto`, `zlib`
 * and `Buffer`. Import DID creation from here instead.
 *
 * Besides `createDIDOriginal` / `updateDIDOriginal` and their signing
 * helpers, it has the identity shape originals.build mints and the apps on it
 * copied (Easel, Commission Desk, the landing):
 *
 *   did:webvh:<scid>:<domain>:user-<sub16>
 *     #key-0  the identity key: the DID's update key and its authentication
 *     #key-1  the authorship key: under assertionMethod, it signs Originals
 *             entries (P5.2, P5.3). Never an update key of the DID (P5.11).
 *
 * and a publication alias for an Original:
 *
 *   did:webvh:<scid>:<domain>:user-<sub16>:o-<scid16>, alsoKnownAs the Original (P3.6)
 */
import { localSigner, multibaseEncode } from "@originals/vh/crypto";
import type { AliasEvidence, AuthorDidEvidence, AuthorRef } from "@originals/vh/originals";
import type { ExternalSigner, ExternalVerifier } from "../types/common.js";
import { StructuredError } from "../utils/telemetry.js";
import { createDIDOriginal, prepareDIDDataForSigning, verifyDIDSignature } from "./identity-operations.js";
import { requireWebVHDomain } from "./webvh-rules.js";

export {
  createDIDOriginal,
  updateDIDOriginal,
  prepareDIDDataForSigning,
  verifyDIDSignature,
  type CreateDIDOriginalOptions,
  type UpdateDIDOriginalOptions,
  type OriginalResult,
  type VerificationMethodInput,
} from "./identity-operations.js";
export { computeNextKeyHash, normalizeUpdateKey } from "./webvh-rules.js";
export type { ExternalSigner, ExternalVerifier } from "../types/common.js";

/** A did:webvh log signer that can also verify, and names its public key. */
export interface WebvhSigner extends ExternalSigner, ExternalVerifier {
  /** `did:key:<multikey>`: the update key it signs with. */
  getVerificationMethodId(): string;
  getPublicKeyMultibase(): string;
}

/** The identity key's fragment: update key and authentication. */
export const IDENTITY_KEY = "key-0";
/** The authorship key's fragment: assertionMethod, signs Originals entries. */
export const AUTHORSHIP_KEY = "key-1";

/**
 * A `WebvhSigner` over a raw Ed25519 secret key. For development, tests and
 * servers holding their own keys; production browsers keep keys in a custody
 * service (a Turnkey provider, say) behind the same interface.
 */
export function localWebvhSigner(secretKey: Uint8Array): WebvhSigner {
  const key = localSigner("Ed25519", secretKey);
  const multikey = key.publicKeyMultibase;
  return {
    async sign({ document, proof }) {
      return { proofValue: multibaseEncode(await key.sign(await prepareDIDDataForSigning(document, proof))) };
    },
    async verify(signature, message, publicKey) {
      const raw = publicKey.length === 34 && publicKey[0] === 0xed && publicKey[1] === 0x01 ? publicKey.slice(2) : publicKey;
      if (raw.length !== 32) return false;
      return verifyDIDSignature(signature, message, raw);
    },
    getVerificationMethodId: () => `did:key:${multikey}`,
    getPublicKeyMultibase: () => multikey,
  };
}

/**
 * `user-` and the first 16 characters of an account subject: the path
 * segment originals.build gives a user, kept so identities already minted
 * resolve where they are. Two subjects that share their first 16 characters
 * get the same segment, and so the same hosted `did.jsonl`: use it only for
 * subjects whose first 16 characters are unique (a random id such as a
 * Turnkey sub-organization UUID), not for prefixed ids like `auth0|...`.
 */
export function userPathSegment(subject: string): string {
  if (typeof subject !== "string" || subject.length === 0) throw new StructuredError("INPUT_INVALID", "an account subject is a non-empty string");
  return `user-${subject.slice(0, 16)}`;
}

/** A user's did:webvh identity, as an author of Originals. */
export interface WebvhIdentity {
  /** The identity DID: the DID at genesis, which an Original's author reference names (P5.8, P5.14). */
  did: string;
  /** Where the DID is now: the latest document's id (it differs after a did:webvh move). */
  location: string;
  /** The log as JSON Lines, exactly as hosted. */
  log: string;
  /** For `OriginalsSDK.create({ authors })`. */
  evidence: AuthorDidEvidence;
  /** The author reference for entries the authorship key signs: `#key-1` at the latest version. */
  ref: AuthorRef;
}

interface LogLine {
  versionId: string;
  parameters?: { updateKeys?: unknown };
  state: { id?: unknown; verificationMethod?: unknown; assertionMethod?: unknown };
}

/** The log's lines as objects, or INPUT_INVALID: never a raw parse or type error. */
function parseLines(log: string, what: string): LogLine[] {
  let parsed: unknown[];
  try {
    parsed = log.trimEnd().split("\n").map((l) => JSON.parse(l) as unknown);
  } catch {
    throw new StructuredError("INPUT_INVALID", `the ${what} log is not JSON Lines`);
  }
  for (const line of parsed) {
    const ok = typeof line === "object" && line !== null && !Array.isArray(line) &&
      typeof (line as LogLine).state === "object" && (line as LogLine).state !== null &&
      ((line as LogLine).parameters === undefined || (typeof (line as LogLine).parameters === "object" && (line as LogLine).parameters !== null));
    if (!ok) throw new StructuredError("INPUT_INVALID", `the ${what} log has a line that is not a log entry`);
  }
  return parsed as LogLine[];
}

/**
 * The identity a hosted did:webvh log describes. The DID is the genesis
 * DID; the author reference names `#<authorship>` at the latest version's
 * location and versionId (P5.14). The log is not verified here: the SDK
 * verifies it with every Original it signs (P5.6).
 */
export function identityFromLog(log: string, options: { obtainedAt?: string; authorship?: string } = {}): WebvhIdentity {
  const text = log.endsWith("\n") ? log : `${log}\n`;
  const lines = parseLines(text, "identity");
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (typeof first?.state?.id !== "string" || typeof last?.state?.id !== "string" || typeof last.versionId !== "string" || !first.state.id.startsWith("did:webvh:")) {
    throw new StructuredError("INPUT_INVALID", "the identity log does not name a did:webvh");
  }
  const did = first.state.id;
  const location = last.state.id;
  return {
    did,
    location,
    log: text,
    evidence: { did, log: text, ...(options.obtainedAt ? { obtainedAt: options.obtainedAt } : {}) },
    ref: { did, verificationMethod: `${location}#${options.authorship ?? AUTHORSHIP_KEY}`, versionId: last.versionId },
  };
}

const jsonl = (log: unknown[]): string => log.map((e) => `${JSON.stringify(e)}\n`).join("");

export interface CreateIdentityOptions {
  /** The host, as `example.com` or `example.com:8443`: a fully qualified name, never `localhost` (did:webvh 1.0). */
  domain: string;
  /** Path segments under the domain; originals.build uses `[userPathSegment(subject)]`. */
  paths?: string[];
  /** Signs the DID's log: its key is the update key and `#key-0`. */
  identitySigner: WebvhSigner;
  /** The authorship key's public Multikey, published as `#key-1`. It must not be the identity key (P5.11). */
  authorshipKey: string;
  /** did:webvh portability, so the DID can move to another domain later (P5.14). Default true. */
  portable?: boolean;
}

/** Mint a did:webvh identity in the originals.build shape: `#key-0` identity and update key, `#key-1` authorship. */
export async function createWebvhIdentity(options: CreateIdentityOptions): Promise<WebvhIdentity> {
  const identityKey = options.identitySigner.getPublicKeyMultibase();
  if (options.authorshipKey === identityKey) {
    throw new StructuredError("AUTHORSHIP_KEY_IS_UPDATE_KEY", "the authorship key must not be the identity (update) key (P5.11)");
  }
  const result = await createDIDOriginal({
    type: "did",
    domain: options.domain,
    signer: options.identitySigner,
    verifier: options.identitySigner,
    updateKeys: [identityKey],
    verificationMethods: [
      { id: `#${IDENTITY_KEY}`, type: "Multikey", publicKeyMultibase: identityKey },
      { id: `#${AUTHORSHIP_KEY}`, type: "Multikey", publicKeyMultibase: options.authorshipKey },
    ],
    paths: options.paths ?? [],
    portable: options.portable ?? true,
    authentication: [`#${IDENTITY_KEY}`],
    assertionMethod: [`#${AUTHORSHIP_KEY}`],
  });
  return identityFromLog(jsonl(result.log));
}

/**
 * Refuse a log that is not the identity `options` describe: hosted at
 * `domain` under `paths` now, with `identitySigner`'s key among its update
 * keys and `authorshipKey` as `#key-1` under assertionMethod in its latest
 * state. A log from the app's storage or a create-if-absent `save` is
 * otherwise taken on trust, and one for another account would have this
 * account sign under a DID another key controls. Moves and rotations pass:
 * the app gives where it hosts the DID now and the keys it holds now.
 */
function requireRequested(identity: WebvhIdentity, options: CreateIdentityOptions): WebvhIdentity {
  const fail = (why: string): never => {
    throw new StructuredError("IDENTITY_MISMATCH", `the stored identity log is not the identity asked for: ${why}`);
  };
  const lines = parseLines(identity.log, "identity");
  const paths = options.paths ?? [];
  const segments = identity.location.split(":").slice(3).map((x) => {
    try {
      return decodeURIComponent(x);
    } catch {
      return x;
    }
  });
  if (segments.length !== paths.length + 1 || segments[0] !== requireWebVHDomain(options.domain) || paths.some((p, i) => segments[i + 1] !== p)) {
    fail(`it is hosted at ${identity.location}, not at ${options.domain} under ${JSON.stringify(paths)}`);
  }
  let updateKeys: unknown;
  for (const line of lines) if (line.parameters?.updateKeys !== undefined) updateKeys = line.parameters.updateKeys;
  const identityKey = options.identitySigner.getPublicKeyMultibase();
  if (!Array.isArray(updateKeys) || !updateKeys.includes(identityKey)) fail("the identity key is not among its update keys");
  const state = lines[lines.length - 1].state;
  const fragment = `#${AUTHORSHIP_KEY}`;
  const named = (id: unknown) => typeof id === "string" && (id === fragment || id === `${identity.location}${fragment}`);
  type Method = { id?: unknown; publicKeyMultibase?: unknown };
  const isMethod = (m: unknown): m is Method => typeof m === "object" && m !== null && !Array.isArray(m);
  const holdsKey = (m: unknown) => isMethod(m) && named(m.id) && m.publicKeyMultibase === options.authorshipKey;
  const methods = Array.isArray(state.verificationMethod) ? (state.verificationMethod as unknown[]) : [];
  const assertion = Array.isArray(state.assertionMethod) ? (state.assertionMethod as unknown[]) : [];
  // Under assertionMethod either by reference to a verificationMethod entry or embedded there (P5.3).
  const asserted = assertion.some((a) => (typeof a === "string" ? named(a) && methods.some(holdsKey) : holdsKey(a)));
  if (!asserted) fail(`its latest state does not have the authorship key as ${fragment} under assertionMethod`);
  return identity;
}

/**
 * The user's identity from where the app keeps its log, or a new one, saved
 * there first. `load` returns the hosted log or null. `save` stores a new log
 * and must succeed before the identity is used.
 *
 * Two calls at once (two tabs, two devices) can both find nothing and both
 * mint. Only the store can settle that: make `save` create-if-absent, and when
 * a log is already there, leave it and return it. The identity returned is
 * then the stored one, so every caller ends with the same identity. A `save`
 * that overwrites instead lets the last writer replace an identity the first
 * may already have signed with.
 *
 * A loaded or stored log must be the identity asked for: at `domain` under
 * `paths`, with the identity key among its update keys and the authorship key
 * as `#key-1` (`IDENTITY_MISMATCH` otherwise). It is not otherwise verified
 * here; the SDK verifies it with every Original it signs (P5.6).
 */
export async function ensureWebvhIdentity(
  options: CreateIdentityOptions & {
    load(): Promise<string | null | undefined>;
    /** Store `log` if no log is stored; return the stored log if one already is (or nothing when `log` was stored). */
    save(log: string): Promise<string | null | undefined | void>;
  },
): Promise<WebvhIdentity> {
  const held = await options.load();
  if (held) return requireRequested(identityFromLog(held), options);
  const identity = await createWebvhIdentity({
    domain: options.domain,
    identitySigner: options.identitySigner,
    authorshipKey: options.authorshipKey,
    ...(options.paths !== undefined ? { paths: options.paths } : {}),
    ...(options.portable !== undefined ? { portable: options.portable } : {}),
  });
  const stored = await options.save(identity.log);
  if (stored === undefined || stored === null) return identity;
  if (typeof stored !== "string" || stored.trim() === "") {
    throw new StructuredError("INPUT_INVALID", "save returned something other than the stored log or nothing");
  }
  return requireRequested(identityFromLog(stored), options);
}

/** The alias path segment for an Original: `o-` and the first 16 characters of its did:vh SCID. */
export function aliasPathSegment(original: string): string {
  if (typeof original !== "string" || !original.startsWith("did:vh:") || original.length <= "did:vh:".length) {
    throw new StructuredError("INPUT_INVALID", `${String(original)} is not a did:vh`);
  }
  return `o-${original.slice("did:vh:".length, "did:vh:".length + 16)}`;
}

/**
 * Mint the did:webvh alias an Original is published at (P3.6): its document
 * lists the Original in `alsoKnownAs`, its one key (`#key-0`) is the update
 * key and authentication. Sign it with the identity key, never the
 * authorship key (P5.11). Host its log before signing the publish entry, so
 * a retried publication reuses it (`OriginalsSDK.publish` checks the alias
 * points back).
 */
export async function createWebvhAlias(options: {
  domain: string;
  /** Path segments; originals.build uses `[userPathSegment(subject), aliasPathSegment(original)]`. */
  paths: string[];
  signer: WebvhSigner;
  original: string;
  portable?: boolean;
}): Promise<AliasEvidence> {
  aliasPathSegment(options.original);
  const key = options.signer.getPublicKeyMultibase();
  const result = await createDIDOriginal({
    type: "did",
    domain: options.domain,
    signer: options.signer,
    verifier: options.signer,
    updateKeys: [key],
    verificationMethods: [{ id: `#${IDENTITY_KEY}`, type: "Multikey", publicKeyMultibase: key }],
    authentication: [`#${IDENTITY_KEY}`],
    paths: options.paths,
    portable: options.portable ?? true,
    alsoKnownAs: [options.original],
  });
  return { did: result.did, log: jsonl(result.log) };
}

/** The alias a hosted alias log describes: its latest DID and the log. */
export function aliasFromLog(log: string): AliasEvidence {
  const text = log.endsWith("\n") ? log : `${log}\n`;
  const lines = parseLines(text, "alias");
  const id = lines[lines.length - 1].state.id;
  if (typeof id !== "string" || !id.startsWith("did:webvh:")) throw new StructuredError("INPUT_INVALID", "the alias log does not name a did:webvh");
  return { did: id, log: text };
}
