/**
 * Carried logs (proposed; aviarytech/originals-spec PR 59 at 3ed0f89):
 * P7.11-P7.16, P14.14-P14.17. The conformance registry is being re-pinned
 * for PR 59, so each test cites its section 12 row as `PR59 carried:` and a
 * quote of the row's first column, until the row has a C12 id.
 */
import { describe, expect, test } from "bun:test";
import { serializeLog, type LogEntry } from "../src/log/index.js";
import { canonicalize, parseJson, type JsonObject, type JsonValue } from "../src/json/index.js";
import {
  CARRIER_MAX_BYTES,
  TRAILER_MAGIC,
  asciiEntryLine,
  carriedDisclosure,
  carrierFor,
  createOriginal,
  locateCarrier,
  parseBtcoAlias,
  readCarriedFile,
  readInscribedEntries,
  removeCarrier,
  resourceDigest,
  updateOriginal,
  writeCarriedFile,
  type AuthorDidEvidence,
  type ResourceDescriptor,
  type SatEvidence,
  type SatInscription,
} from "../src/originals/index.js";
import { NOW, VhAuthor, bytes, carrying, clock, photo, seeded } from "./helpers/originals.js";

const KA = seeded(41);
const KB = seeded(42);
const KM = seeded(43);
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const same = (a: Uint8Array | null, b: Uint8Array) => a !== null && a.length === b.length && a.every((x, i) => x === b[i]);

/** A PNG-like version: the signature and some bytes, high-bit and CR LF included. */
const PNG = concat(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), enc("IHDR harbor at dawn"), Uint8Array.of(0, 255, 13, 10));

function described(data: Uint8Array, mediaType: string): ResourceDescriptor {
  return { mediaType, size: data.length, digest: resourceDigest(data) };
}

/** An Original by Alice whose versions are `versions` in order; a metadata-only entry last when `trailingEdit`. */
async function original(versions: Array<{ data: Uint8Array; mediaType: string }>, opts: { trailingEdit?: boolean; author?: VhAuthor; sign?: ReturnType<VhAuthor["signer"]> } = {}) {
  const alice = opts.author ?? (await VhAuthor.create([{ fragment: "orig", signer: KA }]));
  const at = clock();
  const ref = alice.ref("orig");
  const sign = opts.sign ?? alice.signer(KA, "orig");
  const entries: LogEntry[] = [await createOriginal({ versionTime: at(), name: "Harbor notes", metadata: { place: "Môle" }, resource: described(versions[0].data, versions[0].mediaType), author: ref, sign })];
  for (const v of versions.slice(1)) entries.push(await updateOriginal(entries[entries.length - 1], { versionTime: at(), resource: described(v.data, v.mediaType), author: ref, sign }));
  if (opts.trailingEdit) entries.push(await updateOriginal(entries[entries.length - 1], { versionTime: at(), metadata: { place: "Môle", corrected: true }, author: ref, sign }));
  return { alice, entries, at, ref, sign };
}

async function carry(version: Uint8Array, entries: LogEntry[]): Promise<Uint8Array> {
  return writeCarriedFile(version, entries, { disclosed: carriedDisclosure(entries) });
}

const resolved = (alice: VhAuthor) => async (did: string): Promise<AuthorDidEvidence | undefined> => (did === alice.did ? { ...alice.evidence(), obtainedAt: new Date(NOW - 1000).toISOString() } : undefined);

const MD1 = enc("# Harbor\n\nFirst notes.\n");
const MD3 = enc("# Harbor\n\nNotes, version three — with a dash -- and an arrow -->.\n");

describe("P14.14: the carrier for a media type", () => {
  test("PR59 carried: \"`mediaType` `image/PNG` / `application/javascript` / `application/pdf` / `application/vc+json`\": trailer / none / none / none", () => {
    expect(carrierFor("image/PNG")).toEqual({ kind: "trailer" });
    expect(carrierFor("application/javascript")).toBeNull();
    expect(carrierFor("application/pdf")).toBeNull();
    expect(carrierFor("application/vc+json")).toBeNull();
    // Aliases, ZIP-based and other text types have none; the comparison is ASCII only.
    expect(carrierFor("audio/x-wav")).toBeNull();
    expect(carrierFor("application/epub+zip")).toBeNull();
    expect(carrierFor("text/csv")).toBeNull();
    expect(carrierFor("text/x-ruby")).toBeNull();
    expect(carrierFor("TEXT/Markdown")).toEqual({ kind: "text-block", comment: "<!--" });
    expect(carrierFor("application/GEO+json")).toEqual({ kind: "json-member" });
    expect(carrierFor("application/sql")).toEqual({ kind: "text-block", comment: "--" });
    // Unicode case folding is not ASCII: the Kelvin sign is not "k".
    expect(carrierFor("text/marKdown".replace("K", "K"))).toBeNull();
  });
});

