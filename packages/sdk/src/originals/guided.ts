/**
 * The guided path: Create → Add a version → Export → Verify, in four calls
 * from `@originals/sdk` alone. It is a thin layer over `OriginalsSDK`:
 * every step is the full workflow's (`create`, `edit`, `package`, `load`), so
 * nothing here signs, links, hashes or verifies differently.
 *
 * ```ts
 * const studio = await OriginalsStudio.start();               // a local author and an in-memory store
 * const app = await studio.create({ name: "My app", resource: { mediaType: "text/html", bytes } });
 * await app.addVersion({ bytes: next, label: "New UI", note: "Reworked the navigation." });
 * const file = await app.export();                             // { bytes, fileName, manifest }
 * const result = await studio.verify(file.bytes);              // what a recipient sees, offline
 * ```
 *
 * A version's label and note are signed metadata of the entry that adds the
 * version (PROVISIONAL: the spec leaves metadata members open, so the key and
 * shape are this SDK's choice).
 */
import { OriginalsError } from "@originals/vh";
import { localSigner } from "@originals/vh/crypto";
import { isJsonObject, parseJson, type JsonObject } from "@originals/vh/json";
import { createLog, serializeLog, signWith, type LogEntry } from "@originals/vh/log";
import { resourceDigestAsync, type AuthorDidEvidence, type AuthorRef, type EntryState, type OriginalsReport, type ValidAsOf } from "@originals/vh/originals";
import { readEvidence, type EvidenceManifest } from "./evidence.js";
import { OriginalsSDK, type OriginalView } from "./sdk.js";
import { keySigner, type OriginalsSigner } from "./signer.js";
import { MemoryStore, type OriginalsStore } from "./store.js";
import { isVerified, verdictLine } from "./verdict.js";

// ------------------------------------------------------------- local author

/**
 * A did:vh author made on this device. Its update key and its author key are
 * different keys (P5.11), and the author key is the document's only
 * `assertionMethod` (P5.3). Nothing is published: an Original it authors
 * verifies anywhere through its evidence package, which carries this DID's log.
 */
export interface LocalAuthor {
  ref: AuthorRef;
  evidence: AuthorDidEvidence;
  signer: OriginalsSigner;
  /** The author key's secret. Keep it to sign later versions; it is never put in an evidence package. */
  secret: Uint8Array;
}

/** What to keep to sign with a local author again: `restoreLocalAuthor` rebuilds its signer. */
export type SavedLocalAuthor = Pick<LocalAuthor, "ref" | "evidence" | "secret">;

const randomKey = () => crypto.getRandomValues(new Uint8Array(32));

/**
 * Make a local author. Its DID's single version is dated one second before
 * `at` (default now), in whole seconds, so entries signed from `at` on follow it. The update
 * key's secret is discarded: this DID is never rotated.
 */
