/** Test helpers for the Originals SDK: a did:vh author DID with one author key. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { localSigner, multibaseEncode, type ProofSigner } from "@originals/vh/crypto";
import * as W from "didwebvh-ts";
import type { JsonObject } from "@originals/vh/json";
import { appendEntry, createLog, createWitnessProof, serializeLog, signWith, type LogEntry } from "@originals/vh/log";
import type { AuthorDidEvidence, AuthorRef } from "@originals/vh/originals";
import { keySigner, type OriginalsSigner } from "../../../src/originals/index.js";

export const NOW = Date.parse("2026-10-19T00:00:00Z");
export const bytes = (text: string) => new TextEncoder().encode(text);
export const seed = (n: number) => new Uint8Array(32).fill(n);

export class Author {
  readonly update: ProofSigner = localSigner("Ed25519", seed(90));
  entries: LogEntry[] = [];
  did = "";
  private n = 0;

  static async create(keys: Array<{ fragment: string; secret: Uint8Array }>): Promise<Author> {
    const a = new Author();
    a.entries = [await createLog({
      versionTime: a.time(),
      parameters: { method: "did:vh:1.0", scid: "{SCID}", updateKeys: [a.update.publicKeyMultibase] },
      state: a.document("did:vh:{SCID}", keys),
      sign: a.signUpdate(),
    })];
    a.did = a.entries[0].state.id as string;
    return a;
  }

  private time() {
    return `2026-10-18T08:00:${String(this.n++).padStart(2, "0")}Z`;
  }

  private signUpdate() {
    const k = this.update.publicKeyMultibase;
    return signWith(this.update, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${k}#${k}` });
  }

  document(did: string, keys: Array<{ fragment: string; secret: Uint8Array }>): JsonObject {
    return {
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: did,
      verificationMethod: keys.map((k) => ({ id: `${did}#${k.fragment}`, type: "Multikey", controller: did, publicKeyMultibase: localSigner("Ed25519", k.secret).publicKeyMultibase })),
      assertionMethod: keys.map((k) => `${did}#${k.fragment}`),
    };
  }

  async rotate(keys: Array<{ fragment: string; secret: Uint8Array }>, versionTime = this.time()) {
    this.entries.push(await appendEntry(this.entries[this.entries.length - 1], {
      versionTime, parameters: {}, state: this.document(this.did, keys), sign: this.signUpdate(),
    }));
  }

  get versionId() {
    return this.entries[this.entries.length - 1].versionId;
  }

  evidence(entries = this.entries): AuthorDidEvidence {
    return { did: this.did, log: serializeLog(entries) };
  }

  ref(fragment: string): AuthorRef {
    return { did: this.did, verificationMethod: `${this.did}#${fragment}`, versionId: this.versionId };
  }

  signer(fragment: string, secret: Uint8Array): OriginalsSigner {
    return keySigner({ keyType: "Ed25519", secretKey: secret, verificationMethod: `${this.did}#${fragment}` });
  }
}

/** A clock that advances 250 ms per call. */
export function clock(start = Date.parse("2026-10-18T12:00:00Z")) {
  let t = start;
  return () => (t += 250);
}

/**
 * A did:webvh author DID written by didwebvh-ts 3 (did:webvh 1.0), so a move is
 * a real did:webvh portability move (P5.14): `portable` at genesis, then an
 * update to another domain, which didwebvh-ts records with the prior DID in
 * `alsoKnownAs`. Its verification methods keep relative ids. didwebvh-ts 3
 * rewrites a method's `controller` that names the prior DID to the new one on
 * a move (2.8.0 kept it); `keepController` writes the prior shape explicitly.
 * `did` is the identity DID, the DID at genesis.
 */
export class WebvhIdentity {
  readonly update: ProofSigner = localSigner("Ed25519", seed(92));
  log: Array<Record<string, unknown>> = [];
  did = "";
  private n = 0;

  private time() {
    return `2026-10-18T09:00:${String(this.n++).padStart(2, "0")}Z`;
  }

  private updateSigner() {
    const k = this.update.publicKeyMultibase;
    return {
      getVerificationMethodId: () => `did:key:${k}#${k}`,
      sign: async ({ document, proof }: { document: Record<string, unknown>; proof: Record<string, unknown> }) =>
        ({ proofValue: multibaseEncode(await this.update.sign(await W.prepareDataForSigning(document, proof))) }),
    };
  }

  private readonly verifier = { verify: (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array) => Promise.resolve(ed25519.verify(signature, message, publicKey)) };

