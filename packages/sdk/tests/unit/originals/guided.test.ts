/**
 * The guided path: Create → Add a version → Export → Verify, with every call
 * imported from `@originals/sdk` alone (no `@originals/vh`). It must give the
 * same results as the full workflow and the `originals verify` command.
 */
import { describe, expect, test } from "bun:test";
import * as root from "../../../src/index.js";
import {
  MemoryStore,
  OriginalsError,
  OriginalsSDK,
  OriginalsStudio,
  VERSION_NOTE_KEY,
  createLocalAuthor,
  isVerified,
  readEvidence,
  restoreLocalAuthor,
  writeEvidence,
} from "../../../src/originals/index.js";
import { bytes, clock } from "./helpers.js";

const html = (title: string) => bytes(`<!doctype html><title>${title}</title>`);

async function guided() {
  const studio = await OriginalsStudio.start({ clock: clock() });
  const app = await studio.create({ name: "My app", resource: { mediaType: "text/html", bytes: html("v1") }, label: "First draft" });
  return { studio, app };
}

describe("guided path: create, add a version, export, verify", () => {
  test("C12-01: each step is one call from the SDK, and the reader verifies without a key", async () => {
    const { studio, app } = await guided();
    const added = await app.addVersion({ bytes: html("v2"), label: "New UI", note: "Reworked the navigation and the home screen." });
    expect(added).toMatchObject({ version: 2, label: "New UI", note: "Reworked the navigation and the home screen.", mediaType: "text/html" });
    expect(app.checkpoint).toBe(added.versionId);

    const exported = await app.export();
    expect(exported.fileName).toBe("my-app-v2.originals.zip");
    expect(exported.manifest.checkpoint).toBe(app.checkpoint);

    const result = await studio.verify(exported.bytes);
    expect(result.verified).toBe(true);
    expect(result.did).toBe(app.did);
    expect(result.checkpoint).toBe(app.checkpoint);
    expect(result.versions.map((v) => [v.version, v.label, v.note ?? null])).toEqual([
      [1, "First draft", null],
      [2, "New UI", "Reworked the navigation and the home screen."],
    ]);
    expect(result.line).toStartWith(`verified: ${app.did} at ${app.checkpoint}`);
    // No private key in the reader (C12-01): the package carries none.
    const files = readEvidence(exported.bytes);
    const secret = studio.author.secret;
    const hex = Buffer.from(secret).toString("hex");
    expect(JSON.stringify(files.manifest) + files.log + files.authors.map((a) => JSON.stringify(a.log)).join("")).not.toContain(hex);
  });

  test("C12-22: a verified unanchored Original is valid as of its checkpoint, never current", async () => {
    const { studio, app } = await guided();
    const result = await studio.verify((await app.export()).bytes);
    expect(result.verified).toBe(true);
    expect(result.current).toBe(false);
    expect(result.validAsOf?.checkpoint).toBe(app.checkpoint);
    expect(result.reasons).toContain("not-anchored");
  });

  test("the guided verdict is the CLI's: isVerified agrees with load()", async () => {
    const { app } = await guided();
    const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [] });
    const { report, reasons } = await reader.load((await app.export()).bytes);
    expect(isVerified(report, reasons)).toBe(true);
  });

  test("C12-02: changed bytes in the package fail verification and list no notes", async () => {
    const { studio, app } = await guided();
    await app.addVersion({ bytes: html("v2"), label: "New UI" });
    const files = readEvidence((await app.export()).bytes);
    const digest = app.view.state.resource.digest;
    const tampered = writeEvidence({ ...files, bytes: { ...files.bytes, [digest]: html("not v2") } });
    const result = await studio.verify(tampered);
    expect(result.verified).toBe(false);
    expect(result.report.resources.status).toBe("digest-failure");
    // Labels are signed claims: shown only for a verified result.
    expect(result.versions.every((v) => v.label === undefined && v.note === undefined)).toBe(true);
  });

  test("the label and note are signed metadata, merged with the caller's own (C12-17)", async () => {
    const studio = await OriginalsStudio.start({ clock: clock() });
    const app = await studio.create({ name: "My app", resource: { mediaType: "text/html", bytes: html("v1") }, metadata: { repo: "acme/app" } });
    await app.addVersion({ bytes: html("v2"), label: "New UI", note: "One sentence." });
    expect(app.view.state.metadata).toEqual({ repo: "acme/app", [VERSION_NOTE_KEY]: { label: "New UI", note: "One sentence.", digest: app.view.state.resource.digest } });
  });

  test("a note carried over by a later edit is not attributed to the new version", async () => {
    const { studio, app } = await guided();
    await app.addVersion({ bytes: html("v2"), label: "New UI" });
    // A plain edit with new bytes keeps the metadata, and with it v2's note.
    await studio.sdk.edit(app.did, { parent: app.checkpoint, resource: { bytes: html("v3") }, author: studio.author.ref, signer: studio.author.signer });
    await app.refresh();
    const versions = await app.versions();
    expect(versions.map((v) => [v.version, v.label ?? null])).toEqual([[1, "First draft"], [2, "New UI"], [3, null]]);
  });

  test("C12-19: the same bytes are refused, not a silent relabel", async () => {
    const { app } = await guided();
    const before = app.checkpoint;
    const err = await app.addVersion({ bytes: html("v1"), label: "Same" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OriginalsError);
    expect(err).toMatchObject({ category: "invalid-evidence", code: "VERSION_UNCHANGED" });
    expect(app.checkpoint).toBe(before);
  });

  test("bad create input is the SDK's structured refusal", async () => {
    const studio = await OriginalsStudio.start({ clock: clock() });
    const err = await studio.create({ name: "x", resource: { mediaType: "text/html", bytes: "no" as unknown as Uint8Array }, label: "v1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OriginalsError);
    expect(err).toMatchObject({ code: "INPUT_INVALID" });
  });

  test("a label is required and must be text", async () => {
    const { app } = await guided();
    for (const label of ["", "   ", 7 as unknown as string]) {
      expect(app.addVersion({ bytes: html("v2"), label })).rejects.toMatchObject({ code: "INPUT_INVALID" });
    }
  });

  test("C12-12: a handle whose Original moved is a stale-parent conflict, never a rebase", async () => {
    const { studio, app } = await guided();
    const other = await studio.open(app.did);
    await other.addVersion({ bytes: html("v2"), label: "Elsewhere" });
    const err = await app.addVersion({ bytes: html("v3"), label: "Stale" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ category: "stale-parent" });
    await app.refresh();
    expect((await app.addVersion({ bytes: html("v3"), label: "After refresh" })).version).toBe(3);
  });

  test("a restored author keeps editing the same Original in a durable store", async () => {
    const store = new MemoryStore();
    const first = await OriginalsStudio.start({ store, clock: clock() });
    const app = await first.create({ name: "My app", resource: { mediaType: "text/html", bytes: html("v1") } });
    const { ref, evidence, secret } = first.author;

    const again = await OriginalsStudio.start({ store, author: { ref, evidence, secret }, clock: clock(Date.parse("2026-10-19T12:00:00Z")) });
    const reopened = await again.open(app.did);
    expect((await reopened.addVersion({ bytes: html("v2"), label: "New UI" })).version).toBe(2);
    expect((await again.verify((await reopened.export()).bytes)).verified).toBe(true);
  });

  test("createLocalAuthor: the author key is an assertionMethod and not the DID's update key (P5.3, P5.11)", async () => {
    const author = await createLocalAuthor();
    expect(author.ref.did).toStartWith("did:vh:");
    expect(author.ref.verificationMethod).toBe(`${author.ref.did}#author`);
    const [genesis] = (author.evidence.log as string).trim().split("\n").map((l) => JSON.parse(l) as { parameters: { updateKeys: string[] }; state: { verificationMethod: Array<{ publicKeyMultibase: string }>; assertionMethod: string[] } });
    expect(genesis.state.assertionMethod).toEqual([author.ref.verificationMethod]);
    expect(genesis.parameters.updateKeys).not.toContain(genesis.state.verificationMethod[0].publicKeyMultibase);
    const restored = restoreLocalAuthor(author);
    expect(restored.ref).toEqual(author.ref);
  });

  test("the root entry point exports the guided path too", () => {
    expect(root.OriginalsStudio).toBe(OriginalsStudio);
    expect(root.createLocalAuthor).toBe(createLocalAuthor);
    expect(root.OriginalsError).toBe(OriginalsError);
  });
});