export async function createLocalAuthor(at: number | Date = Date.now()): Promise<LocalAuthor> {
  const now = typeof at === "number" ? at : at.getTime();
  const update = localSigner("Ed25519", randomKey());
  const secret = randomKey();
  const key = localSigner("Ed25519", secret);
  const did = "did:vh:{SCID}";
  const genesis = await createLog({
    versionTime: new Date(Math.floor(now / 1000) * 1000 - 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    parameters: { method: "did:vh:1.0", scid: "{SCID}", updateKeys: [update.publicKeyMultibase] },
    state: {
      "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
      id: did,
      verificationMethod: [{ id: `${did}#author`, type: "Multikey", controller: did, publicKeyMultibase: key.publicKeyMultibase }],
      assertionMethod: [`${did}#author`],
    },
    sign: signWith(update, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${update.publicKeyMultibase}#${update.publicKeyMultibase}` }),
  });
  const authorDid = genesis.state.id as string;
  return restoreLocalAuthor({
    secret,
    ref: { did: authorDid, verificationMethod: `${authorDid}#author`, versionId: genesis.versionId },
    evidence: { did: authorDid, log: serializeLog([genesis]) },
  });
}

/** A saved local author, with its signer rebuilt from the secret. */
export function restoreLocalAuthor(saved: SavedLocalAuthor): LocalAuthor {
  return { ...saved, signer: keySigner({ keyType: "Ed25519", secretKey: saved.secret, verificationMethod: saved.ref.verificationMethod }) };
}

// ------------------------------------------------------------ version notes

/**
 * The metadata member holding the label and note of the version an entry
 * adds (PROVISIONAL). `digest` names that version, so a note that a later
 * edit carries over unchanged is never read as the next version's.
 */
export const VERSION_NOTE_KEY = "originals:version";

export interface VersionNote {
  label: string;
  note?: string;
  digest: string;
}

/** One resource version, from verified history, with the label and note it was added with. */
export interface VersionInfo {
  /** Derived from history; genesis is 1 (P4.4). */
  version: number;
  digest: string;
  mediaType: string;
  size: number;
  /** The entry that added this version. */
  versionId: string;
  versionTime: string;
  label?: string;
  note?: string;
}

function noteOf(metadata: unknown, digest: string): Pick<VersionInfo, "label" | "note"> {
  if (!isJsonObject(metadata)) return {};
  const n = metadata[VERSION_NOTE_KEY];
  if (!isJsonObject(n) || n.digest !== digest || typeof n.label !== "string") return {};
  return { label: n.label, ...(typeof n.note === "string" ? { note: n.note } : {}) };
}

/** Each verified version, labelled from the entry that added it. */
function versionsOf(log: string, versions: OriginalsReport["resources"]["versions"], labelled: boolean): VersionInfo[] {
  const entries = new Map<string, LogEntry>();
  for (const line of log.split("\n")) {
    if (line === "") continue;
    const entry = parseJson(line) as unknown as LogEntry;
    entries.set(entry.versionId, entry);
  }
  return versions.map((v) => {
    const entry = entries.get(v.versionId);
    const asset = (entry?.state as unknown as EntryState | undefined)?.asset;
    return {
      version: v.version, digest: v.digest, mediaType: v.mediaType, size: v.size, versionId: v.versionId,
      versionTime: entry?.versionTime ?? "",
      ...(labelled ? noteOf(asset?.metadata, v.digest) : {}),
    };
  });
}

function checkText(value: unknown, what: string, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw new OriginalsError("invalid-evidence", "INPUT_INVALID", `${what} must be non-empty text`);
  }
  return value;
}

function withNote(metadata: JsonObject | undefined, label: string | undefined, note: string | undefined, digest: string): JsonObject | undefined {
  if (label === undefined) return metadata;
  const entry: JsonObject = { label, ...(note !== undefined ? { note } : {}), digest };
  return { ...(metadata ?? {}), [VERSION_NOTE_KEY]: entry };
}

function fileNameOf(name: string, did: string, version: number): string {
  const slug = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return `${slug || did.slice(did.lastIndexOf(":") + 1)}-v${version}.originals.zip`;
}

// ------------------------------------------------------------------ studio

export interface StudioOptions {
  /** Where Originals are kept; an in-memory store by default. In Node, `FileStore.open(dir)` from `@originals/sdk/originals/fs` keeps them. */
  store?: OriginalsStore;
  /** The author who signs; a new local author by default. Pass a saved one to keep editing its Originals. */
  author?: SavedLocalAuthor;
  /** Milliseconds since the epoch. */
  clock?: () => number;
}

export interface StudioCreateInput {
  name: string;
  resource: { mediaType: string; bytes: Uint8Array };
  metadata?: JsonObject;
  /** A label for version 1. */
  label?: string;
  /** A sentence about version 1; needs a label. */
  note?: string;
}

export interface AddVersionInput {
  /** The new bytes. The same bytes add no version and are refused (P4.4). */
  bytes: Uint8Array;
  /** Required: what to call this version, e.g. "New UI". */
  label: string;
  /** A sentence about what changed. */
  note?: string;
  /** Defaults to the current media type. */
  mediaType?: string;
}

export interface ExportedOriginal {
  /** The evidence package: a ZIP anyone can verify offline (`originals verify <file>`, or `verify`). */
  bytes: Uint8Array;
  /** A suggested file name, `<name>-v<version>.originals.zip`. */
  fileName: string;
  manifest: EvidenceManifest;
}

/**
 * What a recipient of the package sees. `verified` is exactly the
 * `originals verify` command's verdict; the parts stay separate in `report`.
 */
export interface StudioVerification {
  verified: boolean;
  /** The CLI's summary line, notices included. */
  line: string;
  did: string | null;
  checkpoint: string | null;
  /** Never true for an Original that is not anchored (P7.10). */
  current: boolean;
  validAsOf: ValidAsOf | null;
  /** Every version; labels and notes are signed claims, given only when `verified`. */
  versions: VersionInfo[];
  reasons: string[];
  report: OriginalsReport;
  manifest: EvidenceManifest;
}

/** A local workspace for one author: create Originals, add versions, export and verify them. */
export class OriginalsStudio {
  private constructor(
    /** The full workflow, for anything the guided path does not cover. */
    readonly sdk: OriginalsSDK,
    readonly author: LocalAuthor,
    private readonly clock: () => number,
  ) {}

  static async start(options: StudioOptions = {}): Promise<OriginalsStudio> {
    const clock = options.clock ?? Date.now;
    const author = options.author ? restoreLocalAuthor(options.author) : await createLocalAuthor(clock());
    const sdk = OriginalsSDK.create({
      store: options.store ?? new MemoryStore(),
      authors: [{ ...author.evidence, obtainedAt: new Date(clock()).toISOString() }],
      clock,
    });
    return new OriginalsStudio(sdk, author, clock);
  }

  /** Create an Original: its resource's version 1, signed by the author. */
  async create(input: StudioCreateInput): Promise<OriginalHandle> {
    const label = checkText(input.label, "label", false);
    const note = checkText(input.note, "note", false);
    if (note !== undefined && label === undefined) throw new OriginalsError("invalid-evidence", "INPUT_INVALID", "a note needs a label");
    // Bytes that are not a Uint8Array are left to `create`, which refuses them (INPUT_INVALID).
    const bytes = input.resource?.bytes;
    const metadata = label === undefined || !(bytes instanceof Uint8Array) ? input.metadata : withNote(input.metadata, label, note, await resourceDigestAsync(bytes));
    const created = await this.sdk.create({
      name: input.name, resource: input.resource, ...(metadata !== undefined ? { metadata } : {}),
      author: this.author.ref, signer: this.author.signer,
    });
    if (created.kind !== "original") throw new OriginalsError("invalid-evidence", "COMMIT_FAILED", "the Original was not signed");
    return new OriginalHandle(this, created.original);
  }

  /** A handle on an Original in this studio's store, at its verified head. */
  async open(did: string): Promise<OriginalHandle> {
    return new OriginalHandle(this, await this.sdk.get(did));
  }

  /**
   * Verify an evidence package as a recipient would: offline, with no key and
   * nothing from this studio's store (P7.3). The same verdict as
   * `originals verify`.
   */
  async verify(zip: Uint8Array): Promise<StudioVerification> {
    const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: this.clock });
    const { manifest, report, reasons } = await reader.load(zip);
    const verified = isVerified(report, reasons);
    return {
      verified,
      line: verdictLine(report, verified),
      did: report.original,
      checkpoint: report.checkpoint,
      current: report.current,
      validAsOf: report.validAsOf,
      versions: versionsOf(readEvidence(zip).log, report.resources.versions, verified),
      reasons,
      report,
      manifest,
    };
  }
}

