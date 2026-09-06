import type {
  CelDocument,
  CelSigner,
  JsonObject,
  Resource,
  VerifiedHistory,
} from "@originals/cel/v3";

/** Raw bytes at runtime; strings are an explicit UTF-8 input convenience. */
export interface AssetResourceInput {
  id: string;
  mediaType: string;
  content: Uint8Array | string;
  url?: string[];
}

/** A descriptor and version derived from authenticated history, with independently checked bytes. */
export interface AssetResource extends Resource {
  version: number;
  content?: Uint8Array;
}

/** Unsigned byte attachment. Its exact id/version/digest must match an authenticated entry. */
export interface ResourceAttachment {
  id: string;
  version: number;
  digestMultibase: string;
  content: { encoding: "base64"; data: string };
}

/** CEL 3 interchange. Version 1/2 envelopes and previous CEL representations are not accepted. */
export interface AssetEnvelope {
  format: "originals/asset";
  version: 3;
  assetDid: string;
  eventLog: CelDocument;
  resources: ResourceAttachment[];
  /** Retained editing material, never authenticated history or a claimed resource version. */
  unverified?: { localResources: LocalResourceAttachment[] };
}

/** Unsigned editing material retained after an explicitly skipped append. */
export interface LocalResourceAttachment {
  localResourceId: string;
  id: string;
  mediaType: string;
  baseDigestMultibase: string;
  baseVersion: number;
  content: { encoding: "base64"; data: string };
}

/** Local bytes carry no authenticated version number. */
export type LocalResource = Omit<LocalResourceAttachment, "content"> & {
  content: Uint8Array;
};

/** Explicit CEL 3 custody; callback signers must implement the selected suite's message algorithm. */
export interface OriginalsConfig {
  signer?: CelSigner;
  onAppendFailure?: "throw" | "skip";
}

/** Per-call custody overrides configuration and is never retained after creation. */
export interface CreateAssetOptions {
  signer?: CelSigner;
  name?: string;
  metadata?: JsonObject;
}

/** Replaces supplied fields in full; resource bytes are edited through addResourceVersion. */
export interface AssetUpdate {
  name?: string;
  metadata?: JsonObject;
}

/** Per-call signer overrides the configured controller custody. */
export interface MutationOptions {
  signer?: CelSigner;
  /** Only missing custody can skip. Invalid signatures, authority and invalid input always fail. */
  onAppendFailure?: "throw" | "skip";
}

/** A local authenticated append; this result does not assert publication or Bitcoin acceptance. */
export type MutationResult =
  | {
      status: "signed";
      head: string;
    }
  | {
      status: "skipped";
      reason: "NO_SIGNING_KEY";
      /** Present for retained resource bytes. Other skipped edits leave no local change. */
      localResourceId?: string;
    };

/** Local history verification does not establish publication, live ownership or global uniqueness. */
export interface AssetVerification {
  verified: boolean;
  history: VerifiedHistory;
  resources: "verified" | "incomplete";
  missingResources: { id: string; version: number }[];
  unverifiedLocalResources: number;
}

/** Permit incomplete bytes/local drafts without claiming full verification. Signatures always verify. */
export interface LoadAssetOptions {
  allowPartial?: boolean;
}

/** Fresh load always authenticates history; there is no skip-signature-validation switch. */
export interface LoadedAsset {
  asset: import("./OriginalsAsset.js").OriginalsAsset;
  verification: AssetVerification;
}
