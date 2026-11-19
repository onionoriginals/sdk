/**
 * Local did:vh identities for delegates and contributors (plan 049, PROVISIONAL
 * K10; development use: key custody is outside the protocol, originals-spec
 * #46). The DID's own update key is separate from the key that signs entries,
 * which is an `assertionMethod` key and never an update key (P5.3, P5.11).
 */
import { localSigner } from "@originals/vh/crypto";
import { isJsonObject, parseJson } from "@originals/vh/json";
import { createLog, parseLog, serializeLog, signWith, type EntrySigner, type LogEntry } from "@originals/vh/log";
import type { AuthorDidEvidence, AuthorRef } from "@originals/vh/originals";
import { codeError } from "./errors.js";

/** PROVISIONAL (K10): the fragment of the entry-signing key. */
export const SIGNING_FRAGMENT = "code-1";
export const IDENTITY_FORMAT = "originals-code-identity/0.1";

export interface LocalIdentity {
  did: string;
  /** The DID's own did:vh log (`did.jsonl`). */
  log: string;
  /** The DID log's update key. It never signs an asset entry (P5.11). */
  updateSecret: Uint8Array;
  /** The `assertionMethod` key that signs entries (P5.3). */
  signingSecret: Uint8Array;
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
function fromHex(h: unknown): Uint8Array {
  if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) return codeError("invalid-evidence", "IDENTITY_FILE", "a secret is 64 lowercase hex digits");
  return Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
}

function randomSecret(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

/** Create a did:vh identity with a separate update key and signing key. */
export async function createLocalIdentity(options: { updateSecret?: Uint8Array; signingSecret?: Uint8Array; now?: number } = {}): Promise<LocalIdentity> {
  const updateSecret = options.updateSecret ?? randomSecret();
  const signingSecret = options.signingSecret ?? randomSecret();
  const update = localSigner("Ed25519", updateSecret);
  const signing = localSigner("Ed25519", signingSecret);
  if (update.publicKeyMultibase === signing.publicKeyMultibase) codeError("invalid-evidence", "IDENTITY_KEYS", "the signing key must not be the update key (P5.11)");
  const did = "did:vh:{SCID}";
  const vm = `${did}#${SIGNING_FRAGMENT}`;
  const k = update.publicKeyMultibase;
  const genesis = await createLog({
    versionTime: new Date(Math.floor((options.now ?? Date.now()) / 1000) * 1000).toISOString().replace(".000Z", "Z"),
    parameters: { method: "did:vh:1.0", scid: "{SCID}", updateKeys: [k] },
    state: {
      "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
      id: did,
      verificationMethod: [{ id: vm, type: "Multikey", controller: did, publicKeyMultibase: signing.publicKeyMultibase }],
      assertionMethod: [vm],
    },
    sign: signWith(update, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${k}#${k}` }),
  });
  return { did: genesis.state.id as string, log: serializeLog([genesis]), updateSecret, signingSecret };
}

function entries(identity: Pick<LocalIdentity, "log">): LogEntry[] {
  return parseLog(identity.log) as unknown as LogEntry[];
}

/** The author or editor reference for entries this identity signs: its signing key at its latest version (P5.1). */
export function identityRef(identity: Pick<LocalIdentity, "did" | "log">): AuthorRef {
  const list = entries(identity);
  const last = list[list.length - 1];
  return { did: identity.did, verificationMethod: `${identity.did}#${SIGNING_FRAGMENT}`, versionId: last.versionId };
}

/** Signs entries with the identity's signing key (`eddsa-jcs-2022`, P5.12). */
export function identitySigner(identity: Pick<LocalIdentity, "did" | "signingSecret">): EntrySigner {
  return signWith(localSigner("Ed25519", identity.signingSecret), { cryptosuite: "eddsa-jcs-2022", verificationMethod: `${identity.did}#${SIGNING_FRAGMENT}` });
}

/** The identity's DID history as evidence. `obtainedAt` is reported, never guessed (P7.10). */
export function identityEvidence(identity: Pick<LocalIdentity, "did" | "log">, obtainedAt?: string): AuthorDidEvidence {
  return { did: identity.did, log: identity.log, source: "supplied", ...(obtainedAt ? { obtainedAt } : {}) };
}

/** The identity file: the DID, its log and both secrets. Keep it private. */
export function serializeIdentity(identity: LocalIdentity): string {
  return `${JSON.stringify({ format: IDENTITY_FORMAT, did: identity.did, log: identity.log, updateSecret: toHex(identity.updateSecret), signingSecret: toHex(identity.signingSecret) }, null, 2)}\n`;
}

export function parseIdentity(text: string): LocalIdentity {
  const v = parseJson(text);
  if (!isJsonObject(v) || v.format !== IDENTITY_FORMAT || typeof v.did !== "string" || typeof v.log !== "string") {
    codeError("invalid-evidence", "IDENTITY_FILE", `not an ${IDENTITY_FORMAT} file`);
  }
  return { did: v.did, log: v.log, updateSecret: fromHex(v.updateSecret), signingSecret: fromHex(v.signingSecret) };
}

/** The identity's public part only: its DID and log. */
export function publicIdentity(identity: LocalIdentity): Pick<LocalIdentity, "did" | "log"> {
  return { did: identity.did, log: identity.log };
}
