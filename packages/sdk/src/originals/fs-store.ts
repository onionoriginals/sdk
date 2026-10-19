/**
 * A file-system store (Node only; `@originals/sdk/originals/fs`).
 *
 *   <root>/originals/<scid>/did.jsonl   the committed log
 *   <root>/originals/<scid>/did-witness.json
 *                                       its witness proofs, written before the log
 *   <root>/originals/<scid>/branches/<sha256(log)>.jsonl (and .witness.json)
 *                                       valid branches that diverge from it
 *   <root>/resources/<digest>           content-addressed bytes
 *   <root>/authors/<sha256(did)>.json   author DID evidence from imports
 *   <root>/retained/<sha256(did)>.json  the highest versionId verified per DID
 *
 * Every write goes to a temporary file that is fsynced and then renamed over
 * its target, and the directory is fsynced after the rename, so a commit is
 * either fully visible or not at all (P6.2). Temporary files left by a crash
 * are removed when the store is opened. One process may write a store at a
 * time; commits within that process are serialized per Original.
 *
 * `FileWitnessLedger` keeps a witness's last approval per Original in the same
 * way: <dir>/<sha256(original)>.json, replaced atomically before the witness
 * returns a proof (P9.8).
 *
 * Node modules are loaded lazily, so importing this entry is safe anywhere;
 * opening a store needs Node.
 */
import { OriginalsError } from "@originals/vh";
import { sha256 } from "@originals/vh/crypto";
import type { AuthorDidEvidence } from "@originals/vh/originals";
import { hex } from "@scure/base";
import { headOf, staleHead, type CommitUpdate, type OriginalsStore, type StoredOriginal } from "./store.js";
import type { WitnessLedger } from "./witness.js";

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
    const dir = this.dirOf(did);
    const log = await this.readText(join(dir, "did.jsonl"));
    if (log === undefined) return undefined;
    // The witness file may hold proofs for a newer log than the one committed; unknown versionIds are ignored.
    const witness = await this.readText(join(dir, "did-witness.json"));
    return { log, ...(witness !== undefined ? { witness: JSON.parse(witness) as unknown } : {}) };
  }

  async commit(did: string, update: CommitUpdate): Promise<void> {
    const previous = this.locks.get(did) ?? Promise.resolve();
    const run = previous.then(async () => {
      const dir = this.dirOf(did);
      await fs.mkdir(dir, { recursive: true });
      const current = headOf((await this.get(did))?.log);
      if (current !== update.expectedHead) throw staleHead(did, update.expectedHead, current);
      if (update.witness !== undefined) await this.writeAtomically(dir, "did-witness.json", JSON.stringify(update.witness));
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
    await this.writeAtomically(join(this.root, "retained"), this.didFile(did), JSON.stringify({ did, versionId }));
  }

  async putBranch(did: string, branch: StoredOriginal): Promise<void> {
    const dir = join(this.dirOf(did), "branches");
    await fs.mkdir(dir, { recursive: true });
    const name = hashHex(branch.log);
    if (branch.witness !== undefined) await this.writeAtomically(dir, `${name}.witness.json`, JSON.stringify(branch.witness));
    await this.writeAtomically(dir, `${name}.jsonl`, branch.log);
  }

  async getBranches(did: string): Promise<StoredOriginal[]> {
    const dir = join(this.dirOf(did), "branches");
    const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".jsonl")).sort();
    const out: StoredOriginal[] = [];
    for (const name of names) {
      const log = await this.readText(join(dir, name));
      const witness = await this.readText(join(dir, name.replace(/\.jsonl$/, ".witness.json")));
      if (log !== undefined) out.push({ log, ...(witness !== undefined ? { witness: JSON.parse(witness) as unknown } : {}) });
    }
    return out;
  }

  async list(): Promise<string[]> {
    return (await fs.readdir(join(this.root, "originals"))).map((scid) => `did:vh:${scid}`);
  }
}

/** A durable `WitnessLedger` for a deployed witness (Node only). */
export class FileWitnessLedger implements WitnessLedger {
  private constructor(private readonly dir: string) {}

  static async open(dir: string): Promise<FileWitnessLedger> {
    await loadNode();
    await fs.mkdir(dir, { recursive: true });
    for (const name of await fs.readdir(dir)) if (name.endsWith(".tmp")) await fs.rm(join(dir, name), { force: true });
    return new FileWitnessLedger(dir);
  }

  private file(original: string): string {
    return join(this.dir, `${hashHex(original)}.json`);
  }

  async get(original: string): Promise<string[] | undefined> {
    try {
      const record = JSON.parse(await fs.readFile(this.file(original), "utf8")) as { original?: unknown; versionIds?: unknown };
      return record.original === original && Array.isArray(record.versionIds) ? (record.versionIds as string[]) : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async put(original: string, versionIds: string[]): Promise<void> {
    const tmp = `${this.file(original)}.${randomHex(6)}.tmp`;
    const handle = await fs.open(tmp, "wx");
    try {
      await handle.writeFile(JSON.stringify({ original, versionIds }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, this.file(original));
    await fsyncDir(this.dir);
  }
}