/**
 * One Original, at the checkpoint this handle last saw. Each change builds on
 * that checkpoint: if the Original moved elsewhere meanwhile, the change is a
 * `stale-parent` conflict, never rebased (P4.5); `refresh()` and decide again.
 */
export class OriginalHandle {
  constructor(private readonly studio: OriginalsStudio, private current: OriginalView) {}

  get did(): string {
    return this.current.did;
  }

  get checkpoint(): string {
    return this.current.checkpoint;
  }

  /** The verified view at `checkpoint`. */
  get view(): OriginalView {
    return this.current;
  }

  /** Re-read the Original's verified head from the store. */
  async refresh(): Promise<this> {
    this.current = await this.studio.sdk.get(this.did);
    return this;
  }

  /** Add the resource's next version, with a label and an optional note, signed by the author. */
  async addVersion(input: AddVersionInput): Promise<VersionInfo> {
    const label = checkText(input.label, "label", true)!;
    const note = checkText(input.note, "note", false);
    if (!(input.bytes instanceof Uint8Array)) throw new OriginalsError("invalid-evidence", "INPUT_INVALID", "bytes must be a Uint8Array");
    const { sdk, author } = this.studio;
    const resource = { bytes: input.bytes, ...(input.mediaType !== undefined ? { mediaType: input.mediaType } : {}) };
    const digest = await resourceDigestAsync(input.bytes);
    // C12-19: the same bytes add no version (P4.4); a guided "add a version" that adds none is refused.
    if (digest === this.current.state.resource.digest) {
      throw new OriginalsError("invalid-evidence", "VERSION_UNCHANGED", "these bytes are the current version; a version needs new bytes (P4.4)");
    }
    const result = await sdk.edit(this.did, {
      parent: this.checkpoint, resource, metadata: withNote(this.current.state.metadata, label, note, digest)!,
      author: author.ref, signer: author.signer,
    });
    this.current = result.original;
    const versions = await this.versions();
    return versions[versions.length - 1];
  }

  /** Every version of the resource, in order, with its label and note. */
  async versions(): Promise<VersionInfo[]> {
    return versionsOf(await this.studio.sdk.committedLog(this.did), this.current.report.resources.versions, true);
  }

  /** The evidence package through `checkpoint`: hand it to anyone; `studio.verify` or `originals verify` checks it. */
  async export(): Promise<ExportedOriginal> {
    const pkg = await this.studio.sdk.package(this.did, { checkpoint: this.checkpoint });
    const versions = this.current.report.resources.versions;
    const version = versions.length > 0 ? versions[versions.length - 1].version : 1;
    return { bytes: pkg.bytes, fileName: fileNameOf(this.current.state.name, this.did, version), manifest: pkg.manifest };
  }
}
