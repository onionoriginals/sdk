/**
 * Scoped grants (P5.28, P5.29, P14.23; originals-spec #66, owner decision of
 * 19 November 2026). A grant's `scope` narrows `resource: true`: a `paths`
 * scope over a media type's path view, an `items` scope over its item view.
 * A verifier that cannot check a scope reports it unchecked: never a pass.
 *
 * Section 12 rows C12-412 to C12-421 (table rows 315–324).
 */
import { describe, expect, test } from "bun:test";
import { canonicalize, type JsonObject } from "../src/json/index.js";
import { appendEntry, serializeLog, type EntrySigner, type LogEntry } from "../src/log/index.js";
import { OriginalsError } from "../src/errors.js";
import {
  CODE_TREE_FORMAT,
  CODE_TREE_MEDIA_TYPE,
  ITEM_LIST_MEDIA_TYPE,
  checkAsset,
  checkPathPattern,
  checkScope,
  createOriginal,
  matchPathPattern,
  parseBtcoAlias,
  resourceDigest,
  updateOriginal,
  verifyOriginal,
  type AuthorRef,
  type EditorGrant,
  type GrantScope,
  type OriginalsReport,
  type ResourceDescriptor,
  type SatEvidence,
  type SatInscription,
} from "../src/originals/index.js";
import { NOW, VhAuthor, bytes, carrying, photo, seeded } from "./helpers/originals.js";

const encoder = new TextEncoder();
/** Every object a test made, by digest. */
const objects = new Map<string, Uint8Array>();
const blob = (text: string) => {
  const b = bytes(text);
  const digest = resourceDigest(b);
  objects.set(digest, b);
  return digest;
};
type Node = string | { mode?: string; blob: string } | { [name: string]: Node };
/** A code tree from a nested object: a string is a file's text, an object a directory. */
function tree(spec: Record<string, Node>): { digest: string; bytes: Uint8Array } {
  const entries: Record<string, { mode: string; digest: string }> = {};
  for (const [name, node] of Object.entries(spec)) {
    if (typeof node === "string") entries[name] = { mode: "100644", digest: blob(node) };
    else if ("blob" in node && typeof node.blob === "string") entries[name] = { mode: (node.mode as string) ?? "100644", digest: blob(node.blob) };
    else entries[name] = { mode: "40000", digest: tree(node as Record<string, Node>).digest };
  }
  const b = encoder.encode(canonicalize({ entries, format: CODE_TREE_FORMAT } as unknown as JsonObject));
  const digest = resourceDigest(b);
  objects.set(digest, b);
  return { digest, bytes: b };
}
const root = (spec: Record<string, Node>): ResourceDescriptor => {
  const t = tree(spec);
  return { mediaType: CODE_TREE_MEDIA_TYPE, size: t.bytes.length, digest: t.digest };
};
const list = (items: Record<string, unknown>): ResourceDescriptor => {
  const b = encoder.encode(canonicalize({ items } as unknown as JsonObject));
  const digest = resourceDigest(b);
  objects.set(digest, b);
  return { mediaType: ITEM_LIST_MEDIA_TYPE, size: b.length, digest };
};

const R1 = { docs: { "guide.md": "guide v1", "a.md": "a" }, src: { "main.ts": "main v1" } };
const T1 = root(R1);
const T_DOCS = root({ ...R1, docs: { ...R1.docs, "guide.md": "guide v2" } });
const T_SRC = root({ ...R1, src: { "main.ts": "main v2" } });
const T_BOTH = root({ docs: { ...R1.docs, "guide.md": "guide v2" }, src: { "main.ts": "main v2" } });
const T_RENAME = root({ docs: { "guide.md": "guide v1" }, src: { "main.ts": "main v1", "a.md": "a" } });
const T_MODE = root({ ...R1, docs: { ...R1.docs, "guide.md": { mode: "100755", blob: "guide v1" } } });