describe("P7.12, P7.13: reading a carried file", () => {
  test("PR59 carried: \"Carried file whose bytes, with the carrier removed, are the version its log's last entry names, signer DIDs resolved\": log and version verified, valid as of that checkpoint, never current", async () => {
    // Harbor notes, carried (section 7 example): version 3, then a metadata correction as the checkpoint.
    const md2 = enc("# Harbor\n\nSecond notes.\n");
    const { alice, entries } = await original([{ data: MD1, mediaType: "text/markdown" }, { data: md2, mediaType: "text/markdown" }, { data: MD3, mediaType: "text/markdown" }], { trailingEdit: true });
    const file = await carry(MD3, entries);
    expect(dec(file).startsWith(dec(MD3))).toBe(true);
    const r = await readCarriedFile(file, { resolveSigners: resolved(alice), now: NOW });
    expect(r.carrierStatus).toBe("found");
    expect(r.carrier).toEqual({ kind: "text-block", comment: "<!--" });
    expect(same(r.version, MD3)).toBe(true);
    expect(r.bytes).toBe("match");
    expect(r.proofs).toBe("checked");
    expect(r.signers).toMatchObject({ requested: true, resolved: [alice.did], unavailable: [] });
    expect(r.verified).toEqual({ log: true, version: true });
    expect(r.validAsOf?.checkpoint).toBe(entries[3].versionId);
    expect(r.validAsOf?.signers[0]).toMatchObject({ did: alice.did, versionId: alice.versionId, source: "fetched" });
    expect(r.current).toBe(false);
    expect(r.reasons).toContain("not-anchored");
    // Other versions' bytes are unavailable content, not a failure (P7.13, P7.4).
    expect(r.report?.resources.status).toBe("partial");
    expect(r.report?.resources.missing.map((v) => v.version)).toEqual([1, 2]);
  });

  test("PR59 carried: \"Carried file whose bytes, with the carrier removed, are the version …\" for a trailer and a JSON member as well", async () => {
    const png = await original([{ data: PNG, mediaType: "image/png" }]);
    const r1 = await readCarriedFile(await carry(PNG, png.entries), { authors: [png.alice.evidence()], now: NOW });
    expect(r1.carrier).toEqual({ kind: "trailer" });
    expect(r1.verified).toEqual({ log: true, version: true });
    const json = enc('{"title":"Harbor","tags":["a","b"]}\n');
    const doc = await original([{ data: json, mediaType: "application/json" }]);
    const file = await carry(json, doc.entries);
    expect(dec(file).startsWith('{"title":"Harbor","tags":["a","b"],"originalLog":[')).toBe(true);
    const r2 = await readCarriedFile(file, { authors: [doc.alice.evidence()], now: NOW });
    expect(r2.carrier).toEqual({ kind: "json-member" });
    expect(same(r2.version, json)).toBe(true);
    expect(r2.verified).toEqual({ log: true, version: true });
    expect(r2.current).toBe(false);
  });

  test("PR59 carried: \"Carried file whose remaining bytes differ by one byte, or by changed line endings\": bytes not verified; the log only with a statement that the file is not a version", async () => {
    const { alice, entries } = await original([{ data: MD1, mediaType: "text/markdown" }]);
    const file = await carry(MD1, entries);
    const oneByte = file.slice();
    oneByte[2] ^= 1;
    const crlf = enc(dec(file).replace(/\n/g, "\r\n"));
    for (const changed of [oneByte, crlf]) {
      const r = await readCarriedFile(changed, { resolveSigners: resolved(alice), now: NOW });
      expect(r.carrierStatus).toBe("found");
      expect(r.bytes).toBe("mismatch");
      expect(r.verified.version).toBe(false);
      // The log's own result is reported separately.
      expect(r.verified.log).toBe(true);
      expect(r.statements[0]).toContain(`carries the log of ${r.original} at ${entries[0].versionId}, but it is not a version of that Original`);
    }
  });

  test("PR59 carried: \"Carried file opened or previewed without the caller's opt-in to resolve\": no DID resolved; proofs unchecked", async () => {
    const { entries } = await original([{ data: PNG, mediaType: "image/png" }]);
    const r = await readCarriedFile(await carry(PNG, entries), { now: NOW });
    expect(r.signers.requested).toBe(false);
    expect(r.signers.resolved).toEqual([]);
    expect(r.proofs).toBe("unchecked");
    expect(r.report).toBeNull();
    expect(r.verified).toEqual({ log: false, version: false });
  });

  test("PR59 carried: \"Carried file read offline, signer DID not resolvable\": proofs unchecked; identity evidence and author binding incomplete; never a pass", async () => {
    const { alice, entries } = await original([{ data: PNG, mediaType: "image/png" }]);
    const asked: string[] = [];
    const r = await readCarriedFile(await carry(PNG, entries), {
      resolveSigners: async (did) => {
        asked.push(did);
        return undefined;
      },
      now: NOW,
    });
    expect(asked).toEqual([alice.did]);
    expect(r.signers).toMatchObject({ requested: true, resolved: [], unavailable: [alice.did] });
    expect(r.proofs).toBe("unchecked");
    expect(r.identityEvidence).toBe("incomplete");
    expect(r.authorBinding).toBe("incomplete");
    expect(r.verified).toEqual({ log: false, version: false });
    expect(r.validAsOf).toBeNull();
    // At most: the entries chain and the bytes match, which anyone can arrange.
    expect(r.chain.status).toBe("chains-from-genesis");
    expect(r.bytes).toBe("match");
    expect(r.statements.join(" ")).toContain("Anyone can arrange this without a key");
  });

  test("PR59 carried: \"Forged log naming a real author DID, appended to bytes matching its last descriptor\": proofs fail once resolved; offline nothing verified", async () => {
    const alice = await VhAuthor.create([{ fragment: "orig", signer: KA }]);
    // Mallory signs with her own key under Alice's verification method.
    const forged = await original([{ data: PNG, mediaType: "image/png" }], { author: alice, sign: alice.signer(KM, "orig") });
    const file = await carry(PNG, forged.entries);
    const offline = await readCarriedFile(file, { now: NOW });
    expect(offline.chain.status).toBe("chains-from-genesis");
    expect(offline.bytes).toBe("match");
    expect(offline.verified).toEqual({ log: false, version: false });
    const online = await readCarriedFile(file, { resolveSigners: resolved(alice), now: NOW });
    expect(online.proofs).toBe("checked");
    expect(online.history).toBe("invalid");
    expect(online.report?.history.failure?.code).toBe("PROOF_SIGNATURE");
    expect(online.verified).toEqual({ log: false, version: false });
  });

  test("PR59 carried: \"Carried log whose last entry names a media type with a different carrier or comment syntax, or none\": no valid carrier", async () => {
    const { alice, entries } = await original([{ data: MD1, mediaType: "text/markdown" }]);
    const file = await carry(MD1, entries);
    // The same block, read for a last entry of another media type: CSS (`/*`), plain text (none), PDF (no carrier).
    for (const mediaType of ["text/css", "text/plain", "application/pdf"]) {
      const other = await original([{ data: MD1, mediaType }], { author: alice });
      const block = dec(file).slice(MD1.length);
      const lines = block.split("\n").filter((l) => l.startsWith("{"));
      const rewritten = block.replace(lines.join("\n"), other.entries.map((e) => asciiEntryLine(e as unknown as JsonValue, "<!--")).join("\n"));
      const r = await readCarriedFile(concat(MD1, enc(rewritten)), { authors: [alice.evidence()], now: NOW });
      expect(r.carrierStatus).toBe("mismatch");
      expect(r.expectedCarrier).toEqual(carrierFor(mediaType));
      expect(r.verified.version).toBe(false);
      expect(r.statements[0]).toContain("it is not a version of that Original");
    }
  });
});