  /**
   * The assertion keys as a complete document for didwebvh-ts 3, which takes
   * the whole DID document; `{DID}` is the DID the entry is written at.
   */
  private document(keys: Array<{ fragment: string; secret: Uint8Array }>, base: Record<string, unknown> = {}) {
    const verificationMethod = keys.map((k) => ({ id: `#${k.fragment}`, type: "Multikey", controller: "{DID}", publicKeyMultibase: localSigner("Ed25519", k.secret).publicKeyMultibase }));
    return {
      "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
      ...base,
      id: "{DID}",
      controller: "{DID}",
      verificationMethod,
      authentication: [],
      assertionMethod: verificationMethod.map((m) => m.id),
    };
  }

  static async create(domain: string, keys: Array<{ fragment: string; secret: Uint8Array }>): Promise<WebvhIdentity> {
    const a = new WebvhIdentity();
    const created = await W.createDID({
      address: domain, signer: a.updateSigner(), verifier: a.verifier, updateKeys: [a.update.publicKeyMultibase], portable: true,
      didDocument: a.document(keys) as never, created: a.time(),
    });
    a.log = created.log as unknown as Array<Record<string, unknown>>;
    a.did = created.did;
    return a;
  }

  /** Move to another domain under did:webvh portability. */
  async move(domain: string): Promise<string> {
    const r = await W.updateDID({ log: this.log as never, signer: this.updateSigner(), verifier: this.verifier, address: domain, updated: this.time() });
    this.log = r.log as unknown as Array<Record<string, unknown>>;
    return this.versionId;
  }

  /** Name `did` as every method's controller in a new version (the shape 2.8.0 wrote on a move). */
  async keepController(did: string): Promise<string> {
    const state = this.log[this.log.length - 1].state as { verificationMethod: Array<Record<string, unknown>> };
    const didDocument = { ...state, verificationMethod: state.verificationMethod.map((m) => ({ ...m, controller: did })) };
    const r = await W.updateDID({ log: this.log as never, signer: this.updateSigner(), verifier: this.verifier, didDocument: didDocument as never, updated: this.time() });
    this.log = r.log as unknown as Array<Record<string, unknown>>;
    return this.versionId;
  }

  /** Replace the assertion keys (rotation, P5.10). */
  async rotate(keys: Array<{ fragment: string; secret: Uint8Array }>): Promise<string> {
    const state = this.log[this.log.length - 1].state as Record<string, unknown>;
    const r = await W.updateDID({ log: this.log as never, signer: this.updateSigner(), verifier: this.verifier, didDocument: this.document(keys, state) as never, updated: this.time() });
    this.log = r.log as unknown as Array<Record<string, unknown>>;
    return this.versionId;
  }

  /** The did-witness.json entries for this log, once witnesses are set. */
  witness: Array<{ versionId: string; proof: unknown[] }> | undefined;

  /** Add `witness` as this DID's one witness, approving the version that does (P7.8 needs it). */
  async witnessedBy(witness: ProofSigner): Promise<string> {
    const r = await W.updateDID({
      log: this.log as never, signer: this.updateSigner(), verifier: this.verifier, updated: this.time(),
      witness: { threshold: 1, witnesses: [{ id: `did:key:${witness.publicKeyMultibase}` }] },
    } as never);
    this.log = r.log as unknown as Array<Record<string, unknown>>;
    this.witness = [{ versionId: this.versionId, proof: [await createWitnessProof(witness, this.versionId)] }];
    return this.versionId;
  }

  get versionId(): string {
    return this.log[this.log.length - 1].versionId as string;
  }

  /** Where the DID lives now: the latest document's id. */
  get location(): string {
    return (this.log[this.log.length - 1].state as { id: string }).id;
  }

  evidence(): AuthorDidEvidence {
    return { did: this.did, log: serializeLog(this.log as unknown as LogEntry[]), ...(this.witness ? { witness: this.witness } : {}) };
  }

  /** The identity DID, the method's absolute id at `versionId`, and that version (P5.14). */
  ref(fragment: string, versionId = this.versionId): AuthorRef {
    const at = (this.log.find((e) => e.versionId === versionId)!.state as { id: string }).id;
    return { did: this.did, verificationMethod: `${at}#${fragment}`, versionId };
  }

  signer(ref: AuthorRef, secret: Uint8Array): OriginalsSigner {
    return keySigner({ keyType: "Ed25519", secretKey: secret, verificationMethod: ref.verificationMethod });
  }
}