const grant = (did: string, g: Partial<Omit<EditorGrant, "did">> = {}): EditorGrant => ({ did, name: false, metadata: false, resource: true, ...g });
const docs: GrantScope = { type: "paths", paths: ["docs/**"] };

interface Who { did: VhAuthor; ref: () => AuthorRef; sign: EntrySigner }
const who = async (seed: number): Promise<Who> => {
  const key = seeded(seed);
  const did = await VhAuthor.create([{ fragment: "orig", signer: key }]);
  return { did, ref: () => did.ref("orig"), sign: did.signer(key, "orig") };
};

const T0 = Date.parse("2026-10-18T12:00:00Z");
const time = (height: number, n = 0) => new Date(T0 + height * 600_000 - 60_000 + n * 1000).toISOString();

/** Alice's Original at `first`, granting Dana `scope`. */
async function scoped(first: ResourceDescriptor, scope: GrantScope, extra: Partial<Omit<EditorGrant, "did">> = {}) {
  const [alice, dana] = await Promise.all([who(21), who(41)]);
  const g = grant(dana.did.did, { scope, ...extra });
  const genesis = await createOriginal({ versionTime: time(1), name: "Repository", resource: first, editors: [g], author: alice.ref(), sign: alice.sign });
  const byDana = (resource: ResourceDescriptor, previous: LogEntry = genesis, extraChange: Partial<{ name: string }> = {}) =>
    updateOriginal(previous, { versionTime: time(2), resource, ...extraChange, editor: dana.ref(), sign: dana.sign });
  return { alice, dana, genesis, byDana };
}

const verify = (log: LogEntry[], who: Who[], extra: Partial<Parameters<typeof verifyOriginal>[0]> = {}): Promise<OriginalsReport> =>
  verifyOriginal({ log, authors: who.map((w) => w.did.evidence()), now: NOW, bytes: (d) => objects.get(d), ...extra });

function failedWith(r: OriginalsReport, index: number, code: string, category?: string) {
  expect(r.history.failure?.index, JSON.stringify(r.history.failure)).toBe(index);
  expect(r.history.failure?.code, JSON.stringify(r.history.failure)).toBe(code);
  if (category) expect(r.history.failure?.category).toBe(category);
  expect(r.validAsOf).toBeNull();
}

async function rejects(run: () => unknown, code: string) {
  let error: unknown;
  try {
    await run();
  } catch (e) {
    error = e;
  }
  expect(error, `expected ${code}`).toBeInstanceOf(OriginalsError);
  expect((error as OriginalsError).code, (error as Error).message).toBe(code);
}

/** Sign Dana's change after `previous`, bypassing the builder (which checks no scope). */
const forge = (previous: LogEntry, resource: ResourceDescriptor, editor: Who) =>
  appendEntry(previous, {
    versionTime: time(2, 1), parameters: {},
    state: { ...previous.state, operation: "update", editor: editor.ref() as unknown as JsonObject, asset: { ...(previous.state.asset as JsonObject), resource: resource as unknown as JsonObject }, transitions: [{ from: (previous.state.asset as { resource: ResourceDescriptor }).resource.digest, to: resource.digest }] },
    sign: editor.sign,
  });