describe("P14.15: trailers", () => {
  const footer = (length: number) => {
    const f = new Uint8Array(24);
    new DataView(f.buffer).setUint32(4, length);
    f.set(TRAILER_MAGIC, 8);
    return f;
  };

  test("PR59 carried: \"Trailer whose length exceeds the file size less 24, or whose footer is altered by end-of-line conversion\": no trailer", async () => {
    expect(locateCarrier(concat(enc("abcd"), footer(5))).status).toBe("none");
    expect(locateCarrier(concat(enc("abcd"), footer(4))).status).toBe("found");
    const { entries } = await original([{ data: PNG, mediaType: "image/png" }]);
    const file = await carry(PNG, entries);
    // CR LF to LF conversion damages the magic's own CR LF.
    const unix = Uint8Array.from(Array.from(file).filter((b, i, a) => !(b === 0x0d && a[i + 1] === 0x0a)));
    expect(locateCarrier(unix).status).toBe("none");
    // Stripping the high bit damages its first byte.
    expect(locateCarrier(file.map((b) => b & 0x7f)).status).toBe("none");
  });

  test("PR59 carried: \"Trailer `length` 16,777,192 / 16,777,193\": trailer / no trailer", () => {
    const file = new Uint8Array(CARRIER_MAX_BYTES + 1);
    file.set(footer(16_777_192), file.length - 24);
    const found = locateCarrier(file);
    expect(found.status).toBe("found");
    if (found.status === "found") {
      expect(found.start).toBe(1);
      expect(found.log.status).toBe("invalid"); // NUL bytes are no log, but the trailer is found
    }
    file.set(footer(16_777_193), file.length - 24);
    expect(locateCarrier(file).status).toBe("none");
    // A length with a high 32-bit word set is no trailer, without overflow.
    const huge = concat(enc("x"), footer(0));
    huge[huge.length - 24] = 1;
    expect(locateCarrier(huge).status).toBe("none");
  });

  test("PR59 carried: \"File of 16–23 bytes ending in the footer magic\": no trailer", () => {
    for (let n = 16; n <= 23; n++) {
      const file = new Uint8Array(n);
      file.set(TRAILER_MAGIC, n - 16);
      expect(locateCarrier(file).status).toBe("none");
    }
  });

  test("PR59 carried: \"Trailer entry line of 70,000 bytes whose JCS form is 60,000 bytes\": over the entry limit, as in did.jsonl", async () => {
    const { alice, at, ref, sign } = await original([{ data: PNG, mediaType: "image/png" }]);
    const big = await createOriginal({ versionTime: at(), name: "Big", metadata: { note: "x".repeat(59_000) }, resource: described(PNG, "image/png"), author: ref, sign });
    // The same entry, with 2,000 characters written as \u escapes: 10,000 more bytes, the same JCS form.
    const plain = JSON.stringify(big);
    const line = plain.replace("x".repeat(2000), "\\u0078".repeat(2000));
    expect(canonicalize(parseJson(line))).toBe(canonicalize(big as unknown as JsonValue));
    const lineBytes = enc(line).length;
    expect(lineBytes).toBeGreaterThan(65_536);
    expect(enc(canonicalize(big as unknown as JsonValue)).length).toBeLessThan(65_536);
    const L = enc(`${line}\n`);
    const r = await readCarriedFile(concat(PNG, L, footer(L.length)), { authors: [alice.evidence()], now: NOW });
    expect(r.carrierStatus).toBe("found");
    expect(r.log.status).toBe("invalid");
    expect(r.log.failure).toMatchObject({ category: "limit-exceeded", code: "ENTRY_TOO_LARGE" });
    // In a text block the same entry is measured as its JCS form and is within the limit (P14.14).
    const block = `\n=====BEGIN ORIGINAL=====\n${line}\n=====END ORIGINAL=====\n`;
    const text = await readCarriedFile(concat(enc("notes"), enc(block)), { now: NOW });
    expect(text.log.status).toBe("parsed");
  });

  test("PR59 carried: \"Trailer whose log breaks P14.2\": trailer found; log invalid", async () => {
    const { entries } = await original([{ data: PNG, mediaType: "image/png" }]);
    for (const L of [enc(serializeLog(entries).replace("\n", "\r\n")), enc(serializeLog(entries).slice(0, -1)), enc(JSON.stringify(entries[0], null, 1) + "\n")]) {
      const r = await readCarriedFile(concat(PNG, L, footer(L.length)), { now: NOW });
      expect(r.carrierStatus).toBe("found");
      expect(r.log.status).toBe("invalid");
      expect(["LOG_LINE_FORMAT", "JSON_SYNTAX"]).toContain(r.log.failure?.code ?? "");
      expect(r.verified).toEqual({ log: false, version: false });
    }
  });
});

