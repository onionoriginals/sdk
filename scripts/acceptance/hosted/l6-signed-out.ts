/**
 * Dry run L6 (Bun): the signed-out demo (#976 B5). Its key is made in the page
 * and discarded with it: nothing is kept, publishing needs sign-in, a new page
 * lists nothing, and the evidence package holds only public keys.
 */
import { MemoryStore, OriginalsSDK, readEvidence } from "@originals/sdk/originals";
import { generateArtwork } from "../../../apps/landing/src/sdk/artwork.ts";
import { DemoEngine } from "../../../apps/landing/src/sdk/engine.ts";
import { demo } from "../../../apps/landing/src/content.ts";
import { assert, assertEqual, Phase } from "../lib/phase.mjs";

const phase = new Phase("L6-signed-out");

await phase.check("b5-ephemeral", "signed out: nothing is kept, publishing is unavailable, and the copy says the key is discarded", async () => {
  const engine = new DemoEngine({ features: { hostedPublication: true } });
  const created = await engine.create("Sketch", "Orbits", generateArtwork("Sketch", "Orbits", 5).svg);
  let refused = "";
  try {
    await engine.publish();
  } catch (error) {
    refused = (error as Error).message;
  }
  assert(/Sign in/i.test(refused), "a signed-out Original could be published", refused);
  assertEqual(await new DemoEngine().listOriginals(), [], "a new page's list");
  assert(/discard/i.test(demo.hosting.temporaryNote), "the signed-out note doesn't say the key is discarded", demo.hosting.temporaryNote);
  return { did: created.did, refused };
});

await phase.check("b5-package-public-only", "the signed-out evidence package holds no private key", async () => {
  const engine = new DemoEngine();
  await engine.create("Sketch", "Orbits", generateArtwork("Sketch", "Orbits", 6).svg);
  const zip = await engine.evidencePackage();
  const text = new TextDecoder("latin1").decode(zip);
  const hits = ["secretKey", "privateKey", "secretKeyMultibase", '"d":'].filter((needle) => text.includes(needle));
  // A Multikey Ed25519 secret (multicodec 0x8026) encodes with the base58btc prefix z3u2.
  if (/z3u2[1-9A-HJ-NP-Za-km-z]{40,}/.test(text)) hits.push("multikey-secret");
  assertEqual(hits, [], "private key material in the package");
  const contents = readEvidence(zip);
  for (const author of contents.authors) {
    const lines = (typeof author.log === "string" ? author.log.trim().split("\n") : author.log.map((e) => JSON.stringify(e))).map((l) => JSON.parse(l));
    const methods = lines.flatMap((l) => l.state?.verificationMethod ?? []);
    assert(methods.every((m: Record<string, unknown>) => Object.keys(m).every((k) => ["id", "type", "controller", "publicKeyMultibase"].includes(k))), "a verification method carries more than a public key", methods);
  }
  const { report } = await OriginalsSDK.create({ store: new MemoryStore(), authors: [] }).load(zip);
  assertEqual(report.history.status, "valid", "the package verifies without a key");
  return { bytes: zip.length, files: Object.keys(contents.bytes).length };
});

phase.finish();
