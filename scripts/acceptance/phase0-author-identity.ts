/**
 * Phase 0 (Bun, fresh process, network disabled): the author's identity.
 *
 * Builds the author's did:webvh with the landing's own builder
 * (`buildUserWebVHDid` and `BrowserWebVHSigner` from apps/landing/src/auth/webvh.ts),
 * the same output the #964 regression checks. Two keys, as in the signed-in
 * landing flow: the identity key is the DID log's update key (#key-0), and a
 * separate authorship key is the document's only assertionMethod (#key-1),
 * the key that signs Originals (P5.3, P5.11).
 *
 * Outputs:
 * - custody/author-keys.json: the two secrets. This file stands in for the
 *   author's key custody (Turnkey in the landing). Only author processes get it.
 * - public/author-did.json: the DID, its log and the authorship
 *   verificationMethod. Public; no secret.
 */
import * as ed from "@noble/ed25519";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyAuthorHistory } from "@originals/vh/originals";
import { BrowserWebVHSigner, buildUserWebVHDid, ed25519PublicKeyMultibase } from "../../apps/landing/src/auth/webvh.ts";
import { assert, findSecrets, Phase, utf8 } from "./lib/phase.mjs";

const phase = new Phase("0-author-identity");
const { dirs } = phase.input;
await phase.probeNetwork();

await phase.check("author-did-built", "the landing's did:webvh builder mints the author DID offline", async () => {
  const identity = ed.utils.randomSecretKey();
  const authorship = ed.utils.randomSecretKey();
  const identityMultikey = ed25519PublicKeyMultibase(await ed.getPublicKeyAsync(identity));
  const authorshipMultikey = ed25519PublicKeyMultibase(await ed.getPublicKeyAsync(authorship));
  const built = await buildUserWebVHDid(new BrowserWebVHSigner(identity, identityMultikey), {
    domain: "magby.originals.build",
    slug: "user-acceptance0976",
    authorshipPublicKeyMultibase: authorshipMultikey,
  });
  const log = (built.didLog as unknown[]).map((e) => `${JSON.stringify(e)}\n`).join("");
  const evidence = { did: built.did, log };
  const history = await verifyAuthorHistory(evidence);
  assert(history.failure === undefined, "the landing-built did:webvh log does not verify under @originals/vh", history.failure);
  const doc = built.didDocument as { assertionMethod: string[]; verificationMethod: Array<{ id: string; publicKeyMultibase: string }> };
  assert(doc.assertionMethod.length === 1 && doc.assertionMethod[0].endsWith("#key-1"), "assertionMethod is not exactly #key-1", doc.assertionMethod);
  const entry0 = (built.didLog as Array<{ parameters: { updateKeys: string[] } }>)[0];
  assert(!entry0.parameters.updateKeys.some((k) => k.includes(authorshipMultikey)), "the authorship key is also an update key (P5.11)");

  const custody = {
    note: "Stand-in for the author's key custody. Never part of an evidence package.",
    did: built.did,
    authorship: { keyType: "Ed25519", verificationMethod: `${built.did}#key-1`, secretKeyHex: Buffer.from(authorship).toString("hex") },
    identity: { keyType: "Ed25519", role: "did:webvh update key (#key-0)", secretKeyHex: Buffer.from(identity).toString("hex") },
  };
  const pub = { method: "did:webvh", builder: "apps/landing/src/auth/webvh.ts buildUserWebVHDid", did: built.did, log, versionId: history.versions[0].versionId, assertionMethod: `${built.did}#key-1`, updateKeys: entry0.parameters.updateKeys };
  const pubText = `${JSON.stringify(pub, null, 2)}\n`;
  assert(findSecrets(utf8(pubText), { identity, authorship }).length === 0, "the public author file contains a secret");
  mkdirSync(dirs.custody, { recursive: true });
  mkdirSync(dirs.public, { recursive: true });
  writeFileSync(join(dirs.custody, "author-keys.json"), `${JSON.stringify(custody, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(dirs.public, "author-did.json"), pubText);
  phase.facts.author = { did: built.did, method: "did:webvh", versionId: pub.versionId, assertionMethod: pub.assertionMethod, updateKeys: pub.updateKeys };
  return phase.facts.author;
});

phase.finish();