describe("P14.16: text blocks", () => {
  async function plain() {
    const data = enc("harbor notes\n");
    const o = await original([{ data, mediaType: "text/plain" }]);
    const line = asciiEntryLine(o.entries[0] as unknown as JsonValue, "none");
    return { ...o, data, line };
  }

  test("PR59 carried: \"Text block whose last line has no line end\": accepted", async () => {
    const { alice, data, line } = await plain();
    const file = concat(data, enc(`\n=====BEGIN ORIGINAL=====\n${line}\n=====END ORIGINAL=====`));
    const r = await readCarriedFile(file, { authors: [alice.evidence()], now: NOW });
    expect(r.carrier).toEqual({ kind: "text-block", comment: "none" });
    expect(r.verified.version).toBe(true);
  });

  test("PR59 carried: \"Text block with a blank, unprefixed or non-JSON line between the markers, or no entry line\": a text block with an invalid log, not content", async () => {
    const { data, line } = await plain();
    const cases: Array<[string, string]> = [
      [`\n=====BEGIN ORIGINAL=====\n${line}\n\n=====END ORIGINAL=====\n`, "JSONL_BLANK_LINE"],
      [`\n=====BEGIN ORIGINAL=====\nnot json\n=====END ORIGINAL=====\n`, "JSON_PARSE_ERROR"],
      [`\n=====BEGIN ORIGINAL=====\n=====END ORIGINAL=====\n`, "LOG_EMPTY"],
    ];
    for (const [block, code] of cases) {
      const found = locateCarrier(concat(data, enc(block)));
      expect(found.status).toBe("found");
      if (found.status === "found") {
        expect(found.log.status).toBe("invalid");
        if (found.log.status === "invalid") expect(found.log.failure.code === code || code === "JSON_PARSE_ERROR").toBe(true);
        expect(same(found.version, data)).toBe(true);
      }
    }
    const unprefixed = locateCarrier(enc(`x = 1\n# =====BEGIN ORIGINAL=====\n${line}\n# =====END ORIGINAL=====\n`));
    expect(unprefixed.status === "found" && unprefixed.log.status === "invalid" && unprefixed.log.failure.code).toBe("CARRIED_LINE_PREFIX");
  });

  test("a block reaching back past 16 MiB is no carrier, and is found without reading the whole file (P14.14)", async () => {
    const { line } = await plain();
    const filler = `${"x".repeat(1023)}\n`.repeat(16 * 1024 + 1);
    expect(locateCarrier(enc(`a\n=====BEGIN ORIGINAL=====\n${filler}${line}\n=====END ORIGINAL=====\n`)).status).toBe("none");
  });

  test("PR59 carried: \"Text block at the very start of the file, with no line feed before it\": no carrier", async () => {
    const { line } = await plain();
    expect(locateCarrier(enc(`=====BEGIN ORIGINAL=====\n${line}\n=====END ORIGINAL=====\n`)).status).toBe("none");
    expect(locateCarrier(enc(`\n=====BEGIN ORIGINAL=====\n${line}\n=====END ORIGINAL=====\n`)).status).toBe("found");
  });

  test("PR59 carried: \"Text file with an earlier text block followed by content\": the earlier block is content, not a carrier", async () => {
    const { data, entries } = await plain();
    const file = await carry(data, entries);
    expect(locateCarrier(concat(file, enc("more notes\n"))).status).toBe("none");
    // With a later block too, only the last one is the carrier; the earlier one is content.
    const twice = await writeCarriedFile(concat(file, enc("more")), entries, { disclosed: carriedDisclosure(entries) }).catch((e: unknown) => e);
    expect(twice).toMatchObject({ code: "CARRIER_VERSION_MISMATCH" });
    const found = locateCarrier(concat(file, enc("more"), file.slice(data.length)));
    expect(found.status === "found" && same(found.version, concat(file, enc("more")))).toBe(true);
  });

  test("PR59 carried: \"Text block with CR LF line ends, followed by blank lines and spaces\": accepted; the trailing whitespace is part of the carrier", async () => {
    const data = enc("line one\r\nline two\r\n");
    const { alice, entries } = await original([{ data, mediaType: "text/plain" }]);
    const file = await carry(data, entries);
    // The writer follows the version's CR LF, after a single LF of its own.
    expect(dec(file).slice(data.length).startsWith("\n=====BEGIN ORIGINAL=====\r\n")).toBe(true);
    const padded = concat(file, enc("\r\n\r\n   \t\n  "));
    const r = await readCarriedFile(padded, { authors: [alice.evidence()], now: NOW });
    expect(same(r.version, data)).toBe(true);
    expect(r.verified.version).toBe(true);
  });

  test("PR59 carried: \"Text block in a CR LF file whose separator is CR LF, not a single LF\": the added CR is not part of the version; digest mismatch", async () => {
    const data = enc("line one\r\nline two");
    const { alice, entries } = await original([{ data, mediaType: "text/plain" }]);
    const file = await carry(data, entries);
    const crSeparator = concat(data, enc("\r"), file.slice(data.length));
    const r = await readCarriedFile(crSeparator, { authors: [alice.evidence()], now: NOW });
    expect(r.carrierStatus).toBe("found");
    expect(same(r.version, concat(data, enc("\r")))).toBe(true);
    expect(r.bytes).toBe("mismatch");
    expect(r.verified.version).toBe(false);
  });

  test("PR59 carried: \"Text block entry line with `\\u` escapes / with a raw non-ASCII character, closer, or `--` inside a `<!--` comment\": accepted, checked over its JCS form / no carrier", async () => {
    // The entry's metadata has "Môle", and MD3 a dash and arrow, so the writer escapes them.
    const { alice, entries } = await original([{ data: MD3, mediaType: "text/markdown" }]);
    const file = await carry(MD3, entries);
    const block = dec(file).slice(MD3.length);
    expect(/^[\x00-\x7f]*$/.test(block)).toBe(true);
    expect(block).toContain("M\\u00f4le");
    const r = await readCarriedFile(file, { authors: [alice.evidence()], now: NOW });
    expect(r.verified.version).toBe(true);
    // Un-escaped after signing: raw non-ASCII, `--`, or the closer inside the block is no carrier.
    for (const swap of [(s: string) => s.replace("M\\u00f4le", "Môle"), (s: string) => s.replace("Harbor notes", "Harbor -- notes"), (s: string) => s.replace("Harbor notes", "Harbor --> notes")]) {
      expect(locateCarrier(concat(MD3, enc(swap(block)))).status).toBe("none");
    }
    // `/*` comments: a `*/` inside a line is no carrier; the writer writes `*\/`.
    const css = enc("a { color: red }\n");
    const c = await original([{ data: css, mediaType: "text/css" }], { author: alice });
    const named = await updateOriginal(c.entries[0], { versionTime: c.at(), name: "a */ b", author: c.ref, sign: c.sign });
    const cssFile = await carry(css, [c.entries[0], named]);
    expect(dec(cssFile)).toContain("a *\\/ b");
    expect((await readCarriedFile(cssFile, { authors: [alice.evidence()], now: NOW })).verified.version).toBe(true);
    expect(locateCarrier(enc(dec(cssFile).replace("a *\\/ b", "a */ b"))).status).toBe("none");
  });
});

