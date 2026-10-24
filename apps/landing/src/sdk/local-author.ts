/**
 * A browser-local author for visitors who are not signed in: a did:vh whose
 * log and keys can be saved in guest browser storage. Its update key and its author key are
 * different keys (P5.11), and the author key is the document's assertionMethod
 * (P5.3). Nothing about it is published; an Original it authors
 * verifies anywhere through the evidence package, which carries this DID's log.
 */
import { localSigner, type ProofSigner } from "@originals/vh/crypto";
import { createLog, serializeLog, signWith } from "@originals/vh/log";
import type { AuthorDidEvidence, AuthorRef } from "@originals/vh/originals";
import { keySigner, type OriginalsSigner } from "@originals/sdk/originals";

export interface LocalAuthor {
  ref: AuthorRef;
  evidence: AuthorDidEvidence;
  signer: OriginalsSigner;
  /** Local-only recovery; never included in evidence packages. */
  secret: Uint8Array;
}

const randomKey = () => crypto.getRandomValues(new Uint8Array(32));

export async function createLocalAuthor(now: Date = new Date()): Promise<LocalAuthor> {
  const updateSecret = randomKey();
  const authorSecret = randomKey();
  const update: ProofSigner = localSigner("Ed25519", updateSecret);
  const author = localSigner("Ed25519", authorSecret);
  const did = "did:vh:{SCID}";
  const genesis = await createLog({
    versionTime: new Date(Math.floor(now.getTime() / 1000) * 1000 - 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    parameters: { method: "did:vh:1.0", scid: "{SCID}", updateKeys: [update.publicKeyMultibase] },
    state: {
      "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
      id: did,
      verificationMethod: [{ id: `${did}#author`, type: "Multikey", controller: did, publicKeyMultibase: author.publicKeyMultibase }],
      assertionMethod: [`${did}#author`],
    },
    sign: signWith(update, {
      cryptosuite: "eddsa-jcs-2022",
      verificationMethod: `did:key:${update.publicKeyMultibase}#${update.publicKeyMultibase}`,
    }),
  });
  const authorDid = genesis.state.id as string;
  const verificationMethod = `${authorDid}#author`;
  return {
    secret: authorSecret,
    ref: { did: authorDid, verificationMethod, versionId: genesis.versionId },
    evidence: { did: authorDid, log: serializeLog([genesis]) },
    signer: keySigner({ keyType: "Ed25519", secretKey: authorSecret, verificationMethod }),
  };
}

export function restoreLocalAuthor(saved: Pick<LocalAuthor, 'ref' | 'evidence' | 'secret'>): LocalAuthor {
  return { ...saved, signer: keySigner({ keyType: 'Ed25519', secretKey: saved.secret, verificationMethod: saved.ref.verificationMethod }) };
}
