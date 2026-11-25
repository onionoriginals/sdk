/**
 * The author's key file for did:og anchoring. It holds two Ed25519 secrets:
 * the did:webvh update key, which signs the author DID's own log, and the
 * assertion key, which signs the Original's entries. They must differ: an
 * entry's key may not be an updateKey of the author DID's own log (P5.3,
 * P5.11). The file is written with mode 0600 and is never printed, logged or
 * written anywhere else.
 */
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { localSigner, type ProofSigner } from "@originals/vh/crypto";

export const KEY_FILE_TYPE = "originals-author-keys/1";

export interface AuthorKeys {
  update: ProofSigner;
  assertion: ProofSigner;
}

function signers(update: Uint8Array, assertion: Uint8Array): AuthorKeys {
  const keys = { update: localSigner("Ed25519", update), assertion: localSigner("Ed25519", assertion) };
  if (keys.update.publicKeyMultibase === keys.assertion.publicKeyMultibase) throw new Error("the update key and the assertion key must differ (P5.3)");
  return keys;
}

/** Generate a new key file at `path`. Refuses to overwrite an existing file. */
export function generateKeyFile(path: string): AuthorKeys {
  if (existsSync(path)) throw new Error(`${path} exists; refusing to overwrite a key file`);
  const update = new Uint8Array(randomBytes(32));
  const assertion = new Uint8Array(randomBytes(32));
  writeFileSync(path, JSON.stringify({ type: KEY_FILE_TYPE, update: bytesToHex(update), assertion: bytesToHex(assertion) }) + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return signers(update, assertion);
}

/** Read a key file. Warns (returns a warning) when the file is readable by others. */
export function readKeyFile(path: string): { keys: AuthorKeys; warning?: string } {
  const mode = statSync(path).mode & 0o777;
  const raw = JSON.parse(readFileSync(path, "utf8")) as { type?: string; update?: string; assertion?: string };
  if (raw.type !== KEY_FILE_TYPE || typeof raw.update !== "string" || typeof raw.assertion !== "string" || !/^[0-9a-f]{64}$/.test(raw.update) || !/^[0-9a-f]{64}$/.test(raw.assertion)) {
    throw new Error(`${path} is not an ${KEY_FILE_TYPE} key file`);
  }
  return {
    keys: signers(hexToBytes(raw.update), hexToBytes(raw.assertion)),
    warning: mode & 0o077 ? `${path} is readable by other users (mode ${mode.toString(8)}); chmod 600 it` : undefined,
  };
}