describe("C12-412, C12-413, C12-414: a paths scope over the code tree's path view (P5.28, P5.29)", () => {
  test("C12-412: a change whose touched paths all match is accepted; one touching a path outside is rejected, naming it", async () => {
    const { alice, dana, genesis, byDana } = await scoped(T1, docs);
    const inside = await byDana(T_DOCS);
    const r = await verify([genesis, inside], [alice, dana]);
    expect(r.history.status, JSON.stringify(r.history.failure)).toBe("valid");
    expect(r.grants).toEqual([{ versionId: inside.versionId, editor: dana.did.did, source: "direct", scope: { type: "paths", status: "checked" } }]);
    // Only the changed subtree was read, beyond the two roots.
    expect(r.scopeObjects.missing).toEqual([]);
    const both = await forge(genesis, T_BOTH, dana);
    const s = await verify([genesis, both], [alice, dana]);
    failedWith(s, 1, "SCOPE_OUTSIDE", "outside-grant");
    expect(s.history.failure?.message).toContain("src/main.ts");
    expect(s.history.failure?.message).not.toContain("docs/guide.md");
  });

  test("C12-413: a rename from inside the scope to outside touches both paths and is rejected", async () => {
    const { alice, dana, genesis } = await scoped(T1, docs);
    const renamed = await forge(genesis, T_RENAME, dana);
    const r = await verify([genesis, renamed], [alice, dana]);
    failedWith(r, 1, "SCOPE_OUTSIDE", "outside-grant");
    expect(r.history.failure?.message).toContain("src/a.md");
    // With both directories in scope, the rename is allowed.
    const wide = await scoped(T1, { type: "paths", paths: ["docs/**", "src/*.md"] });
    const ok = await forge(wide.genesis, T_RENAME, wide.dana);
    expect((await verify([wide.genesis, ok], [wide.alice, wide.dana])).history.status).toBe("valid");
  });

  test("C12-414: a change of a file's mode alone touches its path", async () => {
    const { alice, dana, genesis } = await scoped(T1, { type: "paths", paths: ["src/**"] });
    const chmod = await forge(genesis, T_MODE, dana);
    const r = await verify([genesis, chmod], [alice, dana]);
    failedWith(r, 1, "SCOPE_OUTSIDE");
    expect(r.history.failure?.message).toContain("docs/guide.md");
  });
});

describe("C12-415: an items scope over an item view (P5.29)", () => {
  const L1 = list({ milk: { qty: 1 }, eggs: { qty: 12 } });
  const ADD = list({ milk: { qty: 1 }, eggs: { qty: 12 }, bread: { qty: 1 } });
  const EDIT = list({ milk: { qty: 2 }, eggs: { qty: 12 } });
  const REMOVE = list({ milk: { qty: 1 } });
  test("each operation is accepted when listed, rejected when not", async () => {
    for (const [after, op] of [[ADD, "add"], [EDIT, "edit"], [REMOVE, "remove"]] as const) {
      const allowed = await scoped(L1, { type: "items", ops: [op] });
      const r = await verify([allowed.genesis, await forge(allowed.genesis, after, allowed.dana)], [allowed.alice, allowed.dana]);
      expect(r.history.status, `${op}: ${JSON.stringify(r.history.failure)}`).toBe("valid");
      const others = (["add", "edit", "remove"] as const).filter((o) => o !== op);
      const refused = await scoped(L1, { type: "items", ops: [...others] });
      const s = await verify([refused.genesis, await forge(refused.genesis, after, refused.dana)], [refused.alice, refused.dana]);
      failedWith(s, 1, "SCOPE_OUTSIDE", "outside-grant");
      expect(s.history.failure?.message).toContain(op);
    }
  });
});

