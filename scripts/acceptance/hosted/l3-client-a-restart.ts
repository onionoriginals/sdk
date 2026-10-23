/**
 * Dry run L3 (Bun): client A after a browser restart, a new process on the
 * same store directory.
 *
 * B3: the published work is listed, reopens at its checkpoint and takes the
 * next revision through the host.
 * B4: each interrupted publication reopens as incomplete, refuses edits, and
 * resumes under the same alias and checkpoint with no second publish entry.
 */
import { generateArtwork } from "../../../apps/landing/src/sdk/artwork.ts";
import { assert, assertEqual, Phase } from "../lib/phase.mjs";
import { signedInEngine, type LocalInput } from "./local-env.ts";

const phase = new Phase("L3-client-a-restart");
const input = phase.input as LocalInput & { prior: Record<string, { did: string; alias?: string; checkpoint: string; entries: number }> };
const { engine, store } = await signedInEngine(input, input.dirs.storeA);
const { work1, work2, work3 } = input.prior;

await phase.check("b3-listed", "after the restart this browser lists all three works", async () => {
  const listed = await engine.listOriginals();
  for (const w of [work1, work2, work3]) assert(listed.some((o) => o.did === w.did && o.where === "this-browser"), `${w.did} is not listed`, listed);
  return listed;
});

await phase.check("b3-reopen-continue", "the published work reopens at its checkpoint and the next revision goes through the host", async () => {
  const reopened = await engine.open(work1.did);
  assertEqual(reopened.history.at(-1)!.versionId, work1.checkpoint, "reopened checkpoint");
  assertEqual(reopened.publication, "complete", "publication");
  const next = await engine.update("Harbor at night", "Orbits", generateArtwork("Harbor at night", "Orbits", 9).svg);
  assertEqual(next.history.length, work1.entries + 1, "entries after the revision");
  phase.facts.work1 = { did: work1.did, alias: work1.alias, checkpoint: next.history.at(-1)!.versionId, entries: next.history.length, resources: [{ id: next.resource.id, mediaType: next.resource.contentType, sha256: next.resource.hash }, ...(next.metadata ? [{ id: next.metadata.id, mediaType: "application/json", sha256: next.metadata.hash }] : [])] };
  return phase.facts.work1;
});

for (const [name, w] of [["work2", work2], ["work3", work3]] as const) {
  await phase.check(`b4-resume-${name}`, `${name}: the interrupted publication resumes with the same alias and checkpoint and one publish entry`, async () => {
    const reopened = await engine.open(w.did);
    assertEqual(reopened.publication, "incomplete", "publication after the restart");
    assertEqual(reopened.layer, "did:vh", "layer after the restart");
    let refused = "";
    try {
      await engine.update("Edited too early", "Orbits", generateArtwork("x", "Orbits", 1).svg);
    } catch (error) {
      refused = (error as Error).message;
    }
    assert(/Finish publishing/.test(refused), "an edit on a half-published snapshot was not refused", refused);
    const resumed = await engine.publish();
    assertEqual(resumed.publication, "complete", "publication after resuming");
    assertEqual(resumed.webvhDid, w.alias, "alias");
    assertEqual(resumed.history.at(-1)!.versionId, w.checkpoint, "checkpoint");
    assertEqual(resumed.history.length, w.entries, "entries (no second publish entry)");
    phase.facts[name] = { ...w, resources: [{ id: resumed.resource.id, mediaType: resumed.resource.contentType, sha256: resumed.resource.hash }, ...(resumed.metadata ? [{ id: resumed.metadata.id, mediaType: "application/json", sha256: resumed.metadata.hash }] : [])] };
    return phase.facts[name];
  });
}

await store.close();
phase.finish();
