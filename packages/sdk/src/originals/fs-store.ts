/**
 * A file-system store (Node only; `@originals/sdk/originals/fs`).
 *
 *   <root>/originals/<scid>/did.jsonl   the committed log
 *   <root>/resources/<digest>           content-addressed bytes
 *   <root>/originals/<scid>/branches/<sha256(log)>.jsonl
 *                                       valid branches that diverge from it
 *   <root>/authors/<sha256(did)>.json   author DID evidence from imports
 *   <root>/retained/<sha256(did)>.json  the highest versionId verified per DID
 *
 * Every write goes to a temporary file that is fsynced and then renamed over
 * its target, and the directory is fsynced after the rename, so a commit is
 * either fully visible or not at all (P6.2). Temporary files left by a crash
 * are removed when the store is opened. One process may write a store at a
 * time; commits within that process are serialized per Original.
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
  beforeRename?: () => void;
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
  private readonly locks = new Map<string, Promise<void>>();

  private constructor(
    private readonly root: string,
    private readonly faults: FileStoreFaults = {},
  ) {}

  static async open(root: string, faults?: FileStoreFaults): Promise<FileStore> {
    await loadNode();
    const { mkdir, readdir, rm } = fs;
    await mkdir(join(root, "originals"), { recursive: true });
    await mkdir(join(root, "resources"), { recursive: true });
    await mkdir(join(root, "authors"), { recursive: true });
    await mkdir(join(root, "retained"), { recursive: true });
    for (const scid of await readdir(join(root, "originals"))) {
      for (const name of await readdir(join(root, "originals", scid))) {
        if (name.endsWith(".tmp")) await rm(join(root, "originals", scid, name), { force: true });
      }
      const branches = join(root, "originals", scid, "branches");
      for (const name of await readdir(branches).catch(() => [] as string[])) {
        if (name.endsWith(".tmp")) await rm(join(branches, name), { force: true });
      }
    }
    for (const dir of ["resources", "authors", "retained"]) {
      for (const name of await readdir(join(root, dir))) {
        if (name.endsWith(".tmp")) await rm(join(root, dir, name), { force: true });
      }
    }
    return new FileStore(root, faults);
  }

  private dirOf(did: string): string {
    const match = DID_VH.exec(did);
    if (!match) throw new OriginalsError("invalid-evidence", "STORE_DID_INVALID", `${did} is not a did:vh`);
    return join(this.root, "originals", match[1]);
  }

  private async writeAtomically(dir: string, name: string, data: Uint8Array | string): Promise<void> {
    const tmp = join(dir, `${name}.${randomHex(6)}.tmp`);
    const handle = await fs.open(tmp, "wx");
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (name === "did.jsonl") this.faults.beforeRename?.();
    await fs.rename(tmp, join(dir, name));
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
