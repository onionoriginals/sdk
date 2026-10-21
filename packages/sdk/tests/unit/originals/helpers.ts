/** Test helpers for the Originals SDK: a did:vh author DID with one author key. */
import { ed25519 } from "@noble/curves/ed25519.js";
import { localSigner, multibaseEncode, type ProofSigner } from "@originals/vh/crypto";
import * as W from "didwebvh-ts";
import type { JsonObject } from "@originals/vh/json";
import { appendEntry, createLog, serializeLog, signWith, type LogEntry } from "@originals/vh/log";
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

  async rotate(keys: Array<{ fragment: string; secret: Uint8Array }>) {
    this.entries.push(await appendEntry(this.entries[this.entries.length - 1], {
      versionTime: this.time(), parameters: {}, state: this.document(this.did, keys), sign: this.signUpdate(),
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
 * A did:webvh author DID written by didwebvh-ts (did:webvh 1.0), so a move is
 * a real did:webvh portability move (P5.14): `portable` at genesis, then an
 * update to another domain, which didwebvh-ts records with the prior DID in
 * `alsoKnownAs`. Its verification methods keep relative ids, and a move keeps
 * each method's `controller`, as didwebvh-ts writes them. `did` is the
 * identity DID, the DID at genesis.
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

  private methods(keys: Array<{ fragment: string; secret: Uint8Array }>) {
    return keys.map((k) => ({ id: `#${k.fragment}`, type: "Multikey", publicKeyMultibase: localSigner("Ed25519", k.secret).publicKeyMultibase, purpose: "assertionMethod" as const }));
  }

  static async create(domain: string, keys: Array<{ fragment: string; secret: Uint8Array }>): Promise<WebvhIdentity> {
    const a = new WebvhIdentity();
    const created = await W.createDID({
      domain, signer: a.updateSigner(), verifier: a.verifier, updateKeys: [a.update.publicKeyMultibase], portable: true,
      verificationMethods: a.methods(keys), created: a.time(),
    } as never);
    a.log = created.log as unknown as Array<Record<string, unknown>>;
    a.did = created.did;
    return a;
  }

  /** Move to another domain under did:webvh portability. */
  async move(domain: string): Promise<string> {
    const r = await W.updateDID({ log: this.log as never, signer: this.updateSigner(), verifier: this.verifier, domain, updated: this.time() } as never);
    this.log = r.log as unknown as Array<Record<string, unknown>>;
    return this.versionId;
  }

  /** Replace the assertion keys (rotation, P5.10). */
  async rotate(keys: Array<{ fragment: string; secret: Uint8Array }>): Promise<string> {
    const r = await W.updateDID({ log: this.log as never, signer: this.updateSigner(), verifier: this.verifier, verificationMethods: this.methods(keys), updated: this.time() } as never);
    this.log = r.log as unknown as Array<Record<string, unknown>>;
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
    return { did: this.did, log: serializeLog(this.log as unknown as LogEntry[]) };
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