describe("P14.16, P7.15: text block writer refusals", () => {
  const refusal = async (data: Uint8Array, mediaType: string) => {
    const { entries } = await original([{ data, mediaType }]);
    return carry(data, entries).then(
      () => undefined,
      (e: { code?: string; details?: { reason?: string } }) => ({ code: e.code, reason: e.details?.reason }),
    );
  };

  test("PR59 carried: \"Writer asked for a text block on YAML ending in a block scalar, or Markdown ending in an unclosed fence\": refused", async () => {
    expect(await refusal(enc("name: harbor\nnotes: |\n  first line\n  second line\n"), "application/yaml")).toEqual({ code: "CARRIER_CANNOT_ADD", reason: "yaml-block-scalar" });
    expect(await refusal(enc("# Notes\n\n```js\nconst x = 1;\n"), "text/markdown")).toEqual({ code: "CARRIER_CANNOT_ADD", reason: "unclosed-fence" });
    // The same documents, closed, are accepted.
    expect(await refusal(enc("name: harbor\nnotes: |\n  first line\nsize: 3\n"), "application/yaml")).toBeUndefined();
    expect(await refusal(enc("# Notes\n\n```js\nconst x = 1;\n```\n"), "text/markdown")).toBeUndefined();
    // P14.16's other examples.
    expect((await refusal(enc("<p>hi</p>\n<script>\nlet a = 1;\n"), "text/html"))?.reason).toBe("unclosed-element");
    expect((await refusal(enc("<p>hi</p>\n<pre>\ncode\n"), "text/markdown"))?.reason).toBe("unclosed-element");
    expect((await refusal(enc("<p>hi <!-- note\n"), "text/html"))?.reason).toBe("unclosed-comment");
    expect((await refusal(enc("const s = `multi\nline"), "text/javascript"))?.reason).toBe("unterminated-string");
    expect((await refusal(enc("a { b: c } /* open"), "text/css"))?.reason).toBe("unclosed-comment");
    expect((await refusal(enc('cat <<EOF\nhello\n'), "text/x-shellscript"))?.reason).toBe("unterminated-heredoc");
    expect((await refusal(enc('x = """doc\n'), "text/x-python"))?.reason).toBe("unterminated-string");
    expect((await refusal(enc("echo a \\"), "text/x-shellscript"))?.reason).toBe("line-continuation");
  });

  test("PR59 carried: \"Writer asked for a text block on a version that is not valid UTF-8\": refused", async () => {
    expect(await refusal(Uint8Array.of(0x68, 0x69, 0xff, 0x0a), "text/plain")).toEqual({ code: "CARRIER_CANNOT_ADD", reason: "not-utf8" });
    // A leading UTF-8 byte order mark is allowed.
    expect(await refusal(concat(Uint8Array.of(0xef, 0xbb, 0xbf), enc("hi\n")), "text/plain")).toBeUndefined();
  });
});

