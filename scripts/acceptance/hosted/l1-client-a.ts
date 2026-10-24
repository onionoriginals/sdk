/**
 * Dry run L1 (Bun): client A, a signed-in browser with its own store.
 *
 * B1: creates and revises a work, publishes it, and checks the key roles from
 * the host: entries signed by #key-1 at an author version that lists it, the
 * alias controlled by the identity key (#key-0's did:key), and #key-1 an
 * update key of neither log (P3.7, P5.3, P5.11).
 * B4 setup: two more works whose publication is interrupted, (i) after the
 * publish entry before any upload, (ii) during the resource uploads. The
 * process then exits: that is the browser closing.
 */
import { generateArtwork } from "../../../apps/landing/src/sdk/artwork.ts";
import { assert, assertEqual, Phase } from "../lib/phase.mjs";
import { signedInEngine, strangerRead, uploader, type LocalInput } from "./local-env.ts";
import { didKeyOf, parseJsonl } from "./roles.ts";

const phase = new Phase("L1-client-a");
const input = phase.input as LocalInput;
const { engine, store, custody } = await signedInEngine(input, input.dirs.storeA);
const read = strangerRead(input);
const art = (title: string, seed: number) => generateArtwork(title, "Orbits", seed).svg;
const resourcesOf = (s: { resource: { id: string; hash: string; contentType: string }; metadata?: { id: string; hash: string } }) => [
  { id: s.resource.id, mediaType: s.resource.contentType, sha256: s.resource.hash },
  ...(s.metadata ? [{ id: s.metadata.id, mediaType: "application/json", sha256: s.metadata.hash }] : []),
];

let work1: Awaited<ReturnType<typeof engine.publish>> | undefined;
await phase.check("b1-create-revise", "a work is created and revised by the author's #key-1", async () => {
  const created = await engine.create("Harbor at dawn", "Orbits", art("Harbor at dawn", 7));
  const revised = await engine.update("Harbor at dusk", "Orbits", art("Harbor at dusk", 8));
  assertEqual(revised.history.map((h) => h.operation), ["create", "update"], "operations");
  assert(revised.history.every((h) => h.authorKey === `${custody.did}#key-1`), "an entry is not signed by #key-1", revised.history);
  return { did: created.did, versions: revised.history.map((h) => h.versionId) };
});

await phase.check("b1-publish", "publishing completes only once a stranger verifies the snapshot", async () => {
  work1 = await engine.publish();
  assertEqual(work1.publication, "complete", "publication");
  assertEqual(work1.layer, "did:webvh", "layer");
  phase.facts.work1 = { did: work1.did, alias: work1.webvhDid, checkpoint: work1.history.at(-1)!.versionId, entries: work1.history.length, resources: resourcesOf(work1) };
  return phase.facts.work1;
});

await phase.check("b1-key-roles", "the hosted logs show separate identity (alias control) and authorship roles", async () => {
  assert(work1, "nothing was published");
  const text = async (url: string) => new TextDecoder().decode(await read(url, { maxBytes: 1 << 24, timeoutMs: 15_000, signal: AbortSignal.timeout(15_000) }));
  const { didWebvhLogUrl } = await import("@originals/vh/webvh");
  const authorLog = parseJsonl(await text(didWebvhLogUrl(custody.did)));
  const aliasLog = parseJsonl(await text(didWebvhLogUrl(work1!.webvhDid!)));
  const authorDoc = authorLog.at(-1)!.state as { assertionMethod: string[]; verificationMethod: Array<{ id: string; publicKeyMultibase: string }> };
  const keyOf = (frag: string) => authorDoc.verificationMethod.find((vm) => vm.id.endsWith(frag))!.publicKeyMultibase;
  const identityKey = didKeyOf(keyOf("#key-0"));
  const authorshipKey = didKeyOf(keyOf("#key-1"));
  const authorUpdateKeys = authorLog.flatMap((e) => (e.parameters?.updateKeys ?? []) as string[]);
  const aliasUpdateKeys = aliasLog.flatMap((e) => (e.parameters?.updateKeys ?? []) as string[]);
  const aliasDoc = aliasLog.at(-1)!.state as { alsoKnownAs?: string[] };
  assert(authorDoc.assertionMethod.length === 1 && authorDoc.assertionMethod[0].endsWith("#key-1"), "the author's assertionMethod is not exactly #key-1", authorDoc.assertionMethod);
  assert(authorUpdateKeys.some((k) => k.includes(keyOf("#key-0"))), "the identity key is not the author DID's update key", authorUpdateKeys);
  assert(aliasUpdateKeys.some((k) => k.includes(keyOf("#key-0"))), "the identity key does not control the alias (P3.7)", aliasUpdateKeys);
  assert(![...authorUpdateKeys, ...aliasUpdateKeys].some((k) => k.includes(keyOf("#key-1"))), "the authorship key is an update key (P5.11)");
  assertEqual(aliasDoc.alsoKnownAs, [work1!.did], "the alias's alsoKnownAs");
  assert((aliasLog[0].parameters as { portable?: boolean }).portable === true, "the alias is not portable (P9.3)");
  phase.facts.roles = {
    identity: { verificationMethod: "#key-0", didKey: identityKey, authorUpdateKey: true, controlsAlias: true },
    authorship: { verificationMethod: "#key-1", didKey: authorshipKey, assertionMethod: true, updateKey: false },
  };
  return phase.facts.roles;
});

for (const [name, fails] of [
  ["work2", () => true],
  ["work3", (key: string) => key.includes("originals/resources/")],
] as const) {
  await phase.check(`b4-interrupt-${name}`, name === "work2" ? "publication interrupted after the publish entry, before any upload" : "publication interrupted during the resource uploads", async () => {
    const real = uploader(input);
    const flaky = {
      put: (key: string, data: Uint8Array | string, o?: { contentType?: string }) => (fails(key) ? Promise.reject(new Error("connection lost")) : real.put(key, data, o)),
      submit: real.submit.bind(real),
      recordOriginal: real.recordOriginal.bind(real),
      evidence: real.evidence.bind(real),
    };
    const { engine: e } = await signedInEngine(input, input.dirs.storeA, { custody, upload: flaky });
    const created = await e.create(name === "work2" ? "Tide table" : "Night ferry", "Orbits", art(name, name === "work2" ? 11 : 12));
    let refused = "";
    try {
      await e.publish();
    } catch (error) {
      refused = (error as Error).message;
    }
    assert(/connection lost/.test(refused), "the interrupted publication did not fail", refused);
    const s = e.snapshot();
    assertEqual(s.publication, "incomplete", "publication after the interruption");
    assertEqual(s.layer, "did:vh", "layer after the interruption");
    assertEqual(s.history.length, created.history.length + 1, "the publish entry is committed");
    phase.facts[name] = { did: s.did, alias: s.webvhDid, checkpoint: s.history.at(-1)!.versionId, entries: s.history.length, resources: resourcesOf(s) };
    return phase.facts[name];
  });
}

await store.close();
phase.finish();
