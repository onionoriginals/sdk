/**
 * Private use (P8.2): the SDK has no encryption feature, so nothing it
 * writes, shows or reports labels plaintext metadata, base64 content or raw
 * storage as encrypted or confidential. Tests cite their section 12 rows by
 * registry id.
 */
import { describe, expect, test } from "bun:test";
import { MemoryStore, OriginalsSDK, describeEntry, readEvidence, readZip } from "../../../src/originals/index.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const KA = seed(21);
/** Words that would claim confidentiality the SDK does not provide (P8.2). */
const CLAIMS = /encrypt|cipher|confidential|sealed|protected content|private content/i;

const text = (value: unknown) => (value instanceof Uint8Array ? new TextDecoder().decode(value) : JSON.stringify(value, (_k, v) => (v instanceof Uint8Array ? `<${v.length} bytes>` : v instanceof Map ? Object.fromEntries(v) : v)));

describe("C12-306: plaintext metadata, base64 content or raw storage is never labelled encrypted (P8.2)", () => {
  test("every surface of an Original whose metadata is plaintext and whose content is base64 text", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: KA }]);
    const store = new MemoryStore();
    const sdk = OriginalsSDK.create({ store, authors: async (did) => (did === alice.did ? alice.evidence() : undefined), clock: clock() });
    // Base64 of some bytes: opaque to a reader, and still plaintext.
    const base64 = bytes(Buffer.from("the harbor at dawn, in secret").toString("base64"));
    const created = await sdk.create({
      name: "Harbor notes", metadata: { note: "for my eyes only", passphraseHint: "the usual one" },
      resource: { mediaType: "text/plain", bytes: base64 }, author: alice.ref("orig"), signer: alice.signer("orig", KA),
    });
    if (created.kind !== "original") throw new Error("expected an Original");
    const did = created.original.did;
    const draft = await sdk.prepareEdit(did, { parent: created.original.checkpoint, author: alice.ref("orig"), metadata: { note: "still for my eyes only" } });
    const view = await sdk.get(did);
    const pkg = await sdk.package(did);
    const loaded = await sdk.load(pkg.bytes);
    const record = await store.get(did);
    const surfaces: Array<[string, unknown]> = [
      ["the created Original's view", created.original],
      ["the view", view],
      ["the verification report", view.report],
      ["what the signer is shown", draft.display],
      ["what the signer is shown, recomputed", describeEntry(draft.summary)],
      ["the draft's summary", draft.summary],
      ["the package manifest", pkg.manifest],
      ["the loaded package's report", loaded],
      ["the stored record", record],
      ...[...readZip(pkg.bytes).entries()].map(([name, data]): [string, unknown] => [`package entry ${name}`, name.endsWith(".json") || name.endsWith(".jsonl") ? data : name]),
    ];
    for (const [where, value] of surfaces) {
      expect(text(value), where).not.toMatch(CLAIMS);
    }
    // The metadata and content are stored and packaged as they were given: plaintext, readable by anyone holding them.
    expect(view.state.metadata).toEqual({ note: "for my eyes only", passphraseHint: "the usual one" });
    expect(record!.log).toContain("for my eyes only");
    const contents = readEvidence(pkg.bytes);
    expect(Object.values(contents.bytes)).toContainEqual(base64);
    expect(view.resources[0]).toMatchObject({ mediaType: "text/plain" });
  });
});
