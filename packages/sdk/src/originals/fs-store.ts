/**
 * A file-system store (Node only; `@originals/sdk/originals/fs`).
 *
 *   <root>/originals/<scid>/did.jsonl   the committed log
 *   <root>/originals/<scid>/branches/<sha256(log)>.jsonl
 *                                       valid branches that diverge from it
 *   <root>/originals/<scid>/refused/<sha256(versionId)>.json
 *                                       refused candidates, never history (P6.8)
 *   <root>/resources/<digest>           content-addressed bytes
 *   <root>/authors/<sha256(did)>.json   author DID evidence from imports
 *   <root>/retained/<sha256(did)>.json  the highest versionId verified per DID
 *
 * Every write goes to a temporary file that is fsynced and then renamed over
 * its target, and the directory is fsynced after the rename, so a commit is
 * either fully visible or not at all (P6.2).
 *
 * One process writes a root at a time: opening it takes `<root>/.lock`, and
 * opening a root that another live process holds is refused (STORE_LOCKED).
 * Every handle on one root in a process shares one set of locks, so commits
 * are serialized per Original across handles, and opening a root removes only
 * temporary files that no handle in the process is writing: those left by a
 * crash (08b review C5). `close()` on the last handle waits for every write in
 * flight on the root, then releases the lock; an `open()` that arrives while
 * the root is closing waits for the release and takes the lock afresh.
 *
 * The lock (PROVISIONAL, advisory: it guards against two SDK processes, not
 * against other programs writing the directory) holds a JSON record
 * `{pid, host, token, start}`; `token` is random per acquisition. It is never
 * absent while held, and never replaced while its holder may still run:
 *
 * - Taking a free root: write the record to `.lock.<pid>.<token>.new`, then
 *   `link()` it to `.lock`. `link` fails if `.lock` exists, so exactly one
 *   process wins.
 * - Taking over a stale lock: the record is stale only when its holder is on
 *   this host and is confirmed not to run (no such pid; or, on Linux, the
 *   pid's start time differs from the record's, so the pid was reused). A
 *   record under this process's own pid is held unless its start time proves
 *   an earlier process instance: worker threads share the pid but not the
 *   handles, so a token this thread does not know may be another thread's
 *   (08b review r4 #1). The taker claims the break with an exclusive
 *   `.lock.break.<hash(record)>`, re-reads `.lock`, and only if it still holds
 *   that same record renames its own record over `.lock` in one step. Only
 *   one process can claim a given stale record, and `.lock` exists
 *   throughout, so a fresh `link` cannot slip in and two takers cannot both
 *   succeed. A claim records its claimant; a claim whose claimant is
 *   confirmed dead (killed between the claim and the rename) is replaced in
 *   one `rename` under a claim on that claim, by the same rule (r4 #2).
 * - A record from another host, an unreadable record, or a live pid is held:
 *   STORE_LOCKED. If such a lock is left by a process known to be gone (a
 *   crash on another host, a reused pid that `kill -0` still sees, or an
 *   earlier instance of this process's pid where no start time tells), remove
 *   `<root>/.lock` and any `<root>/.lock.break.*` by hand once no process uses
 *   the root. Refusing is the safe default: a wrong takeover would let two
 *   writers share a root.
 *
 * Node modules are loaded lazily, so importing this entry is safe anywhere;
 * opening a store needs Node.
 */
import { OriginalsError } from "@originals/vh";
import { sha256 } from "@originals/vh/crypto";
import type { AuthorDidEvidence } from "@originals/vh/originals";
import { hex } from "@scure/base";
import { headOf, higherVersion, refusedVersionId, staleHead, type CommitUpdate, type OriginalsStore, type StoredOriginal, type StoredRefused } from "./store.js";

export interface FileStoreFaults {
  /** Called after the new log is durably written, before it replaces the old one. */
  beforeRename?: () => void | Promise<void>;
}

/** What every handle on one root in this process shares. */
interface RootState {
  /** The token of this process's record in `.lock`. */
  token: string;
  /** Settles once `.lock` is taken (or refused); handles attach after it. */
  ready: Promise<void>;
  /** Set once the last handle closed; `open()` waits for it, then takes the lock afresh. */
  closing?: Promise<void>;
  locks: Map<string, Promise<void>>;
  /** Temporary files being written now. */
  writing: Set<string>;
  /** Every mutating operation in flight, from any handle; the last `close()` waits for them all. */
  inflight: Set<Promise<unknown>>;
  /** Open handles; the root's `.lock` is released when the last one closes. */
  handles: number;
}

/**
 * Per process, not per module instance: two copies of this module loaded in
 * one process (a bundle and the package, say) must share roots and tokens, or
 * one would read the other's lock as a reused pid.
 */
