/**
 * `@originals/code/fs` (Node only): a workspace on disk.
 *
 *   <root>/originals/     the SDK's FileStore (durable commit, P6.2; one writer per root)
 *   <root>/objects/zQ/m…  objects, deflate-raw compressed (PROVISIONAL, K8)
 *   <root>/workspace.json { format, repo }
 *   <root>/identities/    public identities (DID logs) of signers, by hex sha256 of the DID
 *
 * An object is written to a temporary file, fsynced and renamed, before any
 * log that names it is committed, so a crash never leaves a committed entry
 * whose objects are absent. Objects are hashed when read, every time: a file
 * can change underneath the store (as `FileStore` treats resources).
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { FileStore } from "@originals/sdk/originals/fs";
import { codeError } from "./errors.js";
import { publicIdentity, type LocalIdentity } from "./identity.js";
import { checkObject, type ObjectStore } from "./store.js";
import { CodeWorkspace } from "./workspace.js";

const DIGEST = /^z[1-9A-HJ-NP-Za-km-z]{2,120}$/;

/** Objects as compressed files named by digest. */
export class FsObjectStore implements ObjectStore {
  private readonly made = new Set<string>();

  constructor(readonly root: string) {}

  private path(digest: string): { dir: string; file: string } {
    if (!DIGEST.test(digest)) codeError("invalid-evidence", "OBJECT_DIGEST", `${digest} is not an object digest`);
    const dir = join(this.root, digest.slice(0, 4));
    return { dir, file: join(dir, digest.slice(4)) };
  }

  async get(digest: string): Promise<Uint8Array | undefined> {
    const { file } = this.path(digest);
    let z: Buffer;
    try {
      z = await readFile(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
    const bytes = new Uint8Array(inflateRawSync(z, { maxOutputLength: 1024 * 1024 * 1024 }));
    await checkObject(digest, bytes);
    return bytes;
  }

  async has(digest: string): Promise<boolean> {
    try {
      await stat(this.path(digest).file);
      return true;
    } catch {
      return false;
    }
  }

  async put(digest: string, bytes: Uint8Array): Promise<void> {
    const { dir, file } = this.path(digest);
    if (await this.has(digest)) return;
    await checkObject(digest, bytes);
    if (!this.made.has(dir)) {
      await mkdir(dir, { recursive: true });
      this.made.add(dir);
    }
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await open(tmp, "wx");
    try {
      await handle.writeFile(deflateRawSync(bytes, { level: 6 }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
  }

  /** Object count and compressed bytes on disk. */
  async usage(): Promise<{ objects: number; bytes: number }> {
    let objects = 0;
    let bytes = 0;
    let dirs: string[];
    try {
      dirs = await readdir(this.root);
    } catch {
      return { objects, bytes };
    }
    for (const d of dirs) {
      for (const f of await readdir(join(this.root, d))) {
        if (f.endsWith(".tmp")) continue;
        objects++;
        bytes += (await stat(join(this.root, d, f))).size;
      }
    }
    return { objects, bytes };
  }
}

export const WORKSPACE_FORMAT = "originals-code-workspace/0.1";

export interface DiskWorkspace {
  workspace: CodeWorkspace;
  objects: FsObjectStore;
  /** The repo Original, once `init` has run. */
  repo: string | undefined;
  setRepo(repo: string): Promise<void>;
  /** Keep a signer's public identity, so later runs verify its entries. */
  rememberIdentity(identity: LocalIdentity): Promise<void>;
  close(): Promise<void>;
}

const idFile = (did: string) => `${createHash("sha256").update(did).digest("hex")}.json`;

/** Open (or create) a workspace directory. One process at a time holds it (the FileStore lock). */
export async function openWorkspace(root: string, options: { clock?: () => number } = {}): Promise<DiskWorkspace> {
  await mkdir(join(root, "identities"), { recursive: true });
  const originals = await FileStore.open(join(root, "originals"));
  const objects = new FsObjectStore(join(root, "objects"));
  const configPath = join(root, "workspace.json");
  let repo: string | undefined;
  try {
    const config = JSON.parse(await readFile(configPath, "utf8")) as { format?: string; repo?: string };
    if (config.format !== WORKSPACE_FORMAT) codeError("unsupported-profile", "WORKSPACE_FORMAT", `${configPath} is not an ${WORKSPACE_FORMAT} file`);
    repo = config.repo;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const identities: Array<{ did: string; log: string }> = [];
  for (const f of await readdir(join(root, "identities"))) {
    if (f.endsWith(".json")) identities.push(JSON.parse(await readFile(join(root, "identities", f), "utf8")) as { did: string; log: string });
  }
  const workspace = CodeWorkspace.create({ originals, objects, identities, ...(options.clock ? { clock: options.clock } : {}) });
  const disk: DiskWorkspace = {
    workspace,
    objects,
    repo,
    async setRepo(next: string) {
      disk.repo = next;
      await writeFile(configPath, `${JSON.stringify({ format: WORKSPACE_FORMAT, repo: next }, null, 2)}\n`);
    },
    async rememberIdentity(identity: LocalIdentity) {
      const pub = publicIdentity(identity);
      workspace.addIdentity(pub);
      await writeFile(join(root, "identities", idFile(pub.did)), `${JSON.stringify(pub)}\n`);
    },
    async close() {
      await originals.close();
    },
  };
  return disk;
}
