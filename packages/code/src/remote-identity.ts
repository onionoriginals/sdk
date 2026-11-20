/**
 * Identities whose entry-signing key is held elsewhere (plan 049 §6
 * milestone 1; PROVISIONAL K21). The dogfood CI signs as an editor of the
 * owner's branch with an Ed25519 key held in Turnkey; its identity file holds
 * only public data and a reference to that key, never a secret.
 *
 * The did:vh's update key is separate from the signing key (P5.11) and stays
 * with whoever creates the identity (the owner), in its own private file:
 * CI never holds it, so CI can sign entries but never change its own DID.
 * Browser-safe; the Turnkey signer itself is `@originals/code/turnkey` (Node).
 */
import { decodeMultikey, localSigner, type ProofSigner } from "@originals/vh/crypto";
import { isJsonObject, parseJson } from "@originals/vh/json";
import { createLog, serializeLog, signWith, type EntrySigner } from "@originals/vh/log";
import { codeError } from "./errors.js";
import { SIGNING_FRAGMENT, parsePublicIdentity, type LocalIdentity } from "./identity.js";

export const REMOTE_IDENTITY_FORMAT = "originals-code-remote-identity/0.1";
export const UPDATE_KEY_FORMAT = "originals-code-update-key/0.1";

/** Where the signing key is held. Only Turnkey for now; no credential is ever stored here. */
export interface RemoteKeyRef {
  kind: "turnkey";
  /** Turnkey's `signWith`: the private key id or the wallet account address. */
  signWith: string;
  /** The key's public Multikey (Ed25519, base58btc): the DID's assertion key. */
  publicKeyMultibase: string;
}

export interface RemoteIdentity extends Pick<LocalIdentity, "did" | "log"> {
  key: RemoteKeyRef;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function checkEd25519(publicKeyMultibase: string): void {
  let type: string;
  try {
    type = decodeMultikey(publicKeyMultibase).type;
  } catch {
    return codeError("invalid-evidence", "IDENTITY_KEYS", `${publicKeyMultibase} is not a Multikey`);
  }
  // Only the two pinned cryptosuites are accepted (P5.12); entries are signed eddsa-jcs-2022.
  if (type !== "Ed25519") codeError("unsupported-profile", "IDENTITY_KEYS", "the signing key must be Ed25519 (eddsa-jcs-2022)");
}

/**
 * Create a did:vh whose assertion key is `key.publicKeyMultibase` (held
 * elsewhere) and whose update key is a fresh local one, returned separately
 * for the creator to keep private.
 */
export async function createRemoteIdentity(key: RemoteKeyRef, options: { updateSecret?: Uint8Array; now?: number } = {}): Promise<{ identity: RemoteIdentity; updateSecret: Uint8Array }> {
  if (key.kind !== "turnkey" || typeof key.signWith !== "string" || key.signWith.length === 0) codeError("invalid-evidence", "IDENTITY_FILE", "a remote key is { kind: \"turnkey\", signWith, publicKeyMultibase }");
  checkEd25519(key.publicKeyMultibase);
  const updateSecret = options.updateSecret ?? globalThis.crypto.getRandomValues(new Uint8Array(32));
  const update = localSigner("Ed25519", updateSecret);
  if (update.publicKeyMultibase === key.publicKeyMultibase) codeError("invalid-evidence", "IDENTITY_KEYS", "the signing key must not be the update key (P5.11)");
  const did = "did:vh:{SCID}";
  const vm = `${did}#${SIGNING_FRAGMENT}`;
  const k = update.publicKeyMultibase;
  const genesis = await createLog({
    versionTime: new Date(Math.floor((options.now ?? Date.now()) / 1000) * 1000).toISOString().replace(".000Z", "Z"),
    parameters: { method: "did:vh:1.0", scid: "{SCID}", updateKeys: [k] },
    state: {
      "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
      id: did,
      verificationMethod: [{ id: vm, type: "Multikey", controller: did, publicKeyMultibase: key.publicKeyMultibase }],
      assertionMethod: [vm],
    },
    sign: signWith(update, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${k}#${k}` }),
  });
  const id = genesis.state.id as string;
  return { identity: { did: id, log: serializeLog([genesis]), key: { kind: "turnkey", signWith: key.signWith, publicKeyMultibase: key.publicKeyMultibase } }, updateSecret };
}

/** The remote identity file: public data and the key reference only. Safe to commit. */
export function serializeRemoteIdentity(identity: RemoteIdentity): string {
  return `${JSON.stringify({ format: REMOTE_IDENTITY_FORMAT, did: identity.did, log: identity.log, key: identity.key }, null, 2)}\n`;
}

/** The update key file. Keep it private: it controls the DID (P5.11). */
export function serializeUpdateKey(did: string, updateSecret: Uint8Array): string {
  return `${JSON.stringify({ format: UPDATE_KEY_FORMAT, did, updateSecret: hex(updateSecret) }, null, 2)}\n`;
}

/**
 * Read a remote identity file. The key must be the DID's `#code-1`
 * assertion key at its latest version, or entries it signs would not verify.
 */
export function parseRemoteIdentity(text: string): RemoteIdentity {
  const v = parseJson(text);
  if (!isJsonObject(v) || v.format !== REMOTE_IDENTITY_FORMAT || !isJsonObject(v.key)) codeError("invalid-evidence", "IDENTITY_FILE", `not an ${REMOTE_IDENTITY_FORMAT} file`);
  if ("updateSecret" in v || "signingSecret" in v) codeError("invalid-evidence", "IDENTITY_FILE", "a remote identity file never holds a secret");
  const pub = parsePublicIdentity(text);
  const key = v.key;
  if (key.kind !== "turnkey" || typeof key.signWith !== "string" || !key.signWith || typeof key.publicKeyMultibase !== "string") codeError("invalid-evidence", "IDENTITY_FILE", "a remote key is { kind: \"turnkey\", signWith, publicKeyMultibase }");
  checkEd25519(key.publicKeyMultibase);
  const lines = pub.log.trimEnd().split("\n");
  const last = JSON.parse(lines[lines.length - 1]) as { state?: { verificationMethod?: Array<{ id?: string; publicKeyMultibase?: string }>; assertionMethod?: unknown[] } };
  const vm = `${pub.did}#${SIGNING_FRAGMENT}`;
  const method = last.state?.verificationMethod?.find((m) => m.id === vm);
  if (!method || method.publicKeyMultibase !== key.publicKeyMultibase || !last.state?.assertionMethod?.includes(vm)) {
    codeError("invalid-evidence", "IDENTITY_KEYS", `the key reference is not ${vm}, the DID's assertion key at its latest version`);
  }
  return { ...pub, key: { kind: "turnkey", signWith: key.signWith, publicKeyMultibase: key.publicKeyMultibase } };
}

/**
 * An `EntrySigner` over a remote `ProofSigner` (`eddsa-jcs-2022`, P5.12),
 * checking that the signer holds the identity's key before anything is signed.
 */
export function remoteEntrySigner(identity: RemoteIdentity, signer: ProofSigner): EntrySigner {
  if (signer.keyType !== "Ed25519" || signer.publicKeyMultibase !== identity.key.publicKeyMultibase) {
    codeError("invalid-evidence", "IDENTITY_KEYS", "the remote signer's key is not the identity's assertion key");
  }
  return signWith(signer, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `${identity.did}#${SIGNING_FRAGMENT}` });
}
