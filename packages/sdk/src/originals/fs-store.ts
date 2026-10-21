/**
 * A file-system store (Node only; `@originals/sdk/originals/fs`).
 *
 *   <root>/originals/<scid>/did.jsonl   the committed log
 *   <root>/originals/<scid>/branches/<sha256(log)>.jsonl
 *                                       valid branches that diverge from it
 *   <root>/resources/<digest>           content-addressed bytes
 *   <root>/authors/<sha256(did)>.json   author DID evidence from imports
 *   <root>/retained/<sha256(did)>.json  the highest versionId verified per DID
 *
 * Every write goes to a temporary file that is fsynced and then renamed over
 * its target, and the directory is fsynced after the rename, so a commit is
 * either fully visible or not at all (P6.2).
 *
 * One process writes a root at a time: opening it takes `<root>/.lock`
 * (holding the process id), and opening a root that a live process holds is
 * refused (STORE_LOCKED); a lock left by a process that no longer runs is
 * taken over. Every handle on one root in a process shares one set of locks,
 * so commits are serialized per Original across handles, and opening a root
 * removes only temporary files that no handle in the process is writing:
 * those left by a crash (08b review C5).
 *
 * The lock file is PROVISIONAL and advisory: it guards against two SDK
 * processes, not against other programs writing the directory.
 *
 * Node modules are loaded lazily, so importing this entry is safe anywhere;
 * opening a store needs Node.
 */
import { OriginalsError } from "@originals/vh";
import { sha256 } from "@originals/vh/crypto";
import type { AuthorDidEvidence } from "@originals/vh/originals";
import { hex } from "@scure/base";
import { headOf, higherVersion, staleHead, type CommitUpdate, type OriginalsStore, type StoredOriginal } from "./store.js";

export interface FileStoreFaults {
  /** Called after the new log is durably written, before it replaces the old one. */
  beforeRename?: () => void | Promise<void>;
}

/** What every handle on one root in this process shares. */
interface RootState {
  locks: Map<string, Promise<void>>;
  /** Temporary files being written now. */
  writing: Set<string>;
}

const roots = new Map<string, RootState>();

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Take `<root>/.lock` for this process, or refuse when a live process holds it. */
async function takeLock(root: string): Promise<void> {
  const path = join(root, ".lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(path, String(process.pid), { flag: "wx" });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = Number((await fs.readFile(path, "utf8").catch(() => "")).trim());
    if (holder === process.pid) return;
    if (alive(holder)) {
      throw new OriginalsError("unavailable-bytes", "STORE_LOCKED", `${root} is in use by process ${holder}; one process writes a store at a time`, { root, pid: holder });
    }
    await fs.rm(path, { force: true }); // stale: its process no longer runs
  }
  throw new OriginalsError("unavailable-bytes", "STORE_LOCKED", `${root} is being opened by another process`, { root });
}

const DID_VH = /^did:vh:([1-9A-HJ-NP-Za-km-z]{46})$/;
const DIGEST = /^z[1-9A-HJ-NP-Za-km-z]{1,120}$/;

type Fs = typeof import("node:fs/promises");
let fs: Fs;
let randomHex: (bytes: number) => string;
const join = (...parts: string[]) => parts.join("/");
const hashHex = (text: string) => hex.encode(sha256(new TextEncoder().encode(text)));

async function loadNode(): Promise<void> {
  fs ??= await import("node:fs/promises");
  if (!randomHex) {
    const { randomBytes } = await import("node:crypto");
    randomHex = (n) => randomBytes(n).toString("hex");
  }
}

