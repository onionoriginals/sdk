/**
 * A local author: a did:vh author DID made on this device, for trying the SDK
 * or for apps whose users have no DID yet. An app with its own identity uses
 * `ensureWebvhIdentity` from `@originals/sdk/did`, or any DID with a signer.
 */
import { localSigner } from "@originals/vh/crypto";
import { createLog, serializeLog, signWith } from "@originals/vh/log";
import type { AuthorDidEvidence, AuthorRef } from "@originals/vh/originals";
import { keySigner, type OriginalsSigner } from "./signer.js";

/**
 * A did:vh author made on this device. Its update key and its author key are
 * different keys (P5.11), and the author key is the document's only
 * `assertionMethod` (P5.3). Nothing is published: an Original it authors
 * verifies anywhere through its evidence package, which carries this DID's log.
 */
export interface LocalAuthor {
  ref: AuthorRef;
  evidence: AuthorDidEvidence;
  signer: OriginalsSigner;
  /** The author key's secret. Keep it to sign later versions; it is never put in an evidence package. */
  secret: Uint8Array;
}

/** What to keep to sign with a local author again: `restoreLocalAuthor` rebuilds its signer. */
export type SavedLocalAuthor = Pick<LocalAuthor, "ref" | "evidence" | "secret">;

const randomKey = () => crypto.getRandomValues(new Uint8Array(32));

/**
 * Make a local author. Its DID's single version is dated one second before
 * `at` (default now), in whole seconds, so entries signed from `at` on follow it. The update
 * key's secret is discarded: this DID is never rotated.
 */
export async function createLocalAuthor(at: number | Date = Date.now()): Promise<LocalAuthor> {
  const now = typeof at === "number" ? at : at.getTime();
  const update = localSigner("Ed25519", randomKey());
  const secret = randomKey();
  const key = localSigner("Ed25519", secret);
  const did = "did:vh:{SCID}";
  const genesis = await createLog({
    versionTime: new Date(Math.floor(now / 1000) * 1000 - 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    parameters: { method: "did:vh:1.0", scid: "{SCID}", updateKeys: [update.publicKeyMultibase] },
    state: {
      "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
      id: did,
      verificationMethod: [{ id: `${did}#author`, type: "Multikey", controller: did, publicKeyMultibase: key.publicKeyMultibase }],
      assertionMethod: [`${did}#author`],
    },
    sign: signWith(update, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${update.publicKeyMultibase}#${update.publicKeyMultibase}` }),
  });
  const authorDid = genesis.state.id as string;
  return restoreLocalAuthor({
    secret,
    ref: { did: authorDid, verificationMethod: `${authorDid}#author`, versionId: genesis.versionId },
    evidence: { did: authorDid, log: serializeLog([genesis]) },
  });
}

/** A saved local author, with its signer rebuilt from the secret. */
export function restoreLocalAuthor(saved: SavedLocalAuthor): LocalAuthor {
  return { ...saved, signer: keySigner({ keyType: "Ed25519", secretKey: saved.secret, verificationMethod: saved.ref.verificationMethod }) };
}
