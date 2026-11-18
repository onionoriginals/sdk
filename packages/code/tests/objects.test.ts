/**
 * Objects and trees (plan 049 §1.1, K2). Digests are the Originals resource
 * digest over exact bytes (P4.3, P14.7).
 */
import { describe, expect, test } from "bun:test";
import { resourceDigest } from "@originals/vh/originals";
import {
  MemoryObjectStore,
  TREE_FORMAT,
  decodeTree,
  diffTrees,
  encodeTree,
  flattenTree,
  gitBlobId,
  gitTreeIdOf,
  putTree,
  type Tree,
} from "../src/index.js";

const enc = new TextEncoder();
const blob = (s: string) => enc.encode(s);

async function storeWith(files: Record<string, string>, store = new MemoryObjectStore()) {
  // Build nested trees from a flat path map.
  type Dir = { [name: string]: Dir | string };
  const root: Dir = {};
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split("/");
    let dir = root;
    for (const p of parts.slice(0, -1)) dir = (dir[p] ??= {}) as Dir;
    dir[parts[parts.length - 1]] = content;
  }
  async function write(dir: Dir): Promise<string> {
    const entries: Tree["entries"] = {};
    for (const [name, value] of Object.entries(dir)) {
      if (typeof value === "string") {
        const bytes = blob(value);
        const digest = resourceDigest(bytes);
        await store.put(digest, bytes);
        entries[name] = { mode: "100644", digest };
      } else {
        entries[name] = { mode: "40000", digest: await write(value) };
      }
    }
    return putTree(store, { entries });
  }
  return { store, root: await write(root) };
}

describe("CODE-01 tree encoding", () => {
  test("round-trips as JCS bytes with the format member", () => {
    const d = resourceDigest(blob("x"));
    const tree: Tree = { entries: { "b.txt": { mode: "100644", digest: d }, "a.sh": { mode: "100755", digest: d } } };
    const bytes = encodeTree(tree);
    const text = new TextDecoder().decode(bytes);
    expect(text).toBe(`{"entries":{"a.sh":{"digest":"${d}","mode":"100755"},"b.txt":{"digest":"${d}","mode":"100644"}},"format":"${TREE_FORMAT}"}`);
    expect(decodeTree(bytes)).toEqual(tree);
  });

  test("rejects bytes that are not the JCS form of their parse", () => {
    const d = resourceDigest(blob("x"));
    const spaced = blob(`{ "entries": {"a": {"digest": "${d}", "mode": "100644"}}, "format": "${TREE_FORMAT}"}`);
    expect(() => decodeTree(spaced)).toThrow(expect.objectContaining({ code: "TREE_NOT_CANONICAL" }));
  });

  test.each([
    ["", "TREE_NAME"],
    [".", "TREE_NAME"],
    ["..", "TREE_NAME"],
    ["a/b", "TREE_NAME"],
    ["a\u0000b", "TREE_NAME"],
    [".git", "TREE_NAME"],
    [".GIT", "TREE_NAME"],
  ])("rejects the name %j", (name, code) => {
    const d = resourceDigest(blob("x"));
    expect(() => encodeTree({ entries: { [name]: { mode: "100644", digest: d } } })).toThrow(expect.objectContaining({ code }));
  });

  test.each(["160000", "100664", "040000", "644"])("rejects mode %s (gitlinks and non-canonical modes, K9)", (mode) => {
    const d = resourceDigest(blob("x"));
    expect(() => encodeTree({ entries: { a: { mode: mode as "100644", digest: d } } })).toThrow(expect.objectContaining({ code: mode === "160000" ? "GITLINK_UNSUPPORTED" : "TREE_MODE" }));
  });

  test("rejects extra members, a missing format and a bad digest", () => {
    const d = resourceDigest(blob("x"));
    expect(() => decodeTree(blob(`{"entries":{},"extra":1,"format":"${TREE_FORMAT}"}`))).toThrow(expect.objectContaining({ code: "TREE_MEMBERS" }));
    expect(() => decodeTree(blob(`{"entries":{}}`))).toThrow(expect.objectContaining({ code: "TREE_MEMBERS" }));
    expect(() => decodeTree(blob(`{"entries":{"a":{"digest":"${d}","mode":"100644","size":1}},"format":"${TREE_FORMAT}"}`))).toThrow(expect.objectContaining({ code: "TREE_MEMBERS" }));
    expect(() => decodeTree(blob(`{"entries":{"a":{"digest":"zNope","mode":"100644"}},"format":"${TREE_FORMAT}"}`))).toThrow();
    expect(() => decodeTree(blob(`{"entries":{},"format":"other/1"}`))).toThrow(expect.objectContaining({ code: "TREE_FORMAT" }));
  });
});