async function fsyncDir(dir: string): Promise<void> {
  const handle = await fs.open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class FileStore implements OriginalsStore {
  private readonly locks: Map<string, Promise<void>>;
  private readonly writing: Set<string>;

  private constructor(
    private readonly root: string,
    shared: RootState,
    private readonly faults: FileStoreFaults = {},
  ) {
    this.locks = shared.locks;
    this.writing = shared.writing;
  }

  static async open(root: string, faults?: FileStoreFaults): Promise<FileStore> {
    await loadNode();
    const { mkdir, readdir, realpath, rm } = fs;
    await mkdir(join(root, "originals"), { recursive: true });
    await mkdir(join(root, "resources"), { recursive: true });
    await mkdir(join(root, "authors"), { recursive: true });
    await mkdir(join(root, "retained"), { recursive: true });
    const key = await realpath(root);
    let shared = roots.get(key);
    if (!shared) {
      await takeLock(root);
      shared = roots.get(key) ?? { locks: new Map(), writing: new Set() };
      roots.set(key, shared);
    }
    const { writing } = shared;
    // Only a crash's leftovers: a temporary file a handle in this process is writing stays.
    const sweep = async (dir: string, names: string[]) => {
      for (const name of names) {
        const path = join(dir, name);
        if (name.endsWith(".tmp") && !writing.has(path)) await rm(path, { force: true });
      }
    };
    for (const scid of await readdir(join(root, "originals"))) {
      await sweep(join(root, "originals", scid), await readdir(join(root, "originals", scid)));
      const branches = join(root, "originals", scid, "branches");
      await sweep(branches, await readdir(branches).catch(() => [] as string[]));
    }
    for (const dir of ["resources", "authors", "retained"]) await sweep(join(root, dir), await readdir(join(root, dir)));
    return new FileStore(root, shared, faults);
  }

  private dirOf(did: string): string {
    const match = DID_VH.exec(did);
    if (!match) throw new OriginalsError("invalid-evidence", "STORE_DID_INVALID", `${did} is not a did:vh`);
    return join(this.root, "originals", match[1]);
  }

  private async writeAtomically(dir: string, name: string, data: Uint8Array | string): Promise<void> {
    const tmp = join(dir, `${name}.${randomHex(6)}.tmp`);
    this.writing.add(tmp);
    try {
      const handle = await fs.open(tmp, "wx");
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (name === "did.jsonl") await this.faults.beforeRename?.();
      await fs.rename(tmp, join(dir, name));
    } finally {
      this.writing.delete(tmp);
    }
    await fsyncDir(dir);
  }

  async get(did: string): Promise<StoredOriginal | undefined> {
    try {
      return { log: await fs.readFile(join(this.dirOf(did), "did.jsonl"), "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async commit(did: string, update: CommitUpdate): Promise<void> {
    const previous = this.locks.get(did) ?? Promise.resolve();
    const run = previous.then(async () => {
      const dir = this.dirOf(did);
      await fs.mkdir(dir, { recursive: true });
      const current = headOf((await this.get(did))?.log);
      if (current !== update.expectedHead) throw staleHead(did, update.expectedHead, current);
      await this.writeAtomically(dir, "did.jsonl", update.log);
    });
    this.locks.set(did, run.catch(() => undefined));
    return run;
  }

  async putResource(digest: string, bytes: Uint8Array): Promise<void> {
    if (!DIGEST.test(digest)) throw new OriginalsError("invalid-evidence", "STORE_DIGEST_INVALID", `${digest} is not a digest`);
    if ((await this.getResource(digest)) !== undefined) return;
    await this.writeAtomically(join(this.root, "resources"), digest, bytes);
  }

  async getResource(digest: string): Promise<Uint8Array | undefined> {
    if (!DIGEST.test(digest)) return undefined;
    try {
      return new Uint8Array(await fs.readFile(join(this.root, "resources", digest)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private didFile(did: string): string {
    return `${hashHex(did)}.json`;
  }

  private async readText(path: string): Promise<string | undefined> {
    try {
      return await fs.readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async putAuthorEvidence(evidence: AuthorDidEvidence): Promise<void> {
    await this.writeAtomically(join(this.root, "authors"), this.didFile(evidence.did), JSON.stringify(evidence));
  }

  async getAuthorEvidence(did: string): Promise<AuthorDidEvidence | undefined> {
    try {
      const evidence = JSON.parse(await fs.readFile(join(this.root, "authors", this.didFile(did)), "utf8")) as AuthorDidEvidence;
      return evidence.did === did ? evidence : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async getRetained(did: string): Promise<string | undefined> {
    const text = await this.readText(join(this.root, "retained", this.didFile(did)));
    if (text === undefined) return undefined;
    const record = JSON.parse(text) as { did?: unknown; versionId?: unknown };
    return record.did === did && typeof record.versionId === "string" ? record.versionId : undefined;
  }

  async putRetained(did: string, versionId: string): Promise<void> {
    // Serialized per DID and never lowered, so a concurrent read cannot undo a newer retain (P7.8).
    const key = `retained:${did}`;
    const run = (this.locks.get(key) ?? Promise.resolve()).then(async () => {
      const higher = higherVersion(await this.getRetained(did), versionId);
      await this.writeAtomically(join(this.root, "retained"), this.didFile(did), JSON.stringify({ did, versionId: higher }));
    });
    this.locks.set(key, run.catch(() => undefined));
    return run;
  }

  async putBranch(did: string, log: string): Promise<void> {
    const dir = join(this.dirOf(did), "branches");
    await fs.mkdir(dir, { recursive: true });
    const name = `${hashHex(log)}.jsonl`;
    if ((await this.readText(join(dir, name))) === undefined) await this.writeAtomically(dir, name, log);
  }

  async getBranches(did: string): Promise<string[]> {
    const dir = join(this.dirOf(did), "branches");
    const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".jsonl")).sort();
    const out: string[] = [];
    for (const name of names) {
      const log = await this.readText(join(dir, name));
      if (log !== undefined) out.push(log);
    }
    return out;
  }

  async list(): Promise<string[]> {
    return (await fs.readdir(join(this.root, "originals"))).map((scid) => `did:vh:${scid}`);
  }
}