const roots: Map<string, RootState> = ((globalThis as Record<symbol, unknown>)[Symbol.for("@originals/sdk/fs-store/roots")] ??= new Map()) as Map<string, RootState>;

interface LockRecord {
  pid: number;
  host?: string;
  token?: string;
  /** The holder's start time where the platform exposes it (Linux /proc), else absent. */
  start?: string;
}

function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A process's start time in clock ticks since boot (Linux), or undefined where it cannot be read. */
async function startOf(pid: number): Promise<string | undefined> {
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined);
  if (stat === undefined) return undefined;
  // Field 22; the command name (field 2) is parenthesised and may hold spaces.
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

function parseRecord(text: string): LockRecord | undefined {
  const trimmed = text.trim();
  if (/^[1-9][0-9]*$/.test(trimmed)) return { pid: Number(trimmed) }; // a bare pid, as earlier builds wrote
  try {
    const record = JSON.parse(trimmed) as Partial<LockRecord>;
    if (typeof record.pid !== "number" || typeof record.host !== "string" || typeof record.token !== "string") return undefined;
    return { pid: record.pid, host: record.host, token: record.token, start: typeof record.start === "string" ? record.start : undefined };
  } catch {
    return undefined;
  }
}

/**
 * True only when the holder is confirmed gone; anything uncertain counts as held.
 *
 * A record under this process's pid is held unless it is provably from an
 * earlier process instance that had the pid (08b review r4 #1): worker threads
 * share the pid but not `roots`, so a token this thread does not know may be
 * another thread's live lock. Only a recorded kernel start time that differs
 * from this process's (Linux /proc) proves an earlier instance. A wall-clock
 * stamp (`Date.now() - process.uptime()`) is not used: it moves with clock
 * steps and, on macOS, with system sleep, so it could make a live lock of this
 * process look like an earlier one. Elsewhere such a record stays held
 * (STORE_LOCKED; remove it by hand once no process uses the root).
 */
async function stale(record: LockRecord): Promise<boolean> {
  if (record.host !== undefined && record.host !== hostname()) return false; // another host's pid cannot be checked
  if (record.pid === process.pid) {
    if ([...roots.values()].some((state) => state.token === record.token)) return false;
    const ours = await startOf(process.pid);
    return record.start !== undefined && ours !== undefined && record.start !== ours;
  }
  if (!alive(record.pid)) return true;
  if (record.start === undefined) return false;
  const start = await startOf(record.pid);
  return start !== undefined && start !== record.start; // a different process now has the pid
}

const lockedError = (root: string, record: LockRecord | undefined, detail = "") =>
  new OriginalsError(
    "unavailable-bytes",
    "STORE_LOCKED",
    record
      ? `${root} is in use by process ${record.pid}${record.host ? ` on ${record.host}` : ""}; one process writes a store at a time${detail}`
      : `${root}/.lock cannot be read as a lock record; if no process uses the store, remove it by hand${detail}`,
    { root, pid: record?.pid, host: record?.host },
  );