describe("P14.17: JSON members", () => {
  async function jsonOriginal(text: string) {
    const data = enc(text);
    return { data, ...(await original([{ data, mediaType: "application/json" }])) };
  }

  test("PR59 carried: \"JSON member that is the root object's last, with entries reformatted and keys reordered\": accepted; entries checked over their JCS form", async () => {
    const { alice, data, entries } = await jsonOriginal('{"a":1}');
    const reformatted = (e: LogEntry) => {
      const reorder = (v: JsonValue): JsonValue =>
        Array.isArray(v) ? v.map(reorder) : v !== null && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().reverse().map((k) => [k, reorder((v as JsonObject)[k])])) : v;
      return JSON.stringify(reorder(e as unknown as JsonValue), null, 2).replace(/"Môle"/, '"M\\u00f4le"');
    };
    const file = enc(`{"a":1,\n  "originalLog": [\n${entries.map(reformatted).join(",\n")}\n  ]}`);
    const r = await readCarriedFile(file, { authors: [alice.evidence()], now: NOW });
    expect(r.carrier).toEqual({ kind: "json-member" });
    expect(same(r.version, data)).toBe(true);
    expect(r.verified).toEqual({ log: true, version: true });
  });

  test("PR59 carried: \"JSON member that is not last, or an earlier root member of the same name, including one spelled with escapes\": not a carrier; the log only as P7.12 allows", async () => {
    const { alice, entries } = await jsonOriginal('{"a":1}');
    const log = `[${entries.map((e) => JSON.stringify(e)).join(",")}]`;
    for (const [doc, where] of [
      [`{"originalLog":${log},"a":1}`, "json-member-not-last"],
      [`{"originalLog":[],"a":1,"originalLog":${log}}`, "json-member-repeated"],
      [`{"original\\u004cog":${log},"a":1,"originalLog":${log}}`, "json-member-repeated"],
    ] as const) {
      expect(locateCarrier(enc(doc)).status).toBe("none");
      const r = await readCarriedFile(enc(doc), { authors: [alice.evidence()], now: NOW });
      expect(r.carrierStatus).toBe("stray");
      expect(r.reasons).toContain(where);
      expect(r.version).toBeNull();
      expect(r.verified.version).toBe(false);
      expect(r.statements[0]).toContain("it is not a version of that Original");
    }
  });

  test("PR59 carried: \"JSON document with a 64-bit integer or a nested duplicate key outside the member\": the member is still found", async () => {
    const { entries } = await jsonOriginal('{"a":1}');
    const doc = `{"big":18446744073709551615,"nested":{"k":1,"k":2},"originalLog":[${entries.map((e) => JSON.stringify(e)).join(",")}]}`;
    const found = locateCarrier(enc(doc));
    expect(found.status === "found" && found.log.status).toBe("parsed");
    expect(found.status === "found" && dec(found.version)).toBe('{"big":18446744073709551615,"nested":{"k":1,"k":2}}');
  });

  test("PR59 carried: \"JSON document whose root is an array, or has a root member named `originalLog` anywhere\": writer refuses", async () => {
    for (const [text, reason] of [
      ["[1,2]", "json-root-not-object"],
      ['{"originalLog":1,"a":2}', "json-has-original-log"],
      ['{"a":2,"original\\u004cog":1}', "json-has-original-log"],
    ] as const) {
      const { data, entries } = await jsonOriginal(text);
      await expect(carry(data, entries)).rejects.toMatchObject({ code: "CARRIER_CANNOT_ADD", details: { reason } });
    }
  });

  test("PR59 carried: \"JSON last root member `originalLog` whose value is `5` or `[1]`\": a JSON member with an invalid log", () => {
    for (const doc of ['{"a":1,"originalLog":5}', '{"a":1,"originalLog":[1]}']) {
      const found = locateCarrier(enc(doc));
      expect(found.status).toBe("found");
      if (found.status === "found") {
        expect(found.log.status).toBe("invalid");
        expect(dec(found.version)).toBe('{"a":1}');
      }
    }
  });

  test("PR59 carried: \"JSON document `{\"originalLog\":[…]}` with a leading byte order mark / with no other member\": the version is the BOM and `{}` / `{}`", async () => {
    const bom = Uint8Array.of(0xef, 0xbb, 0xbf);
    for (const data of [concat(bom, enc("{}")), enc("{}")]) {
      const { alice, entries } = await original([{ data, mediaType: "application/json" }]);
      const file = await carry(data, entries);
      expect(dec(file).startsWith(`${dec(data).slice(0, -1)}"originalLog":[`)).toBe(true);
      const r = await readCarriedFile(file, { authors: [alice.evidence()], now: NOW });
      expect(same(r.version, data)).toBe(true);
      expect(r.verified.version).toBe(true);
    }
  });

  test("PR59 carried: \"JSON document nested 1,025 levels outside the entries\": no JSON member", async () => {
    const { entries } = await jsonOriginal('{"a":1}');
    const log = `"originalLog":[${entries.map((e) => JSON.stringify(e)).join(",")}]`;
    // The root is level 1: a member value 1,023 deep makes 1,024; one more is 1,025.
    const nest = (n: number) => `${"[".repeat(n)}${"]".repeat(n)}`;
    expect(locateCarrier(enc(`{"deep":${nest(1023)},${log}}`)).status).toBe("found");
    expect(locateCarrier(enc(`{"deep":${nest(1024)},${log}}`)).status).toBe("none");
  });
});

