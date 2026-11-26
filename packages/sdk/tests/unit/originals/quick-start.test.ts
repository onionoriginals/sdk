/**
 * The README quick start, run as written: create, edit, package and verify
 * with every name imported from the root `@originals/sdk`, nothing from
 * `@originals/vh`. If this test changes, change the README with it.
 */
import { describe, expect, test } from "bun:test";
import {
  MemoryStore,
  OriginalsError,
  OriginalsSDK,
  createLocalAuthor,
  isVerified,
  readEvidence,
  restoreLocalAuthor,
  type AuthorRef,
  type OriginalsReport,
} from "../../../src/index.js";
import { bytes } from "./helpers.js";

const v1 = bytes("<!doctype html><title>v1</title>");
const v2 = bytes("<!doctype html><title>v2</title>");

describe("README quick start", () => {
  test("C12-01: create, edit, package and verify from @originals/sdk alone; the reader has no key", async () => {
    // 1. An author.
    const author = await createLocalAuthor();
    const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [author.evidence] });
    const signer = author.signer;

    // 2. Create.
    const created = await sdk.create({ name: "My app", resource: { mediaType: "text/html", bytes: v1 }, author: author.ref, signer });
    if (created.kind !== "original") throw new Error("unreachable: a signer was given");
    let original = created.original;

    // 3. Edit.
    ({ original } = await sdk.edit(original.did, {
      parent: original.checkpoint,
      resource: { bytes: v2 },
      metadata: { note: "New UI: reworked the navigation." },
      author: author.ref, signer,
    }));

    // 4. Export.
    const pkg = await sdk.package(original.did);

    // 5. Verify, as the recipient would.
    const reader = OriginalsSDK.create({ authors: [] });
    const { report, reasons } = await reader.load(pkg.bytes);
    expect(isVerified(report, reasons)).toBe(true);

    expect(report.checkpoint).toBe(original.checkpoint);
    expect(report.resources.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(original.state.metadata).toEqual({ note: "New UI: reworked the navigation." });
    // Verified is not current: an unanchored Original is valid as of its checkpoint (P7.10).
    expect(report.current).toBe(false);
    expect(report.validAsOf?.checkpoint).toBe(original.checkpoint);
    // No private key in the package (C12-01).
    const files = readEvidence(pkg.bytes);
    const secret = Buffer.from(author.secret).toString("hex");
    expect(files.log + files.authors.map((a) => String(a.log)).join("") + JSON.stringify(files.manifest)).not.toContain(secret);
  });

  test("a later edit without metadata keeps the earlier note (P4.6)", async () => {
    const author = await createLocalAuthor();
    const sdk = OriginalsSDK.create({ authors: [author.evidence] });
    const created = await sdk.create({ name: "x", resource: { mediaType: "text/plain", bytes: v1 }, metadata: { note: "first" }, author: author.ref, signer: author.signer });
    if (created.kind !== "original") throw new Error("unreachable");
    const { original } = await sdk.edit(created.original.did, { parent: created.original.checkpoint, resource: { bytes: v2 }, author: author.ref, signer: author.signer });
    expect(original.state.metadata).toEqual({ note: "first" });
  });

  test("a moved parent is a stale-parent conflict, as the README says", async () => {
    const author = await createLocalAuthor();
    const sdk = OriginalsSDK.create({ authors: [author.evidence] });
    const created = await sdk.create({ name: "x", resource: { mediaType: "text/plain", bytes: v1 }, author: author.ref, signer: author.signer });
    if (created.kind !== "original") throw new Error("unreachable");
    const { did, checkpoint } = created.original;
    await sdk.edit(did, { parent: checkpoint, resource: { bytes: v2 }, author: author.ref, signer: author.signer });
    const err = await sdk.edit(did, { parent: checkpoint, name: "y", author: author.ref, signer: author.signer }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OriginalsError);
    expect(err).toMatchObject({ category: "stale-parent" });
  });
});

describe("createLocalAuthor", () => {
  test("its author key is the only assertionMethod and not the DID's update key (P5.3, P5.11)", async () => {
    const author = await createLocalAuthor();
    expect(author.ref.did).toStartWith("did:vh:");
    expect(author.ref.verificationMethod).toBe(`${author.ref.did}#author`);
    const [genesis] = String(author.evidence.log).trim().split("\n").map((l) => JSON.parse(l) as {
      parameters: { updateKeys: string[] };
      state: { verificationMethod: Array<{ publicKeyMultibase: string }>; assertionMethod: string[] };
    });
    expect(genesis.state.assertionMethod).toEqual([author.ref.verificationMethod]);
    expect(genesis.parameters.updateKeys).not.toContain(genesis.state.verificationMethod[0].publicKeyMultibase);
  });

  test("a restored author keeps signing the same Original", async () => {
    const author = await createLocalAuthor();
    const store = new MemoryStore();
    const first = OriginalsSDK.create({ store, authors: [author.evidence] });
    const created = await first.create({ name: "x", resource: { mediaType: "text/plain", bytes: v1 }, author: author.ref, signer: author.signer });
    if (created.kind !== "original") throw new Error("unreachable");

    const { ref, evidence, secret } = author;
    const again = restoreLocalAuthor({ ref, evidence, secret });
    const second = OriginalsSDK.create({ store, authors: [again.evidence] });
    const { original } = await second.edit(created.original.did, { parent: created.original.checkpoint, resource: { bytes: v2 }, author: again.ref, signer: again.signer });
    expect(original.resources.map((v) => v.version)).toEqual([1, 2]);
  });

  test("the report and author types come from @originals/sdk", () => {
    const ref: AuthorRef = { did: "did:vh:x", verificationMethod: "did:vh:x#author", versionId: "1-x" };
    const pick = (r: OriginalsReport) => r.history.status;
    expect([ref.did, typeof pick]).toEqual(["did:vh:x", "function"]);
  });
});