describe("C12-416, C12-417: an unchecked scope is incomplete, never a pass or a rejection (P5.28)", () => {
  test("C12-416: an unknown scope type, a media type with no view here, or missing objects: unchecked", async () => {
    const unknown = await scoped(T1, { type: "colours", palette: ["red"] } as unknown as GrantScope);
    const r = await verify([unknown.genesis, await forge(unknown.genesis, T_DOCS, unknown.dana)], [unknown.alice, unknown.dana]);
    expect(r.history.status).toBe("incomplete");
    failedWith(r, 1, "SCOPE_UNCHECKED", "incomplete-evidence");
    // A paths scope on a photo, whose media type has no path view.
    const onPhoto = await scoped(photo("one"), docs);
    const p = await verify([onPhoto.genesis, await forge(onPhoto.genesis, photo("two"), onPhoto.dana)], [onPhoto.alice, onPhoto.dana], { bytes: (d) => objects.get(d) ?? (d === photo("one").digest ? bytes("one") : d === photo("two").digest ? bytes("two") : undefined) });
    failedWith(p, 1, "SCOPE_UNCHECKED", "incomplete-evidence");
    // A verifier that implements no path view at all.
    const plain = await scoped(T1, docs);
    const change = await forge(plain.genesis, T_DOCS, plain.dana);
    failedWith(await verify([plain.genesis, change], [plain.alice, plain.dana], { scopeViews: {} }), 1, "SCOPE_UNCHECKED");
    // The changed docs subtree is not held: unchecked, and the report lists what is missing.
    const docsTree = (JSON.parse(new TextDecoder().decode(objects.get(T_DOCS.digest)!)) as { entries: { docs: { digest: string } } }).entries.docs.digest;
    const m = await verify([plain.genesis, change], [plain.alice, plain.dana], { bytes: (d) => (d === docsTree ? undefined : objects.get(d)) });
    failedWith(m, 1, "SCOPE_UNCHECKED", "incomplete-evidence");
    expect(m.scopeObjects.missing).toEqual([docsTree]);
    // The version's own bytes missing, likewise.
    failedWith(await verify([plain.genesis, change], [plain.alice, plain.dana], { bytes: (d) => (d === T_DOCS.digest ? undefined : objects.get(d)) }), 1, "SCOPE_UNCHECKED");
  });

  test("C12-417: an entry inscribed after the anchor whose scope is unchecked is unverifiable", async () => {
    const SAT = "did:btco:reg:5000000030";
    const { alice, dana, genesis } = await scoped(T1, docs);
    const anchor = await updateOriginal(genesis, { versionTime: time(9), aliases: [SAT], author: alice.ref(), sign: alice.sign });
    const change = await updateOriginal(anchor, { versionTime: time(19), resource: T_DOCS, editor: dana.ref(), sign: dana.sign });
    const { sat, network } = parseBtcoAlias(SAT);
    let n = 0;
    const at = (entries: LogEntry | LogEntry[], height: number): SatInscription => ({
      sat, network, id: `${(n++).toString(16).padStart(64, "f")}i0`, height, transactionIndex: 1, inscriptionIndex: 0, confirmations: 120 - height, inscriptionTime: T0 + height * 600_000, ...carrying(entries),
      ...(() => {
        // The body is the version the last entry names (P9.17): a code tree, which `carrying` does not know.
        const last = Array.isArray(entries) ? entries[entries.length - 1] : entries;
        const d = (last.state.asset as unknown as { resource: ResourceDescriptor }).resource;
        return { mediaType: d.mediaType, content: objects.get(d.digest)! };
      })(),
    });
    const read: SatEvidence = { sat: SAT, index: "ord-a", tip: { height: 119, hash: "bb".repeat(32) }, inscriptions: [at([genesis, anchor], 10), at(change, 20)], owner: { output: `${"cc".repeat(32)}:1`, confirmations: 3 } };
    const r = await verify([genesis, anchor], [alice, dana], { bitcoin: [read], scopeViews: {} });
    expect(r.anchoring?.status).toBe("anchored");
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.unverifiable.map((u) => u.versionId)).toEqual([change.versionId]);
    // With the path view, it is checked and accepted.
    const s = await verify([genesis, anchor], [alice, dana], { bitcoin: [read] });
    expect(s.head).toBe(change.versionId);
    expect(s.current).toBe(true);
  });
});