describe("CODE-02 content-addressed objects", () => {
  test("a blob shared by two trees is stored once", async () => {
    const store = new MemoryObjectStore();
    await storeWith({ "a/x.txt": "same", "b.txt": "one" }, store);
    const before = store.size;
    await storeWith({ "a/x.txt": "same", "b.txt": "two" }, store);
    // New: blob "two" and the new root; "a" subtree and "same" are shared.
    expect(store.size - before).toBe(2);
  });

  test("put refuses bytes that do not match their digest (P4.3)", async () => {
    const store = new MemoryObjectStore();
    await expect(store.put(resourceDigest(blob("a")), blob("b"))).rejects.toMatchObject({ code: "OBJECT_DIGEST_MISMATCH" });
  });

  test("flatten gives the path → {mode, digest} view", async () => {
    const { store, root } = await storeWith({ "a/x.txt": "1", "a/b/y.txt": "2", "z": "3" });
    const flat = await flattenTree(root, (d) => store.get(d));
    expect([...flat.keys()]).toEqual(["a/b/y.txt", "a/x.txt", "z"]);
    expect(flat.get("z")).toEqual({ mode: "100644", digest: resourceDigest(blob("3")) });
  });

  test("diff lists touched paths and skips unchanged subtrees", async () => {
    const store = new MemoryObjectStore();
    const one = await storeWith({ "a/x.txt": "1", "keep/k": "k", "f": "file", "gone.txt": "g" }, store);
    const two = await storeWith({ "a/x.txt": "2", "keep/k": "k", "f/inner.txt": "now a dir", "new.txt": "n" }, store);
    const reads: string[] = [];
    const paths = await diffTrees(one.root, two.root, async (d) => {
      reads.push(d);
      return store.get(d);
    });
    expect(paths).toEqual(["a/x.txt", "f", "f/inner.txt", "gone.txt", "new.txt"]);
    const keep = decodeTree((await store.get(one.root))!).entries.keep.digest;
    expect(reads).not.toContain(keep);
    expect(await diffTrees(null, one.root, (d) => store.get(d))).toEqual(["a/x.txt", "f", "gone.txt", "keep/k"]);
  });

  test("git ids: blob and tree SHA-1 match git's", async () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobId(blob("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    // A tree with that blob as `hello.txt` (git mktree): 'aaa96ced2d9a1c8e72c56b253a0e2fe78393feb7'.
    const store = new MemoryObjectStore();
    const d = resourceDigest(blob("hello\n"));
    await store.put(d, blob("hello\n"));
    const root = await putTree(store, { entries: { "hello.txt": { mode: "100644", digest: d } } });
    expect(await gitTreeIdOf(root, (x) => store.get(x))).toBe("aaa96ced2d9a1c8e72c56b253a0e2fe78393feb7");
  });

  test("git tree order sorts a directory as if its name ended in '/'", async () => {
    const store = new MemoryObjectStore();
    const d = resourceDigest(blob("x"));
    await store.put(d, blob("x"));
    const sub = await putTree(store, { entries: { x: { mode: "100644", digest: d } } });
    // git sorts the tree "a" as "a/", after "a-b" and "a.c" ('-' and '.' are below '/'); id from `git mktree`.
    const root = await putTree(store, { entries: { a: { mode: "40000", digest: sub }, "a-b": { mode: "100644", digest: d }, "a.c": { mode: "100644", digest: d } } });
    expect(await gitTreeIdOf(root, (x) => store.get(x))).toBe("e667bb32c016f617f5e0616a30f4ee6474dc4f51");
  });
});
