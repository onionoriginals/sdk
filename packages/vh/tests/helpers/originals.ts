/** Test helpers: did:vh author DIDs and Originals built with the library's own builders. */
import { localSigner, type CryptosuiteName, type KeyType, type ProofSigner } from "../../src/crypto/index.js";
import type { JsonObject } from "../../src/json/index.js";
import { appendEntry, createLog, serializeLog, signWith, type EntrySigner, type LogEntry } from "../../src/log/index.js";
import { resourceDigest, type AuthorDidEvidence, type AuthorRef } from "../../src/originals/index.js";

export const NOW = Date.parse("2026-10-19T00:00:00Z");
export const bytes = (text: string) => new TextEncoder().encode(text);
export const seeded = (seed: number, type: KeyType = "Ed25519") => localSigner(type, new Uint8Array(32).fill(seed));
export const suiteOf = (signer: ProofSigner): CryptosuiteName => (signer.keyType === "Ed25519" ? "eddsa-jcs-2022" : "bip340-jcs-2025");

/** A did:vh author DID whose documents are built from a list of author keys per version. */
export class VhAuthor {
  readonly update = seeded(90);
  entries: LogEntry[] = [];
  did = "";
  private seconds = 0;

  static async create(keys: Array<{ fragment: string; signer: ProofSigner; relationship?: string; controller?: string }>): Promise<VhAuthor> {
    const author = new VhAuthor();
    const genesis = await createLog({
      versionTime: author.time(),
      parameters: { method: "did:vh:1.0", scid: "{SCID}", updateKeys: [author.update.publicKeyMultibase] },
      state: author.document("did:vh:{SCID}", keys),
      sign: author.signUpdate(),
    });
    author.entries = [genesis];
    author.did = genesis.state.id as string;
    return author;
  }

  /** The versionTime of the next author DID version, when a test needs a specific one. */
  timeOverride: string | null = null;

  private time(): string {
    if (this.timeOverride) {
      const t = this.timeOverride.replace(/\.000Z$/, "Z");
      this.timeOverride = null;
      return t;
    }
    return `2026-10-18T09:${String(Math.floor(this.seconds / 60)).padStart(2, "0")}:${String(this.seconds++ % 60).padStart(2, "0")}Z`;
  }

  private signUpdate(): EntrySigner {
    const k = this.update.publicKeyMultibase;
    return signWith(this.update, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${k}#${k}` });
  }

  document(did: string, keys: Array<{ fragment: string; signer: ProofSigner; relationship?: string; controller?: string }>): JsonObject {
    return {
      "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
      id: did,
      verificationMethod: keys.map((k) => ({ id: `${did}#${k.fragment}`, type: "Multikey", controller: k.controller ?? did, publicKeyMultibase: k.signer.publicKeyMultibase })),
      assertionMethod: keys.filter((k) => (k.relationship ?? "assertionMethod") === "assertionMethod").map((k) => `${did}#${k.fragment}`),
      authentication: keys.filter((k) => k.relationship === "authentication").map((k) => `${did}#${k.fragment}`),
    };
  }

  /** Publish a new version with these keys (key rotation, P5.10). */
  async rotate(keys: Array<{ fragment: string; signer: ProofSigner; relationship?: string }>, parameters: JsonObject = {}): Promise<string> {
    const next = await appendEntry(this.entries[this.entries.length - 1], {
      versionTime: this.time(), parameters, state: this.document(this.did, keys), sign: this.signUpdate(),
    });
    this.entries.push(next);
    return next.versionId;
  }

  async deactivate(): Promise<void> {
    const last = this.entries[this.entries.length - 1];
    this.entries.push(await appendEntry(last, { versionTime: this.time(), parameters: { deactivated: true }, state: last.state, sign: this.signUpdate() }));
  }

  get versionId(): string {
    return this.entries[this.entries.length - 1].versionId;
  }

  evidence(entries = this.entries): AuthorDidEvidence {
    return { did: this.did, log: serializeLog(entries) };
  }

  ref(fragment: string, versionId = this.versionId): AuthorRef {
    return { did: this.did, verificationMethod: `${this.did}#${fragment}`, versionId };
  }

  signer(signer: ProofSigner, fragment: string): EntrySigner {
    return signWith(signer, { cryptosuite: suiteOf(signer), verificationMethod: `${this.did}#${fragment}` });
  }
}

export const photo = (text: string, id = "photo") => ({ id, mediaType: "image/jpeg", size: bytes(text).length, digest: resourceDigest(bytes(text)) });

/** Original entry timestamps, with milliseconds (Q8), counting up from noon. */
export function clock(start = 0) {
  let n = start;
  return () => {
    const ms = n++ * 1250;
    const d = new Date(Date.parse("2026-10-18T12:00:00Z") + ms);
    return d.toISOString();
  };
}

type WebvhKey = { fragment: string; signer: ProofSigner; relationship?: string; controller?: string };

/**
 * A did:webvh author DID built with this library's own VH-Log builder, so a
 * test can move it under did:webvh portability (P5.14): `portable` at genesis,
 * a new `state.id` with the same SCID, and the prior DID in `alsoKnownAs`.
 * `did` is the identity DID: the DID at genesis.
 */
export class WebvhAuthor {
  readonly update = seeded(91);
  entries: LogEntry[] = [];
  did = "";
  private seconds = 0;

