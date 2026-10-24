/**
 * Dry run L0 (Bun): the test account's author identity, built by the
 * landing's own did:webvh builder on the host's domain and published to the
 * account's namespace, as `createUserWebVHDid` does. #key-0 is the identity
 * key (the update key, and later each alias's controller); #key-1 the only
 * assertionMethod (P5.3, P5.11). The secrets go only to the custody file.
 */
import { didWebvhDomain } from "./did-domain.mjs";
import * as ed from "@noble/ed25519";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyAuthorHistory } from "@originals/vh/originals";
import { BrowserWebVHSigner, buildUserWebVHDid, ed25519PublicKeyMultibase, userDidLogKey, userWebvhSlug } from "../../../apps/landing/src/auth/webvh.ts";
import { assert, assertEqual, findSecrets, Phase, utf8 } from "../lib/phase.mjs";
import { uploader, type LocalInput } from "./local-env.ts";

const phase = new Phase("L0-identity");
const input = phase.input as LocalInput;

await phase.check("author-identity", "the author's did:webvh is built with the landing's builder and published to the account's namespace", async () => {
  const identity = ed.utils.randomSecretKey();
  const authorship = ed.utils.randomSecretKey();
  const authorshipMultikey = ed25519PublicKeyMultibase(await ed.getPublicKeyAsync(authorship));
  const slug = userWebvhSlug(input.sub);
  const built = await buildUserWebVHDid(new BrowserWebVHSigner(identity, ed25519PublicKeyMultibase(await ed.getPublicKeyAsync(identity))), {
    domain: input.domain,
    slug,
    authorshipPublicKeyMultibase: authorshipMultikey,
  });
  const log = (built.didLog as unknown[]).map((e) => `${JSON.stringify(e)}\n`).join("");
  const history = await verifyAuthorHistory({ did: built.did, log });
  assert(history.failure === undefined, "the author log does not verify", history.failure);
  await uploader(input).put(userDidLogKey(input.domain, slug), log, { contentType: "application/jsonl" });
  const custody = {
    note: "Dry-run stand-in for Turnkey custody. Never part of an evidence package or a receipt.",
    did: built.did,
    versionId: history.versions[0].versionId,
    log,
    identitySecretHex: Buffer.from(identity).toString("hex"),
    authorshipSecretHex: Buffer.from(authorship).toString("hex"),
  };
  mkdirSync(input.dirs.custody, { recursive: true });
  writeFileSync(join(input.dirs.custody, "author-keys.json"), `${JSON.stringify(custody, null, 2)}\n`, { mode: 0o600 });
  const pub = { did: built.did, versionId: custody.versionId, logUrl: `https://${userDidLogKey(input.domain, slug)}` };
  assert(findSecrets(utf8(JSON.stringify(pub)), { identity, authorship }).length === 0, "public facts contain a secret");
  phase.facts.author = pub;
  return pub;
});

// B1: the identity DID is on this instance's did:webvh domain (hosted-README.md "Account").
await phase.check("author-did-domain", "the author's identity DID is on this instance's did:webvh domain", async () => {
  const author = phase.facts.author as { did: string };
  const didDomain = { expected: input.domain, actual: didWebvhDomain(author.did), status: "FAIL" as "PASS" | "FAIL" };
  didDomain.status = didDomain.actual === didDomain.expected ? "PASS" : "FAIL";
  phase.facts.author = { ...phase.facts.author, didDomain };
  assertEqual(didDomain.actual, didDomain.expected, "the identity DID's domain");
  return didDomain;
});

phase.finish();
