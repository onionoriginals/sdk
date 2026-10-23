/**
 * Dry run L5 (Bun): client B, another browser signed in to the same account,
 * with an empty store (#976 B3, G3). It lists the account's published works,
 * restores one from the host, verified, and continues from the host's head as
 * the explicit parent with the author's own key. Another key can't continue
 * it: restoring confers no authority.
 */
import * as ed from "@noble/ed25519";
import { generateArtwork } from "../../../apps/landing/src/sdk/artwork.ts";
import { assert, assertEqual, Phase } from "../lib/phase.mjs";
import { readCustody, signedInEngine, type LocalInput } from "./local-env.ts";

const phase = new Phase("L5-client-b");
const input = phase.input as LocalInput & { prior: Record<string, { did: string; alias?: string; checkpoint: string; entries: number }> };
const { work1 } = input.prior;

await phase.check("b3-other-client-restore", "another client lists the work from the account and restores it from the host", async () => {
  const { engine, store } = await signedInEngine(input, input.dirs.storeB);
  assertEqual(await store.list(), [], "client B's store before restoring");
  const listed = await engine.listOriginals();
  assert(listed.some((o) => o.did === work1.did && o.where === "host"), "the published work is not listed from the account", listed);
  const restored = await engine.restore(work1.did);
  assertEqual(restored.publication, "complete", "publication");
  assertEqual(restored.webvhDid, work1.alias, "alias");
  assertEqual(restored.history.at(-1)!.versionId, work1.checkpoint, "restored at the host's head");
  const next = await engine.update("Harbor, winter", "Orbits", generateArtwork("Harbor, winter", "Orbits", 21).svg);
  assertEqual(next.history.length, work1.entries + 1, "entries after B's revision");
  phase.facts.work1 = { did: work1.did, alias: work1.alias, checkpoint: next.history.at(-1)!.versionId, entries: next.history.length, resources: [{ id: next.resource.id, mediaType: next.resource.contentType, sha256: next.resource.hash }, ...(next.metadata ? [{ id: next.metadata.id, mediaType: "application/json", sha256: next.metadata.hash }] : [])] };
  await store.close();
  return phase.facts.work1;
});

await phase.check("b3-restore-no-authority", "restored with another key, the work can't be continued", async () => {
  const custody = readCustody(input);
  const intruder = { ...custody, authorshipSecretHex: Buffer.from(ed.utils.randomSecretKey()).toString("hex") };
  const { engine, store } = await signedInEngine(input, input.dirs.storeC, { custody: intruder });
  await engine.restore(work1.did);
  let refused = "";
  try {
    await engine.update("Not mine", "Orbits", generateArtwork("Not mine", "Orbits", 3).svg);
  } catch (error) {
    refused = `${(error as Error).name}: ${(error as Error).message}`;
  }
  await store.close();
  assert(refused !== "", "a key that isn't the author's #key-1 continued the work");
  return { refused: refused.slice(0, 200) };
});

phase.finish();