/** Read `path`, or undefined when it does not exist. */
async function readIfAny(path: string): Promise<string | undefined> {
  return fs.readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

/** The claim file whose exclusive creation entitles one process to replace the record `text`. */
const claimPath = (root: string, text: string) => join(root, `.lock.break.${hashHex(text).slice(0, 32)}`);

/** How deep claims on claims may go before an opener gives up (each level needs a taker killed mid-claim). */
const MAX_CLAIM_DEPTH = 4;

type Claim = { kind: "claimed"; release: () => Promise<void> } | { kind: "moved" } | { kind: "held"; record: LockRecord | undefined; path: string };

/**
 * Claim the right to replace the stale record `text` at `target`: exactly one
 * process can hold the claim on a given record. The claim is created with
 * `wx`. When it exists already, its claimant's record (written in the claim)
 * is judged like a lock record: a live or uncertain claimant keeps it
 * ("held"); a claimant confirmed dead on this host (killed between claiming
 * and renaming, 08b review r4 #2) has its claim replaced in one `rename`,
 * under a claim on that claim, by the same rule. "moved" when `target` no
 * longer holds `text`, so the caller should look again.
 */
async function claimBreak(root: string, target: string, text: string, mine: string, token: string, depth: number): Promise<Claim> {
  const path = claimPath(root, text);
  const release = async () => {
    // Remove the claim only while it is still this process's (a claim is only replaced once its claimant is dead).
    if ((await readIfAny(path)) === mine) await fs.rm(path, { force: true });
  };
  try {
    await fs.writeFile(path, mine, { flag: "wx" });
    return { kind: "claimed", release };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const claimText = await readIfAny(path);
  if ((await readIfAny(target)) !== text) return { kind: "moved" };
  if (claimText === undefined) return { kind: "moved" }; // the claimant finished or gave up: look again
  const claimant = parseRecord(claimText);
  if (!claimant || depth >= MAX_CLAIM_DEPTH || !(await stale(claimant))) return { kind: "held", record: claimant, path };
  const inner = await claimBreak(root, path, claimText, mine, token, depth + 1);
  if (inner.kind !== "claimed") return inner.kind === "moved" ? { kind: "moved" } : inner;
  try {
    // Nobody else can replace this dead claimant's claim now: take it over in one step.
    if ((await readIfAny(path)) !== claimText) return { kind: "moved" };
    const candidate = `${path}.${process.pid}.${token}.new`;
    await fs.writeFile(candidate, mine, { flag: "wx" });
    try {
      await fs.rename(candidate, path);
    } finally {
      await fs.rm(candidate, { force: true });
    }
    return { kind: "claimed", release };
  } finally {
    await inner.release();
  }
}

/**
 * Take `<root>/.lock` for this process under `token`, or refuse when another
 * process may hold it. See the module comment for the protocol.
 */
async function takeLock(root: string, token: string): Promise<void> {
  const path = join(root, ".lock");
  const mine: LockRecord = { pid: process.pid, host: hostname(), token, start: await startOf(process.pid) };
  const mineText = JSON.stringify(mine);
  const candidate = join(root, `.lock.${process.pid}.${token}.new`);
  await fs.writeFile(candidate, mineText, { flag: "wx" });
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await fs.link(candidate, path);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const text = await readIfAny(path);
      if (text === undefined) continue; // released meanwhile: link again
      const record = parseRecord(text);
      if (!record || !(await stale(record))) throw lockedError(root, record);
      // Claim the break of exactly this record; one process can.
      const claim = await claimBreak(root, path, text, mineText, token, 0);
      if (claim.kind === "moved") continue; // another taker finished, or the claim changed hands
      if (claim.kind === "held") {
        throw lockedError(root, record, `; another process is taking over its stale lock (if none is, remove ${claim.path} by hand)`);
      }
      try {
        // Nobody else can replace this record now, and its holder is gone: replace it in one step.
        if ((await readIfAny(path)) !== text) continue;
        await fs.rename(candidate, path);
        return;
      } finally {
        await claim.release();
      }
    }
    throw new OriginalsError("unavailable-bytes", "STORE_LOCKED", `${root} is being opened by other processes`, { root });
  } finally {
    await fs.rm(candidate, { force: true });
  }
}

/** Remove `.lock` if this process holds it under `token`. */
async function releaseLock(root: string, token: string): Promise<void> {
  const path = join(root, ".lock");
  const record = parseRecord(await fs.readFile(path, "utf8").catch(() => ""));
  // Nobody replaces a live holder's record (see `stale`), so the check and the removal cannot interleave with a takeover.
  if (record?.pid === process.pid && record.token === token) await fs.rm(path, { force: true });
}

const DID_VH = /^did:vh:([1-9A-HJ-NP-Za-km-z]{46})$/;
const DIGEST = /^z[1-9A-HJ-NP-Za-km-z]{1,120}$/;

type Fs = typeof import("node:fs/promises");
let fs: Fs;
let randomHex: (bytes: number) => string;
let hostname: () => string;
const join = (...parts: string[]) => parts.join("/");
const hashHex = (text: string) => hex.encode(sha256(new TextEncoder().encode(text)));

