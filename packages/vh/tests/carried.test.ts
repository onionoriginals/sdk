/**
 * Carried logs (proposed; aviarytech/originals-spec PR 59 at a3ffdc1):
 * P7.11-P7.16, P14.14-P14.17. Each test cites its section 12 row by C12 id,
 * followed by a quote of the row's first column.
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
  test("C12-206: \"`mediaType` `image/PNG` / `application/javascript` / `application/pdf` / `application/vc+json`\": trailer / none / none / none", () => {
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

  test("C12-319: \"Descriptor `mediaType` with a parameter, such as `text/plain; charset=utf-8`\": rejected; the parameter is not ignored (P14.6, P14.14)", async () => {
    for (const mediaType of ["text/plain; charset=utf-8", "text/plain;charset=utf-8", "application/json; profile=x"]) {
      expect(carrierFor(mediaType)).toBeNull();
      // A verifier rejects the descriptor itself (P14.6): no entry can name it.
      await expect(original([{ data: MD1, mediaType }])).rejects.toMatchObject({ category: "invalid-evidence", code: "STATE_RESOURCE" });
    }
    // An entry signed with one anyway is invalid, not matched with its parameter ignored.
    const { alice, entries } = await original([{ data: MD1, mediaType: "text/plain" }]);
    const forged = structuredClone(entries) as LogEntry[];
    ((forged[0].state.asset as JsonObject).resource as JsonObject).mediaType = "text/plain; charset=utf-8";
    const block = `\n=====BEGIN ORIGINAL=====\n${asciiEntryLine(forged[0] as unknown as JsonValue, "none")}\n=====END ORIGINAL=====\n`;
    const r = await readCarriedFile(concat(MD1, enc(block)), { authors: [alice.evidence()], now: NOW });
    expect(r.expectedCarrier).toBeNull();
    expect(r.carrierStatus).toBe("mismatch");
    expect(r.overall.status).toBe("failed");
    expect(r.verified).toEqual({ log: false, version: false });
  });

  test("C12-318: \"Carried file with a wrong or missing file name extension\": the extension is only a hint; the other carriers are tried, and the carrier found is checked against the verified descriptor's `mediaType` (P14.14)", async () => {
    const png = await original([{ data: PNG, mediaType: "image/png" }]);
    const file = await carry(PNG, png.entries);
    for (const hint of [undefined, "harbor.png", "harbor.json", "harbor.md", "harbor", "text/plain", "application/json", "image/png"]) {
      const found = locateCarrier(file, hint === undefined ? undefined : { hint });
      expect(found.status === "found" && found.carrier).toEqual({ kind: "trailer" });
      const r = await readCarriedFile(file, { authors: [png.alice.evidence()], now: NOW, ...(hint ? { hint } : {}) });
      expect(r.carrier).toEqual({ kind: "trailer" });
      expect(r.overall.status).toBe("verified");
    }
    const json = enc('{"a":1}');
    const doc = await original([{ data: json, mediaType: "application/json" }]);
    const jsonFile = await carry(json, doc.entries);
    for (const hint of ["notes.png", "notes.txt", "image/png"]) {
      const r = await readCarriedFile(jsonFile, { authors: [doc.alice.evidence()], now: NOW, hint });
      expect(r.carrier).toEqual({ kind: "json-member" });
      expect(r.verified.version).toBe(true);
    }
    // The carrier found is still checked against the last entry's mediaType, whatever the hint said.
    const md = await original([{ data: MD1, mediaType: "text/markdown" }]);
    const block = dec(await carry(MD1, md.entries)).slice(MD1.length);
    const other = await original([{ data: MD1, mediaType: "text/css" }], { author: md.alice });
    const lines = block.split("\n").filter((l) => l.startsWith("{"));
    const rewritten = block.replace(lines.join("\n"), other.entries.map((e) => asciiEntryLine(e as unknown as JsonValue, "<!--")).join("\n"));
    const r = await readCarriedFile(concat(MD1, enc(rewritten)), { authors: [md.alice.evidence()], now: NOW, hint: "notes.css" });
    expect(r.carrierStatus).toBe("mismatch");
  });
});

describe("P7.12, P7.13: reading a carried file", () => {
  test("C12-200: \"Carried file whose bytes, with the carrier removed, are the version its log's last entry names, signer DIDs resolved\": log and version verified, valid as of that checkpoint, never current", async () => {
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
    expect(r.overall).toEqual({ status: "verified", reason: null });
    // P7.14: a log with no anchoring entry is a historical checkpoint; nothing is said about anchoring since.
    expect(r.anchoring.status).toBe("historical-checkpoint");
    expect(r.reasons).toContain("historical-checkpoint");
    expect(r.reasons).not.toContain("not-anchored");
    // Other versions' bytes are unavailable content, not a failure (P7.13, P7.4).
    expect(r.report?.resources.status).toBe("partial");
    expect(r.report?.resources.missing.map((v) => v.version)).toEqual([1, 2]);
  });

  test("C12-200: \"Carried file whose bytes, with the carrier removed, are the version …\" for a trailer and a JSON member as well", async () => {
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

  test("C12-201: \"Carried file whose remaining bytes differ by one byte, or by changed line endings\": bytes not verified; overall file verification fails with an explicit reason; verified proofs do not make it a pass", async () => {
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
      // The log's own result is reported separately, as detail: it does not make the file a pass (P7.12).
      expect(r.verified.log).toBe(true);
      expect(r.proofs).toBe("checked");
      expect(r.overall).toEqual({ status: "failed", reason: "file-digest-mismatch" });
      expect(r.reasons).toContain("file-digest-mismatch");
      // The remaining bytes are not passed into the log's own verification.
      expect(r.report?.resources.missing.map((v) => v.version)).toEqual([1]);
      expect(r.statements[0]).toContain(`carries the log of ${r.original} at ${entries[0].versionId}, but it is not a version of that Original`);
    }
  });

  test("C12-202: \"Carried file opened or previewed without the caller's opt-in to resolve\": no DID resolved; proofs unchecked", async () => {
    const { entries } = await original([{ data: PNG, mediaType: "image/png" }]);
    const r = await readCarriedFile(await carry(PNG, entries), { now: NOW });
    expect(r.signers.requested).toBe(false);
    expect(r.signers.resolved).toEqual([]);
    expect(r.proofs).toBe("unchecked");
    expect(r.report).toBeNull();
    expect(r.verified).toEqual({ log: false, version: false });
    expect(r.overall).toEqual({ status: "incomplete", reason: "proofs-unchecked" });
  });

  test("C12-203: \"Carried file read offline, signer DID not resolvable\": proofs unchecked; identity evidence and author binding incomplete; never a pass", async () => {
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

  test("C12-204: \"Forged log naming a real author DID, appended to bytes matching its last descriptor\": proofs fail once resolved; offline nothing verified", async () => {
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

  test("C12-205: \"Carried log whose last entry names a media type with a different carrier or comment syntax, or none\": no valid carrier", async () => {
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
      expect(r.overall).toEqual({ status: "failed", reason: "carrier-not-for-media-type" });
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

  test("C12-207: \"Trailer whose length exceeds the file size less 24, or whose footer is altered by end-of-line conversion\": no trailer", async () => {
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

  test("C12-208: \"Trailer `length` 16,777,192 / 16,777,193\": trailer / no trailer", () => {
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

  test("C12-209: \"File of 16–23 bytes ending in the footer magic\": no trailer", () => {
    for (let n = 16; n <= 23; n++) {
      const file = new Uint8Array(n);
      file.set(TRAILER_MAGIC, n - 16);
      expect(locateCarrier(file).status).toBe("none");
    }
  });

  test("C12-210: \"Trailer entry line of 70,000 bytes whose JCS form is 60,000 bytes\": within the entry limit, which is measured over the JCS form in every format", async () => {
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
    expect(r.log.status).toBe("parsed");
    expect(r.chain.status).toBe("chains-from-genesis");
    expect(r.history).toBe("valid");
    // As in a text block, where the same entry is measured as its JCS form too (P14.14).
    const block = `\n=====BEGIN ORIGINAL=====\n${line}\n=====END ORIGINAL=====\n`;
    const text = await readCarriedFile(concat(enc("notes"), enc(block)), { now: NOW });
    expect(text.log.status).toBe("parsed");
  });

  test("C12-150: \"Entry whose JCS form is 65,536 / 65,537 UTF-8 bytes, in `did.jsonl`, an inscription, a publication or any carrier\": accepted / rejected, in a trailer", async () => {
    const { alice, at, ref, sign } = await original([{ data: PNG, mediaType: "image/png" }]);
    const atSize = async (target: number) => {
      let pad = 65_000;
      for (let i = 0; i < 40; i++) {
        const e = await createOriginal({ versionTime: at(), name: "Big", metadata: { pad: "a".repeat(pad) }, resource: described(PNG, "image/png"), author: ref, sign });
        const size = enc(canonicalize(e as unknown as JsonValue)).length;
        if (size === target) return e;
        pad += target - size;
      }
      throw new Error(`no entry of ${target} bytes`);
    };
    for (const [target, ok] of [[65_536, true], [65_537, false]] as const) {
      const e = await atSize(target);
      // Written with some escapes, so the line is longer than the JCS form: the JCS form is what counts.
      const line = JSON.stringify(e).replace("aaaa", "\\u0061\\u0061\\u0061\\u0061");
      expect(enc(line).length).toBe(target + 20);
      const L = enc(`${line}\n`);
      const r = await readCarriedFile(concat(PNG, L, footer(L.length)), { authors: [alice.evidence()], now: NOW });
      if (ok) expect(r.history, JSON.stringify(r.report?.history.failure)).toBe("valid");
      else expect(r.chain.failure).toMatchObject({ category: "limit-exceeded", code: "ENTRY_TOO_LARGE" });
    }
  });

  test("C12-211: \"Trailer whose log breaks P14.2\": trailer found; log invalid", async () => {
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

  test("C12-212: \"Text block whose last line has no line end\": accepted", async () => {
    const { alice, data, line } = await plain();
    const file = concat(data, enc(`\n=====BEGIN ORIGINAL=====\n${line}\n=====END ORIGINAL=====`));
    const r = await readCarriedFile(file, { authors: [alice.evidence()], now: NOW });
    expect(r.carrier).toEqual({ kind: "text-block", comment: "none" });
    expect(r.verified.version).toBe(true);
  });

  test("C12-213: \"Text block with a blank, unprefixed or non-JSON line between the markers, or no entry line\": a text block with an invalid log, not content", async () => {
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

  test("C12-214: \"Text block at the very start of the file, with no line feed before it\": no carrier", async () => {
    const { line } = await plain();
    expect(locateCarrier(enc(`=====BEGIN ORIGINAL=====\n${line}\n=====END ORIGINAL=====\n`)).status).toBe("none");
    expect(locateCarrier(enc(`\n=====BEGIN ORIGINAL=====\n${line}\n=====END ORIGINAL=====\n`)).status).toBe("found");
  });

  test("C12-216: \"Text file with an earlier text block followed by content\": the earlier block is content, not a carrier", async () => {
    const { data, entries } = await plain();
    const file = await carry(data, entries);
    expect(locateCarrier(concat(file, enc("more notes\n"))).status).toBe("none");
    // With a later block too, only the last one is the carrier; the earlier one is content.
    const twice = await writeCarriedFile(concat(file, enc("more")), entries, { disclosed: carriedDisclosure(entries) }).catch((e: unknown) => e);
    expect(twice).toMatchObject({ code: "CARRIER_VERSION_MISMATCH" });
    const found = locateCarrier(concat(file, enc("more"), file.slice(data.length)));
    expect(found.status === "found" && same(found.version, concat(file, enc("more")))).toBe(true);
  });

  test("C12-217: \"Text block with CR LF line ends, followed by blank lines and spaces\": accepted; the trailing whitespace is part of the carrier", async () => {
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

  test("C12-218: \"Text block in a CR LF file whose separator is CR LF, not a single LF\": the added CR is left in the remaining bytes: digest mismatch, and file verification fails", async () => {
    const data = enc("line one\r\nline two");
    const { alice, entries } = await original([{ data, mediaType: "text/plain" }]);
    const file = await carry(data, entries);
    const crSeparator = concat(data, enc("\r"), file.slice(data.length));
    const r = await readCarriedFile(crSeparator, { authors: [alice.evidence()], now: NOW });
    expect(r.carrierStatus).toBe("found");
    expect(same(r.version, concat(data, enc("\r")))).toBe(true);
    expect(r.bytes).toBe("mismatch");
    expect(r.verified.version).toBe(false);
    expect(r.overall).toEqual({ status: "failed", reason: "file-digest-mismatch" });
  });

  test("C12-320: \"Text block whose closer line is not directly preceded by the END marker, or whose BEGIN marker in a block comment is not directly preceded by the opener\": no carrier (P14.16)", async () => {
    const { entries } = await original([{ data: MD1, mediaType: "text/markdown" }]);
    const file = dec(await carry(MD1, entries));
    const block = file.slice(MD1.length);
    expect(block.startsWith("\n<!--\n=====BEGIN ORIGINAL=====\n")).toBe(true);
    expect(locateCarrier(enc(file)).status).toBe("found");
    const broken = [
      // A line between the END marker and the closer.
      file.replace("=====END ORIGINAL=====\n-->", "=====END ORIGINAL=====\nnote\n-->"),
      // No END marker at all before the closer.
      file.replace("=====END ORIGINAL=====\n", ""),
      // A line between the opener and the BEGIN marker.
      file.replace("<!--\n=====BEGIN ORIGINAL=====", "<!--\nnote\n=====BEGIN ORIGINAL====="),
      // No opener before the BEGIN marker.
      file.replace("\n<!--\n=====BEGIN", "\n=====BEGIN"),
    ];
    for (const b of broken) expect(locateCarrier(enc(b)).status).toBe("none");
    // CSS (`/*`) too.
    const css = enc("a { color: red }\n");
    const c = await original([{ data: css, mediaType: "text/css" }]);
    const cssFile = dec(await carry(css, c.entries));
    expect(locateCarrier(enc(cssFile)).status).toBe("found");
    expect(locateCarrier(enc(cssFile.replace("=====END ORIGINAL=====\n*/", "=====END ORIGINAL=====\n\n*/"))).status).toBe("none");
    expect(locateCarrier(enc(cssFile.replace("/*\n=====BEGIN", "/*\n\n=====BEGIN"))).status).toBe("none");
  });

  test("P14.16: removing a carrier restores the version's exact bytes, for every comment syntax and line end", async () => {
    const versions: Array<[string, string]> = [
      ["text/plain", "a\r\nb\r\n"],
      ["text/plain", "no final line end"],
      ["text/markdown", "# T\n\n<pre>\nkept open\n"],
      ["text/css", "a { b: c }"],
      ["text/javascript", "let a = 1;\r\n"],
      ["text/x-python", "x = 1\n\n\n"],
      ["application/sql", "select 1;"],
    ];
    for (const [mediaType, text] of versions) {
      const data = concat(Uint8Array.of(0xef, 0xbb, 0xbf), enc(text));
      const { entries } = await original([{ data, mediaType }]);
      const file = await carry(data, entries);
      expect(same(removeCarrier(file), data)).toBe(true);
    }
  });

  test("C12-219: \"Text block entry line with `\\u` escapes / with a raw non-ASCII character, closer, or `--` inside a `<!--` comment\": accepted, checked over its JCS form / no carrier", async () => {
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

  test("C12-215: \"Writer asked for a text block on YAML ending in a block scalar, or Markdown ending in an unclosed fence\": refused", async () => {
    expect(await refusal(enc("name: harbor\nnotes: |\n  first line\n  second line\n"), "application/yaml")).toEqual({ code: "CARRIER_CANNOT_ADD", reason: "yaml-block-scalar" });
    expect(await refusal(enc("# Notes\n\n```js\nconst x = 1;\n"), "text/markdown")).toEqual({ code: "CARRIER_CANNOT_ADD", reason: "unclosed-fence" });
    // The same documents, closed, are accepted.
    expect(await refusal(enc("name: harbor\nnotes: |\n  first line\nsize: 3\n"), "application/yaml")).toBeUndefined();
    expect(await refusal(enc("# Notes\n\n```js\nconst x = 1;\n```\n"), "text/markdown")).toBeUndefined();
    // P14.16's other examples.
    expect((await refusal(enc("<p>hi</p>\n<script>\nlet a = 1;\n"), "text/html"))?.reason).toBe("unclosed-element");
    // An unclosed `pre` is no longer a reason to refuse (P14.16 at a3ffdc1): see C12-321 below.
    expect((await refusal(enc("<p>hi</p>\n<script>\nlet a = 1;\n"), "text/markdown"))?.reason).toBe("unclosed-element");
    expect((await refusal(enc("<p>hi <!-- note\n"), "text/html"))?.reason).toBe("unclosed-comment");
    expect((await refusal(enc("const s = `multi\nline"), "text/javascript"))?.reason).toBe("unterminated-string");
    expect((await refusal(enc("a { b: c } /* open"), "text/css"))?.reason).toBe("unclosed-comment");
    expect((await refusal(enc('cat <<EOF\nhello\n'), "text/x-shellscript"))?.reason).toBe("unterminated-heredoc");
    expect((await refusal(enc('x = """doc\n'), "text/x-python"))?.reason).toBe("unterminated-string");
    expect((await refusal(enc("echo a \\"), "text/x-shellscript"))?.reason).toBe("line-continuation");
  });

  test("C12-321: \"HTML version ending inside an open `script`, `style` or `textarea` element / inside an open `pre` element\": writer refuses / writer accepts; the block parses as a separate comment (P14.16)", async () => {
    for (const mediaType of ["text/html", "application/xhtml+xml", "text/markdown"]) {
      for (const element of ["script", "style", "textarea", "title", "xmp", "noscript"]) {
        expect(await refusal(enc(`<p>hi</p>\n<${element}>\nsome text\n`), mediaType)).toEqual({ code: "CARRIER_CANNOT_ADD", reason: "unclosed-element" });
        // Closed, the same element is no reason to refuse.
        expect(await refusal(enc(`<p>hi</p>\n<${element}>\nsome text\n</${element}>\n`), mediaType)).toBeUndefined();
      }
      expect((await refusal(enc("<p>hi</p>\n<plaintext>\n"), mediaType))?.reason).toBe("unclosed-element");
      expect((await refusal(enc("<p>hi <!-- open\n"), mediaType))?.reason).toBe("unclosed-comment");
      // `pre` content is parsed as markup: the block is still a comment.
      expect(await refusal(enc("<p>hi</p>\n<pre>\ncode\n"), mediaType)).toBeUndefined();
      expect(await refusal(enc("<PRE class=x>\ncode"), mediaType)).toBeUndefined();
    }
    // An empty comment `<!-->` is closed (HTML).
    expect(await refusal(enc("<p>a <!--> b</p>\n"), "text/html")).toBeUndefined();
  });

  test("P14.16: XML types refuse an ending inside a comment or CDATA section; CSS inside a comment or string", async () => {
    for (const mediaType of ["image/svg+xml", "application/xml", "text/xml"]) {
      expect((await refusal(enc("<svg><!-- open"), mediaType))?.reason).toBe("unclosed-comment");
      expect((await refusal(enc("<svg><![CDATA[ open"), mediaType))?.reason).toBe("unclosed-cdata");
      // Under an XML parser a `script` element's content is markup: no reason to refuse.
      expect(await refusal(enc("<svg><script>\nlet a = 1;\n"), mediaType)).toBeUndefined();
    }
    expect((await refusal(enc("a { b: c } /* open"), "text/css"))?.reason).toBe("unclosed-comment");
    expect((await refusal(enc('a { content: "open'), "text/css"))?.reason).toBe("unterminated-string");
    expect(await refusal(enc('a { content: "closed" }\n'), "text/css")).toBeUndefined();
  });

  test("C12-322: \"Shell or C-family version whose last line ends in a line continuation\": writer refuses (P14.16)", async () => {
    for (const mediaType of ["text/x-shellscript", "text/x-c", "text/x-c++", "text/javascript", "text/x-python", "application/sql", "application/toml", "application/yaml"]) {
      for (const text of ["x \\", "x \\\n", "x \\\r\n"]) {
        expect(await refusal(enc(`first\n${text}`), mediaType)).toEqual({ code: "CARRIER_CANNOT_ADD", reason: "line-continuation" });
      }
      // A backslash that is not the last line's end is no continuation of the block.
      expect(await refusal(enc("x \\ y\nlast\n"), mediaType)).toBeUndefined();
    }
    // A text/plain version has no comment syntax: no continuation either.
    expect(await refusal(enc("x \\"), "text/plain")).toBeUndefined();
  });

  test("C12-220: \"Writer asked for a text block on a version that is not valid UTF-8\": refused", async () => {
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

  test("C12-221: \"JSON member that is the root object's last, with entries reformatted and keys reordered\": accepted; entries checked over their JCS form", async () => {
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

  test("C12-222: \"JSON member that is not the root object's last, as after a tool reorders members\": found; its log verified and reported separately; the file not verified as a version (P7.12, P14.17)", async () => {
    const { alice, entries } = await jsonOriginal('{"a":1}');
    const log = `[${entries.map((e) => JSON.stringify(e)).join(",")}]`;
    for (const doc of [`{"originalLog":${log},"a":1}`, `{"b":2,"originalLog":${log},"a":1}`]) {
      const found = locateCarrier(enc(doc));
      expect(found.status).toBe("none");
      expect(found.status === "none" && found.stray?.where).toBe("json-member-not-last");
      const r = await readCarriedFile(enc(doc), { authors: [alice.evidence()], now: NOW });
      expect(r.carrierStatus).toBe("stray");
      expect(r.reasons).toContain("json-member-not-last");
      // Its log is verified and reported separately...
      expect(r.verified.log).toBe(true);
      expect(r.original).toBe((entries[0].state as { id: string }).id);
      // ...and the file is not verified as a version: how to remove a member that is not last is open (D4).
      expect(r.version).toBeNull();
      expect(r.bytes).toBe("not-checked");
      expect(r.verified.version).toBe(false);
      expect(r.overall).toEqual({ status: "failed", reason: "json-member-not-last" });
      expect(r.statements[0]).toContain("it is not a version of that Original");
    }
  });

  test("C12-308: \"Two root members named `originalLog`, including one spelled with escapes\": rejected; neither is chosen (P14.17)", async () => {
    const { alice, entries } = await jsonOriginal('{"a":1}');
    const log = `[${entries.map((e) => JSON.stringify(e)).join(",")}]`;
    for (const doc of [`{"originalLog":[],"a":1,"originalLog":${log}}`, `{"original\\u004cog":${log},"a":1,"originalLog":${log}}`, `{"a":1,"originalLog":${log},"originalLog":${log}}`]) {
      expect(locateCarrier(enc(doc))).toEqual({ status: "rejected", reason: "json-member-repeated" });
      const r = await readCarriedFile(enc(doc), { authors: [alice.evidence()], now: NOW });
      expect(r.carrierStatus).toBe("rejected");
      expect(r.log.status).toBe("absent");
      expect(r.original).toBeNull();
      expect(r.report).toBeNull();
      expect(r.verified).toEqual({ log: false, version: false });
      expect(r.overall).toEqual({ status: "failed", reason: "json-member-repeated" });
    }
  });

  test("C12-309: \"Member named `originalLog` nested below the root\": not a JSON member (P14.17)", async () => {
    const { entries } = await jsonOriginal('{"a":1}');
    const log = `[${entries.map((e) => JSON.stringify(e)).join(",")}]`;
    expect(locateCarrier(enc(`{"a":1,"inner":{"originalLog":${log}}}`))).toEqual({ status: "none" });
    expect(locateCarrier(enc(`{"a":[{"originalLog":${log}}]}`))).toEqual({ status: "none" });
    // A nested member does not count against the root's one either.
    expect(locateCarrier(enc(`{"inner":{"originalLog":${log}},"originalLog":${log}}`)).status).toBe("found");
  });

  test("P14.17: the writer inserts the member immediately after the last member's value, before the whitespace that followed it, or right after `{`", async () => {
    for (const [text, at] of [
      ['{"a":1 \n}\n', '{"a":1'.length],
      ['{\n  "a": [1, 2]\n}', '{\n  "a": [1, 2]'.length],
      ["{ }", 1],
    ] as const) {
      const { alice, data, entries } = await jsonOriginal(text);
      const file = dec(await carry(data, entries));
      const member = `${at === 1 ? "" : ","}"originalLog":[${entries.map((e) => canonicalize(e as unknown as JsonValue)).join(",")}]`;
      // Every other byte is unchanged.
      expect(file).toBe(text.slice(0, at) + member + text.slice(at));
      const r = await readCarriedFile(enc(file), { authors: [alice.evidence()], now: NOW });
      expect(same(r.version, data)).toBe(true);
      expect(r.overall.status).toBe("verified");
    }
  });

  test("C12-223: \"JSON document with a 64-bit integer or a nested duplicate key outside the member\": the member is still found", async () => {
    const { entries } = await jsonOriginal('{"a":1}');
    const doc = `{"big":18446744073709551615,"nested":{"k":1,"k":2},"originalLog":[${entries.map((e) => JSON.stringify(e)).join(",")}]}`;
    const found = locateCarrier(enc(doc));
    expect(found.status === "found" && found.log.status).toBe("parsed");
    expect(found.status === "found" && dec(found.version)).toBe('{"big":18446744073709551615,"nested":{"k":1,"k":2}}');
  });

  test("C12-224: \"JSON document whose root is an array, or has a root member named `originalLog` anywhere\": writer refuses", async () => {
    for (const [text, reason] of [
      ["[1,2]", "json-root-not-object"],
      ['{"originalLog":1,"a":2}', "json-has-original-log"],
      ['{"a":2,"original\\u004cog":1}', "json-has-original-log"],
    ] as const) {
      const { data, entries } = await jsonOriginal(text);
      await expect(carry(data, entries)).rejects.toMatchObject({ code: "CARRIER_CANNOT_ADD", details: { reason } });
    }
  });

  test("C12-225: \"JSON last root member `originalLog` whose value is `5` or `[1]`\": a JSON member with an invalid log", () => {
    for (const doc of ['{"a":1,"originalLog":5}', '{"a":1,"originalLog":[1]}']) {
      const found = locateCarrier(enc(doc));
      expect(found.status).toBe("found");
      if (found.status === "found") {
        expect(found.log.status).toBe("invalid");
        expect(dec(found.version)).toBe('{"a":1}');
      }
    }
  });

  test("C12-226: \"JSON document `{\"originalLog\":[…]}` with a leading byte order mark / with no other member\": the version is the BOM and `{}` / `{}`", async () => {
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

  test("C12-227: \"JSON document nested 1,025 levels outside the entries, counting the root object as level 1\": no JSON member", async () => {
    const { entries } = await jsonOriginal('{"a":1}');
    const log = `"originalLog":[${entries.map((e) => JSON.stringify(e)).join(",")}]`;
    // The root is level 1: a member value 1,023 deep makes 1,024; one more is 1,025.
    const nest = (n: number) => `${"[".repeat(n)}${"]".repeat(n)}`;
    expect(locateCarrier(enc(`{"deep":${nest(1023)},${log}}`)).status).toBe("found");
    expect(locateCarrier(enc(`{"deep":${nest(1024)},${log}}`)).status).toBe("none");
  });
});

describe("P7.15, P7.16: writing", () => {
  test("C12-228: \"Writer asked to carry a draft, a version other than the last entry's, or, after anchoring, an entry not accepted on the anchor\": refused", async () => {
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

  test("C12-229: \"Writer about to write a carrier\": the user is told what the file discloses first; a JSON carrier says the data gains a member", async () => {
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

  test("C12-292: \"Writer about to write a carrier for a log with an `anchor` member\": the user is told the file discloses the chain and the minter's address", async () => {
    const { entries } = await original([{ data: PNG, mediaType: "image/png" }]);
    // No writer here may write an `anchor` member (P14.21); the disclosure is checked on a log that has one.
    const withAnchor = structuredClone(entries) as LogEntry[];
    (withAnchor[0].state.asset as JsonObject).anchor = { chain: "eip155:4663", minter: "0x" + "ab".repeat(20) };
    const d = carriedDisclosure(withAnchor);
    expect(d.anchor).toEqual({ chain: "eip155:4663", minter: "0x" + "ab".repeat(20) });
    expect(d.text).toContain("eip155:4663");
    expect(d.text).toContain("0x" + "ab".repeat(20));
  });

  test("C12-230: \"Carried file presented by an SDK or UI\": never labelled an evidence package or complete", async () => {
    const { alice, entries } = await original([{ data: PNG, mediaType: "image/png" }]);
    const r = await readCarriedFile(await carry(PNG, entries), { authors: [alice.evidence()], now: NOW });
    expect(r.kind).toBe("carried-file");
    expect(r.completeness).toBe("no-claim");
    expect(r.statements[r.statements.length - 1]).toBe("A carried file is not an evidence package and makes no claim to be complete.");
    expect(JSON.stringify({ ...r, report: null, version: null })).not.toMatch(/evidence-package|"completeness":"complete"/);
    expect(carriedDisclosure(entries).text).toContain("not an evidence package");
  });

  test("C12-290: \"Writer asked to inscribe or publish a carried file as a body\": the carrier is removed first; the body is the version's bytes", async () => {
    const { entries } = await original([{ data: PNG, mediaType: "image/png" }]);
    const file = await carry(PNG, entries);
    expect(resourceDigest(file)).not.toBe(entries[0].state.asset && (entries[0].state.asset as JsonObject & { resource: ResourceDescriptor }).resource.digest);
    const body = removeCarrier(file);
    expect(same(body, PNG)).toBe(true);
    expect(same(removeCarrier(PNG), PNG)).toBe(true);
  });

  test("C12-291: \"Writer making a carried file from an accepted publication's body and entries\": allowed, as for any accepted checkpoint", async () => {
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

  test("C12-234: \"Anchored Original's carried log read without access to the anchor\": missing evidence; at most the entries before the anchoring entry; the anchoring entry and later not checked against the anchor", async () => {
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

  test("C12-233: \"Anchored Original whose carried log disagrees with its anchor\": state from the anchor; the carried log is not preferred", async () => {
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

  test("C12-317: \"Carried checkpoint from before the anchoring entry of an Original that is now anchored\": allowed; reported as a historical checkpoint, valid as of it, with no statement about current anchoring (P7.14, P7.15)", async () => {
    const { alice, genesis, renamed, anchor } = await anchored();
    // P7.15: the writer MAY carry it, with no anchor evidence.
    const file = await carry(bytes(B1), [genesis, renamed]);
    // Read with and without the anchor's evidence: the same historical checkpoint.
    for (const bitcoin of [undefined, [sat([inscribe([genesis, renamed, anchor], 10)])]]) {
      const r = await readCarriedFile(file, { authors: [alice.evidence()], now: NOW, ...(bitcoin ? { bitcoin } : {}) });
      expect(r.anchoring).toEqual({ status: "historical-checkpoint", notCheckedAgainstAnchor: [] });
      expect(r.verified).toEqual({ log: true, version: true });
      expect(r.overall).toEqual({ status: "verified", reason: null });
      expect(r.validAsOf?.checkpoint).toBe(renamed.versionId);
      expect(r.current).toBe(false);
      // No statement either way about anchoring since.
      expect(r.reasons).not.toContain("not-anchored");
      expect(r.reasons).not.toContain("bitcoin-evidence-missing");
      expect(r.report?.anchoring ?? null).toBeNull();
      expect(r.statements.join(" ")).toContain("makes no statement about whether the Original has been anchored since");
      expect(r.statements.join(" ")).not.toMatch(/is not anchored|anchored on Bitcoin/);
    }
  });

  test("C12-288: \"Carried log with an `anchor` member naming a chain the reader's revision does not list, or read while P14.21 pins no contract\": unsupported, not invalid; nothing verified", async () => {
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
