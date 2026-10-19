/** Test helpers for the Originals SDK: a did:vh author DID with one author key. */
import { localSigner, type ProofSigner } from "@originals/vh/crypto";
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
