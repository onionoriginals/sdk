/**
 * The signer contract (P5.11). A signer receives the complete unsigned entry,
 * the proof options and a summary of what the author is approving, and returns
 * the cryptosuite signature. It must parse the entry and refuse anything that
 * is not a well-formed Originals entry for its own key; `keySigner` does, and
 * recomputes the signed bytes itself rather than trusting the caller's.
 */
import { OriginalsError } from "@originals/vh";
import { localSigner, proofHashData, type CryptosuiteName, type DataIntegrityProof, type KeyType } from "@originals/vh/crypto";
import type { JsonObject } from "@originals/vh/json";
import type { UnsignedEntry } from "@originals/vh/log";
import { ORIGINALS_METHOD, type AuthorRef, type EntryState, type Operation, type Transition } from "@originals/vh/originals";

export interface EntrySummary {
  original: string;
  operation: Operation;
  name: string;
  author: AuthorRef;
  /** Resource changes: the prior and new digest of each changed resource. */
  changes: Transition[];
  nameChanged: boolean;
  metadataChanged: boolean;
  versionTime: string;
}

export type ProofOptions = Omit<DataIntegrityProof, "proofValue">;

export interface SigningRequest {
  entry: UnsignedEntry;
  proofOptions: ProofOptions;
  summary: EntrySummary;
}

export interface OriginalsSigner {
  /** The author verification method, an absolute DID URL. */
  readonly verificationMethod: string;
  readonly cryptosuite: CryptosuiteName;
  /** Return the signature over the request's entry, or reject to refuse. */
  sign(request: SigningRequest): Promise<Uint8Array>;
}

export function summarize(entry: UnsignedEntry, previous?: EntryState): EntrySummary {
  const state = entry.state as unknown as EntryState;
  return {
    original: state.id,
    operation: state.operation,
    name: state.asset.name,
    author: state.author,
    changes: state.transitions,
    nameChanged: previous ? previous.asset.name !== state.asset.name : true,
    metadataChanged: previous ? JSON.stringify(previous.asset.metadata) !== JSON.stringify(state.asset.metadata) : state.asset.metadata !== undefined,
    versionTime: entry.versionTime,
  };
}

function refuse(message: string): never {
  throw new OriginalsError("invalid-evidence", "SIGNER_REFUSED", message);
}

/** Refuse input that is not a well-formed Originals entry for `verificationMethod`. */
function checkRequest(request: SigningRequest, verificationMethod: string, cryptosuite: CryptosuiteName): void {
  const { entry, proofOptions } = request;
  if (proofOptions.verificationMethod !== verificationMethod || proofOptions.cryptosuite !== cryptosuite || proofOptions.proofPurpose !== "assertionMethod") {
    refuse("the proof options are not this key's");
  }
  const number = Number(/^(\d+)-/.exec(String(entry?.versionId))?.[1] ?? NaN);
  const parameters = (entry?.parameters ?? {});
  if (!Number.isInteger(number) || typeof entry.versionTime !== "string") refuse("not a VH log entry");
  if (number === 1 ? parameters.method !== ORIGINALS_METHOD : parameters.method !== undefined && parameters.method !== ORIGINALS_METHOD) {
    refuse("not an Originals entry");
  }
  const state = entry.state;
  const author = state?.author as JsonObject | undefined;
  if (typeof state?.id !== "string" || !state.id.startsWith("did:vh:") || !["create", "update", "deactivate"].includes(state.operation as string)) {
    refuse("not an Originals asset state");
  }
  if (author?.verificationMethod !== verificationMethod) refuse("the entry names another author key");
}

export interface KeySignerOptions {
  keyType: KeyType;
  secretKey: Uint8Array;
  /** The author verification method this key is, e.g. `did:webvh:…#orig-1`. */
  verificationMethod: string;
}

/** A signer holding raw key bytes. For tests and local custody. */
export function keySigner(options: KeySignerOptions): OriginalsSigner {
  if (!/^did:[a-z0-9]+:[^#]+#[^#]+$/.test(options.verificationMethod)) {
    throw new OriginalsError("invalid-evidence", "SIGNER_INVALID", "verificationMethod must be an absolute DID URL with a fragment");
  }
  const key = localSigner(options.keyType, options.secretKey);
  const cryptosuite: CryptosuiteName = options.keyType === "Ed25519" ? "eddsa-jcs-2022" : "bip340-jcs-2025";
  return {
    verificationMethod: options.verificationMethod,
    cryptosuite,
    sign: async (request) => {
      checkRequest(request, options.verificationMethod, cryptosuite);
      return key.sign(proofHashData(request.entry, request.proofOptions));
    },
  };
}