describe("P7.15, P7.16: writing", () => {
  test("PR59 carried: \"Writer asked to carry a draft, a version other than the last entry's, or, after anchoring, an entry not accepted on the anchor\": refused", async () => {
    const { entries } = await original([{ data: MD1, mediaType: "text/markdown" }, { data: MD3, mediaType: "text/markdown" }]);
    const disclosed = carriedDisclosure(entries);
    const { proof: _proof, ...unsigned } = entries[1];
    await expect(writeCarriedFile(MD3, [entries[0], { ...unsigned, proof: [] }], { disclosed })).rejects.toMatchObject({ code: "CARRIER_NOT_ACCEPTED" });
    // Version 1's bytes with a log whose last entry names version 2.
    await expect(writeCarriedFile(MD1, entries, { disclosed })).rejects.toMatchObject({ code: "CARRIER_VERSION_MISMATCH" });
    // No carrier for the media type: the log is offered separately instead.
    const pdf = await original([{ data: MD1, mediaType: "application/pdf" }]);
    expect(() => carriedDisclosure(pdf.entries)).toThrow(expect.objectContaining({ code: "CARRIER_NONE_FOR_MEDIA_TYPE" }));
    // An entry not accepted on the anchor is the SDK's to judge, since it holds the anchor; see packages/sdk/tests/unit/originals/carried.test.ts.
  });

  test("PR59 carried: \"Writer about to write a carrier\": the user is told what the file discloses first; a JSON carrier says the data gains a member", async () => {
    const md = await original([{ data: MD1, mediaType: "text/markdown" }, { data: MD3, mediaType: "text/markdown" }]);
    const d = carriedDisclosure(md.entries);
    expect(d).toMatchObject({ entries: 2, names: ["Harbor notes"], metadata: true, signers: [md.alice.did], dataGainsMember: false, anchor: null });
    expect(d.text).toContain("whole history");
    expect(d.text).toContain(md.alice.did);
    await expect(writeCarriedFile(MD3, md.entries, undefined as never)).rejects.toMatchObject({ code: "CARRIER_DISCLOSURE_REQUIRED" });
    const earlier = carriedDisclosure(md.entries.slice(0, 1));
    await expect(writeCarriedFile(MD3, md.entries, { disclosed: earlier })).rejects.toMatchObject({ code: "CARRIER_DISCLOSURE_REQUIRED" });
    const json = await original([{ data: enc("{}"), mediaType: "application/json" }]);
    const jd = carriedDisclosure(json.entries);
    expect(jd.dataGainsMember).toBe(true);
    expect(jd.text).toContain("gains a member named originalLog");
  });

  test("PR59 carried: \"Writer about to write a carrier for a log with an `anchor` member\": the user is told the file discloses the chain and the minter's address", async () => {
    const { entries } = await original([{ data: PNG, mediaType: "image/png" }]);
    // No writer here may write an `anchor` member (P14.21); the disclosure is checked on a log that has one.
    const withAnchor = structuredClone(entries) as LogEntry[];
    (withAnchor[0].state.asset as JsonObject).anchor = { chain: "eip155:4663", minter: "0x" + "ab".repeat(20) };
    const d = carriedDisclosure(withAnchor);
    expect(d.anchor).toEqual({ chain: "eip155:4663", minter: "0x" + "ab".repeat(20) });
    expect(d.text).toContain("eip155:4663");
    expect(d.text).toContain("0x" + "ab".repeat(20));
  });

  test("PR59 carried: \"Carried file presented by an SDK or UI\": never labelled an evidence package or complete", async () => {
    const { alice, entries } = await original([{ data: PNG, mediaType: "image/png" }]);
    const r = await readCarriedFile(await carry(PNG, entries), { authors: [alice.evidence()], now: NOW });
    expect(r.kind).toBe("carried-file");
    expect(r.completeness).toBe("no-claim");
    expect(r.statements[r.statements.length - 1]).toBe("A carried file is not an evidence package and makes no claim to be complete.");
    expect(JSON.stringify({ ...r, report: null, version: null })).not.toMatch(/evidence-package|"completeness":"complete"/);
    expect(carriedDisclosure(entries).text).toContain("not an evidence package");
  });

  test("PR59 carried: \"Writer asked to inscribe or publish a carried file as a body\": the carrier is removed first; the body is the version's bytes", async () => {
    const { entries } = await original([{ data: PNG, mediaType: "image/png" }]);
    const file = await carry(PNG, entries);
    expect(resourceDigest(file)).not.toBe(entries[0].state.asset && (entries[0].state.asset as JsonObject & { resource: ResourceDescriptor }).resource.digest);
    const body = removeCarrier(file);
    expect(same(body, PNG)).toBe(true);
    expect(same(removeCarrier(PNG), PNG)).toBe(true);
  });

  test("PR59 carried: \"Writer making a carried file from an accepted publication's body and entries\": allowed, as for any accepted checkpoint", async () => {
    const { alice, entries } = await original([{ data: PNG, mediaType: "image/png" }]);
    // An inscription's metadata and body are the two parts of a carried file (P7.16).
    const inscribed = carrying(entries);
    const read = readInscribedEntries(inscribed.metadata);
    expect(read.kind).toBe("entries");
    const fromChain = read.kind === "entries" ? read.entries : [];
    const body = PNG; // `carrying` only knows bytes described with `photo`; the body is the version's bytes.
    const file = await carry(body, fromChain);
    const r = await readCarriedFile(file, { authors: [alice.evidence()], now: NOW });
    expect(r.verified.version).toBe(true);
  });
});