describe("C12-418, C12-419: what a scope applies to (P5.28)", () => {
  test("C12-418: a grant with a scope and resource: false is rejected", async () => {
    const base = { name: "R", status: "active", resource: T1, aliases: [] };
    await rejects(() => checkAsset({ ...base, editors: [grant("did:vh:QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DzA3a1Y", { resource: false, metadata: true, scope: docs })] }), "STATE_EDITORS");
    expect(checkAsset({ ...base, editors: [grant("did:vh:QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DzA3a1Y", { scope: docs })] }).editors?.[0].scope).toEqual(docs);
  });

  test("C12-419: an editor entry under a scoped grant that changes only the name or metadata is not checked against the scope", async () => {
    const { alice, dana, genesis } = await scoped(T1, docs, { name: true, metadata: true });
    const renamed = await updateOriginal(genesis, { versionTime: time(2), name: "Repository, renamed", metadata: { topic: "docs" }, editor: dana.ref(), sign: dana.sign });
    // No objects at all: nothing needs reading.
    const r = await verify([genesis, renamed], [alice, dana], { bytes: () => undefined });
    expect(r.history.status, JSON.stringify(r.history.failure)).toBe("valid");
    expect(r.grants[0].scope).toEqual({ type: "paths", status: "not-required" });
    expect(r.scopeObjects).toEqual({ read: [], missing: [] });
  });
});

describe("C12-420, C12-421: scope syntax and pattern matching (P14.23)", () => {
  test("C12-420: malformed paths and items scopes are rejected; a scope of an unknown type is not", async () => {
    const bad: unknown[] = [
      { type: "paths", paths: [] },
      { type: "paths", paths: Array.from({ length: 65 }, (_, i) => `p${String(i).padStart(2, "0")}`) },
      { type: "paths", paths: ["src/**", "docs/**"] },
      { type: "paths", paths: ["docs/**", "docs/**"] },
      { type: "paths", paths: ["/docs"] },
      { type: "paths", paths: ["docs/"] },
      { type: "paths", paths: ["docs//a"] },
      { type: "paths", paths: ["./docs"] },
      { type: "paths", paths: ["docs/../src"] },
      { type: "paths", paths: ["a**"] },
      { type: "paths", paths: ["***"] },
      { type: "paths", paths: ["docs/**"], extra: true },
      { type: "items", ops: [] },
      { type: "items", ops: ["append"] },
      { type: "items", ops: ["remove", "add"] },
      { type: "items", ops: ["add", "add"] },
      { type: "items" },
      { paths: ["docs/**"] },
    ];
    for (const scope of bad) {
      let error: unknown;
      try {
        checkScope(scope);
      } catch (e) {
        error = e;
      }
      expect(error, JSON.stringify(scope)).toBeInstanceOf(OriginalsError);
    }
    for (const ok of [{ type: "paths", paths: ["*.md", "docs/**", "src/a?[b]\\c"] }, { type: "items", ops: ["add", "edit", "remove"] }, { type: "colours", anything: [1] }]) {
      expect(checkScope(ok)).toEqual(ok as GrantScope);
    }
    expect(Array.from({ length: 64 }, (_, i) => `p${String(i).padStart(2, "0")}`).length).toBe(64);
    expect(() => checkScope({ type: "paths", paths: Array.from({ length: 64 }, (_, i) => `p${String(i).padStart(2, "0")}`) })).not.toThrow();
  });

  test("C12-421: docs/** against docs, docs/a and docs/a/b; *.md against a.md and d/a.md", () => {
    expect(["docs", "docs/a", "docs/a/b"].map((p) => matchPathPattern("docs/**", p))).toEqual([false, true, true]);
    expect(["a.md", "d/a.md"].map((p) => matchPathPattern("*.md", p))).toEqual([true, false]);
    // `?`, `[` and `\` match themselves; a middle `**` matches zero or more segments.
    expect(matchPathPattern("a?[b]", "a?[b]")).toBe(true);
    expect(matchPathPattern("a?", "ab")).toBe(false);
    expect(matchPathPattern("src/**/x.ts", "src/x.ts")).toBe(true);
    expect(matchPathPattern("src/**/x.ts", "src/a/b/x.ts")).toBe(true);
    expect(() => checkPathPattern("a/**b")).toThrow();
  });
});

void serializeLog;