  static async create(keys: WebvhKey[], options: { domain?: string; portable?: boolean; alsoKnownAs?: string[] } = {}): Promise<WebvhAuthor> {
    const author = new WebvhAuthor();
    const genesis = await createLog({
      versionTime: author.time(),
      parameters: { method: "did:webvh:1.0", scid: "{SCID}", updateKeys: [author.update.publicKeyMultibase], portable: options.portable ?? true },
      state: author.document(`did:webvh:{SCID}:${options.domain ?? "old.example.com"}`, keys, options.alsoKnownAs ? { alsoKnownAs: options.alsoKnownAs } : {}),
      sign: author.signUpdate(),
    });
    author.entries = [genesis];
    author.did = genesis.state.id as string;
    return author;
  }

  private time(): string {
    return `2026-10-18T10:${String(Math.floor(this.seconds / 60)).padStart(2, "0")}:${String(this.seconds++ % 60).padStart(2, "0")}Z`;
  }

  private signUpdate(): EntrySigner {
    const k = this.update.publicKeyMultibase;
    return signWith(this.update, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${k}#${k}` });
  }

  /** The DID document `id` of the latest version: where the DID lives now. */
  get location(): string {
    return this.entries[this.entries.length - 1].state.id as string;
  }

  get scid(): string {
    return this.entries[0].parameters.scid as string;
  }

  get versionId(): string {
    return this.entries[this.entries.length - 1].versionId;
  }

  document(id: string, keys: WebvhKey[], extra: JsonObject = {}): JsonObject {
    return {
      "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
      id,
      verificationMethod: keys.map((k) => ({ id: `${id}#${k.fragment}`, type: "Multikey", controller: k.controller ?? id, publicKeyMultibase: k.signer.publicKeyMultibase })),
      assertionMethod: keys.filter((k) => (k.relationship ?? "assertionMethod") === "assertionMethod").map((k) => `${id}#${k.fragment}`),
      ...extra,
    };
  }

  /** Move to another host under did:webvh portability, optionally changing keys in the same version. */
  async move(domain: string, keys: WebvhKey[]): Promise<string> {
    const prior = this.location;
    const id = `did:webvh:${this.scid}:${domain}`;
    const aka = [...new Set([...(((this.entries[this.entries.length - 1].state.alsoKnownAs as string[] | undefined) ?? [])), prior])];
    return this.appendState(this.document(id, keys, { alsoKnownAs: aka }));
  }

  /** A new version at the current location with these keys (rotation, P5.10), and any parameters (a witness list). */
  async rotate(keys: WebvhKey[], parameters: JsonObject = {}): Promise<string> {
    const aka = this.entries[this.entries.length - 1].state.alsoKnownAs;
    return this.appendState(this.document(this.location, keys, aka ? { alsoKnownAs: aka } : {}), parameters);
  }

  /** Publish a version with exactly this DID document. */
  async appendState(state: JsonObject, parameters: JsonObject = {}): Promise<string> {
    const next = await appendEntry(this.entries[this.entries.length - 1], { versionTime: this.time(), parameters, state, sign: this.signUpdate() });
    this.entries.push(next);
    return next.versionId;
  }

  evidence(entries = this.entries, did = this.did): AuthorDidEvidence {
    return { did, log: serializeLog(entries) };
  }

  /** An author reference naming the identity DID and the verification method as it appears at `versionId`. */
  ref(fragment: string, versionId = this.versionId): AuthorRef {
    const at = this.entries.find((e) => e.versionId === versionId)!.state.id as string;
    return { did: this.did, verificationMethod: `${at}#${fragment}`, versionId };
  }

  signer(signer: ProofSigner, ref: AuthorRef): EntrySigner {
    return signWith(signer, { cryptosuite: suiteOf(signer), verificationMethod: ref.verificationMethod });
  }
}