describe("P7.14: anchored Originals", () => {
  const SAT = "did:btco:reg:5000000000";
  const T0 = Date.parse("2026-10-18T12:00:00Z");
  const time = (height: number) => new Date(T0 + height * 600_000 - 60_000).toISOString();
  let counter = 0;
  const inscribe = (entries: LogEntry[], height: number): Omit<SatInscription, "sat" | "network"> => ({
    id: `${(counter++).toString(16).padStart(64, "0")}i0`,
    height,
    transactionIndex: 1,
    inscriptionIndex: 0,
    confirmations: 120 - height,
    inscriptionTime: T0 + height * 600_000,
    ...carrying(entries),
  });
  const sat = (inscriptions: Array<Omit<SatInscription, "sat" | "network">>): SatEvidence => {
    const { sat: number, network } = parseBtcoAlias(SAT);
    return { sat: SAT, index: "ord-a", tip: { height: 119, hash: "bb".repeat(32) }, inscriptions: inscriptions.map((i) => ({ sat: number, network, ...i })), owner: { output: "aa".repeat(32) + ":0", confirmations: 3 } };
  };
  const B1 = "harbor at dawn";

  async function anchored() {
    const alice = await VhAuthor.create([{ fragment: "orig", signer: KA }]);
    const sign = alice.signer(KA, "orig");
    const ref = alice.ref("orig");
    const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", resource: photo(B1, "image/png"), author: ref, sign });
    const renamed = await updateOriginal(genesis, { versionTime: time(2), name: "Harbor at dawn", author: ref, sign });
    const anchor = await updateOriginal(renamed, { versionTime: time(10), aliases: [SAT], author: ref, sign });
    return { alice, sign, ref, genesis, renamed, anchor };
  }

  test("PR59 carried: \"Anchored Original's carried log read without access to the anchor\": missing evidence; at most the entries before the anchoring entry; the anchoring entry and later not checked against the anchor", async () => {
    const { alice, genesis, renamed, anchor } = await anchored();
    const file = await carry(bytes(B1), [genesis, renamed, anchor]);
    const r = await readCarriedFile(file, { authors: [alice.evidence()], now: NOW });
    expect(r.anchoring).toEqual({ status: "bitcoin-unread", sat: SAT, notCheckedAgainstAnchor: [anchor.versionId] });
    expect(r.reasons).toContain("bitcoin-evidence-missing");
    expect(r.validAsOf?.checkpoint).toBe(renamed.versionId);
    expect(r.report?.ordering).toBe("claimed");
    expect(r.verified).toEqual({ log: false, version: false });
    expect(r.current).toBe(false);
  });

  test("PR59 carried: \"Anchored Original whose carried log disagrees with its anchor\": state from the anchor; the carried log is not preferred", async () => {
    const { alice, ref, sign, genesis, renamed, anchor } = await anchored();
    // The carried log is a different anchoring entry, never inscribed.
    const other = await updateOriginal(renamed, { versionTime: time(9), name: "Harbor, renamed in the copy", aliases: [SAT], author: ref, sign });
    const file = await carry(bytes(B1), [genesis, renamed, other]);
    const r = await readCarriedFile(file, { authors: [alice.evidence()], bitcoin: [sat([inscribe([genesis, renamed, anchor], 10)])], now: NOW });
    expect(r.anchoring.status).toBe("bitcoin");
    expect(r.report?.anchoring?.status).toBe("anchored");
    expect(r.report?.state?.name).toBe("Harbor at dawn");
    expect(r.reasons).toContain("carried-log-not-accepted-on-anchor");
    expect(r.verified.log).toBe(false);
    // The state on the anchor is current; the copy is not what it reports.
    expect(r.current).toBe(true);
    // A carried log the anchor accepted verifies.
    const agreeing = await readCarriedFile(await carry(bytes(B1), [genesis, renamed, anchor]), { authors: [alice.evidence()], bitcoin: [sat([inscribe([genesis, renamed, anchor], 10)])], now: NOW });
    expect(agreeing.verified).toEqual({ log: true, version: true });
  });

  test("PR59 carried: \"Carried log with an `anchor` member naming a chain the reader's revision does not list, or read while P14.21 pins no contract\": unsupported, not invalid; nothing verified", async () => {
    const { alice, entries } = await original([{ data: PNG, mediaType: "image/png" }]);
    const withAnchor = structuredClone(entries) as LogEntry[];
    (withAnchor[0].state.asset as JsonObject).anchor = { chain: "eip155:1", minter: "0x" + "cd".repeat(20) };
    const L = enc(serializeLog(withAnchor));
    const footer = new Uint8Array(24);
    new DataView(footer.buffer).setUint32(4, L.length);
    footer.set(TRAILER_MAGIC, 8);
    const r = await readCarriedFile(concat(PNG, L, footer), { authors: [alice.evidence()], now: NOW });
    expect(r.anchoring.status).toBe("unsupported");
    expect(r.anchoring.chain).toBe("eip155:1");
    expect(r.reasons).toContain("anchor-chain-unsupported");
    expect(r.history).toBe("unchecked"); // not "invalid"
    expect(r.verified).toEqual({ log: false, version: false });
  });
});
