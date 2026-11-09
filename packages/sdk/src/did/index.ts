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

/** `user-` and the first 16 characters of an account subject: the path segment originals.build gives a user. */
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
  state: { id?: unknown };
}

/**
 * The identity a hosted did:webvh log describes. The DID is the genesis
 * DID; the author reference names `#<authorship>` at the latest version's
 * location and versionId (P5.14). The log is not verified here: the SDK
 * verifies it with every Original it signs (P5.6).
 */
export function identityFromLog(log: string, options: { obtainedAt?: string; authorship?: string } = {}): WebvhIdentity {
  const text = log.endsWith("\n") ? log : `${log}\n`;
  let lines: LogLine[];
  try {
    lines = text.trimEnd().split("\n").map((l) => JSON.parse(l) as LogLine);
  } catch {
    throw new StructuredError("INPUT_INVALID", "the identity log is not JSON Lines");
  }
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
  /** The host, as `example.com` or `localhost:5173`. */
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
 * The user's identity from where the app keeps its log, or a new one, saved
 * there first. `load` returns the hosted log or null; `save` stores a new one
 * and must succeed before the identity is used, so an identity is never
 * minted twice for one account.
 */
export async function ensureWebvhIdentity(
  options: CreateIdentityOptions & { load(): Promise<string | null | undefined>; save(log: string): Promise<void> },
): Promise<WebvhIdentity> {
  const held = await options.load();
  if (held) return identityFromLog(held);
  const identity = await createWebvhIdentity({
    domain: options.domain,
    identitySigner: options.identitySigner,
    authorshipKey: options.authorshipKey,
    ...(options.paths !== undefined ? { paths: options.paths } : {}),
    ...(options.portable !== undefined ? { portable: options.portable } : {}),
  });
  await options.save(identity.log);
  return identity;
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
  const lines = text.trimEnd().split("\n");
  let id: unknown;
  try {
    id = (JSON.parse(lines[lines.length - 1]) as LogLine).state?.id;
  } catch {
    throw new StructuredError("INPUT_INVALID", "the alias log is not JSON Lines");
  }
  if (typeof id !== "string" || !id.startsWith("did:webvh:")) throw new StructuredError("INPUT_INVALID", "the alias log does not name a did:webvh");
  return { did: id, log: text };
}
