/**
 * Dry run L6 (Bun): the signed-out demo (#976 B5). Owner decision of 23
 * October 2026 (#992): signed out, the guest key and the guest's work are
 * kept in this browser's guest database, unencrypted, with a warning.
 * Publishing needs sign-in, nothing goes to any account database or the
 * server, and the evidence package holds only public keys.
 *
 * Bun has no IndexedDB, so the phase installs fake-indexeddb as the page's
 * IndexedDB: the checks see which databases the signed-out engine opens.
 */
import { IDBFactory } from "fake-indexeddb";
import { MemoryStore, OriginalsSDK, readEvidence } from "@originals/sdk/originals";
import { generateArtwork } from "../../../apps/landing/src/sdk/artwork.ts";
import { DemoEngine } from "../../../apps/landing/src/sdk/engine.ts";
import { browserDatabase, pageStore } from "../../../apps/landing/src/sdk/browser-store.ts";
import { library } from "../../../apps/landing/src/content.ts";
import { assert, assertEqual, Phase } from "../lib/phase.mjs";

const phase = new Phase("L6-signed-out");

await phase.check("b5-guest", "signed out: publishing is unavailable, guest work survives a reload in the guest database only, and nothing reaches an account database or the server", async () => {
  const idb = new IDBFactory();
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = idb;
  // Every request the page makes, so "nothing reaches the server" is checked, not assumed.
  const requests: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(`${init?.method ?? "GET"} ${String(input instanceof Request ? input.url : input)}`);
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    // The signed-out page's engine, as Demo builds it (pageStore: the guest database).
    const engine = new DemoEngine({ features: { hostedPublication: true }, ...pageStore() });
    const created = await engine.create("Sketch", "Orbits", generateArtwork("Sketch", "Orbits", 5).svg);
    let refused = "";
    try {
      await engine.publish();
    } catch (error) {
      refused = (error as Error).message;
    }
    assert(/Sign in/i.test(refused), "a signed-out Original could be published", refused);
    // The reload: a new page on the same browser finds the guest work under the same guest key.
    const reloaded = new DemoEngine({ ...pageStore() });
    const reopened = await reloaded.open(created.did);
    assertEqual(reopened.history.map((h) => h.versionId), created.history.map((h) => h.versionId), "the guest work after a reload");
    const next = await reloaded.update("Sketch, later", "Orbits", generateArtwork("Sketch, later", "Orbits", 6).svg);
    assertEqual(next.author, created.author, "the guest author after a reload");
    const databases = (await idb.databases()).map((d) => d.name);
    assertEqual(databases, [browserDatabase()], "IndexedDB databases a signed-out page opened");
    assertEqual(requests, [], "requests a signed-out page made");
    // The one guest-key warning (#996's library.guestKey), shown wherever guest mode is.
    assert(/stored in this browser, unencrypted/i.test(library.guestKey) && /anyone using this browser can sign as this guest/i.test(library.guestKey), "the guest-key warning doesn't say the key is stored here unencrypted and who can sign", library.guestKey);
    return { did: created.did, refused, databases };
  } finally {
    globalThis.fetch = realFetch;
  }
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