async function loadNode(): Promise<void> {
  fs ??= await import("node:fs/promises");
  if (!randomHex) {
    const { randomBytes } = await import("node:crypto");
    randomHex = (n) => randomBytes(n).toString("hex");
  }
  if (!hostname) hostname = (await import("node:os")).hostname;
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

  private closed = false;

  private constructor(
    private readonly root: string,
    private readonly key: string,
    private readonly shared: RootState,
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
    const shared = await FileStore.attach(root, key);
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
      for (const sub of ["branches", "refused"]) {
        const dir = join(root, "originals", scid, sub);
        await sweep(dir, await readdir(dir).catch(() => [] as string[]));
      }
    }
    for (const dir of ["resources", "authors", "retained"]) await sweep(join(root, dir), await readdir(join(root, dir)));
    // Lock candidates a crashed opener left behind.
    for (const name of await readdir(root)) {
      const pid = Number(/^\.lock\.(?:break\.[0-9a-f]+\.)?(\d+)\.[0-9a-f]+\.new$/.exec(name)?.[1]);
      if (pid && pid !== process.pid && !alive(pid)) await rm(join(root, name), { force: true });
    }
    return new FileStore(root, key, shared, faults);
  }

  /**
   * Close this handle. When the last handle on the root in this process
   * closes, its pending writes finish and the root's `.lock` is released, so
   * another process can open it, for example a writer restarted in a new
   * process. A closed handle refuses writes (STORE_CLOSED). Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const shared = this.shared;
    shared.handles--;
    if (shared.handles > 0) return;
    // Closing: `open()` waits for this before deciding whether it holds the lock (08b review r2 #3).
    shared.closing = (async () => {
      try {
        // Every write in flight from any handle, including ones chained behind a per-Original lock (r2 #2).
        while (shared.inflight.size > 0) await Promise.allSettled([...shared.inflight]);
        await releaseLock(this.root, shared.token);
      } finally {
        if (roots.get(this.key) === shared) roots.delete(this.key);
      }
    })();
    await shared.closing;
  }

  /** The root's shared state with this handle counted, taking `.lock` when this process does not hold it. */
  private static async attach(root: string, key: string): Promise<RootState> {
    for (;;) {
      const existing = roots.get(key);
      if (existing?.closing) {
        await existing.closing.catch(() => undefined);
        continue;
      }
      if (existing) {
        await existing.ready;
        if (roots.get(key) !== existing || existing.closing) continue;
        existing.handles++;
        return existing;
      }
      // Registered before the first await, so a concurrent open in this process waits for this one.
      const token = randomHex(16);
      const state: RootState = { token, ready: Promise.resolve(), locks: new Map(), writing: new Set(), inflight: new Set(), handles: 0 };
      state.ready = takeLock(root, token).catch((error: unknown) => {
        if (roots.get(key) === state) roots.delete(key);
        throw error;
      });
      roots.set(key, state);
      await state.ready;
      state.handles++;
      return state;
    }
  }

  /** Run a mutating operation: refused on a closed handle, and awaited by the root's last `close()`. */
  private async track<T>(fn: () => Promise<T>): Promise<T> {
    this.open();
    const run = fn();
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.shared.inflight.add(settled);
    void settled.then(() => this.shared.inflight.delete(settled));
    return await run;
  }

  private open(): void {
    if (this.closed) throw new OriginalsError("unavailable-bytes", "STORE_CLOSED", `this handle on ${this.root} is closed`, { root: this.root });
  }

  private dirOf(did: string): string {
    const match = DID_VH.exec(did);
    if (!match) throw new OriginalsError("invalid-evidence", "STORE_DID_INVALID", `${did} is not a did:vh`);
    return join(this.root, "originals", match[1]);
  }

  /** Called only under `track`, which refused it on a closed handle. */
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
    return this.track(() => this.commitNow(did, update));
  }

  private commitNow(did: string, update: CommitUpdate): Promise<void> {
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
    return this.track(async () => {
      if (!DIGEST.test(digest)) throw new OriginalsError("invalid-evidence", "STORE_DIGEST_INVALID", `${digest} is not a digest`);
      if ((await this.getResource(digest)) !== undefined) return;
      await this.writeAtomically(join(this.root, "resources"), digest, bytes);
    });
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
    return this.track(() => this.writeAtomically(join(this.root, "authors"), this.didFile(evidence.did), JSON.stringify(evidence)));
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
    return this.track(() => this.putRetainedNow(did, versionId));
  }

  private putRetainedNow(did: string, versionId: string): Promise<void> {
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
    return this.track(async () => {
      const dir = join(this.dirOf(did), "branches");
      await fs.mkdir(dir, { recursive: true });
      const name = `${hashHex(log)}.jsonl`;
      if ((await this.readText(join(dir, name))) === undefined) await this.writeAtomically(dir, name, log);
    });
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

  async putRefused(did: string, refused: StoredRefused): Promise<void> {
    const dir = join(this.dirOf(did), "refused");
    await fs.mkdir(dir, { recursive: true });
    const name = this.didFile(refusedVersionId(refused));
    const existing = await this.readText(join(dir, name));
    if (existing === undefined || (JSON.parse(existing) as StoredRefused).entry === refused.entry) await this.writeAtomically(dir, name, JSON.stringify(refused));
  }

  async getRefused(did: string): Promise<StoredRefused[]> {
    const dir = join(this.dirOf(did), "refused");
    const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort();
    const out: StoredRefused[] = [];
    for (const name of names) {
      const text = await this.readText(join(dir, name));
      if (text !== undefined) out.push(JSON.parse(text) as StoredRefused);
    }
    return out;
  }

  async dropRefused(did: string, versionId: string): Promise<void> {
    const dir = join(this.dirOf(did), "refused");
    await fs.rm(join(dir, this.didFile(versionId)), { force: true });
    await fsyncDir(dir).catch(() => undefined);
  }

  async list(): Promise<string[]> {
    return (await fs.readdir(join(this.root, "originals"))).map((scid) => `did:vh:${scid}`);
  }
}
