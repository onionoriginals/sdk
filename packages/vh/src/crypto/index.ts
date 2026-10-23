/**
 * Encodings and the two cryptosuites the Originals Protocol permits (P5.12).
 *
 * - `eddsa-jcs-2022`: W3C Data Integrity EdDSA Cryptosuites v1.0, section 3.3.
 *   hashData = sha256(JCS(proofConfig)) ‖ sha256(JCS(document)), signed with Ed25519.
 * - `bip340-jcs-2025`: Data Integrity BIP340 Cryptosuite v0.1, section 3.3.
 *   hashData = sha256(sha256(JCS(proofConfig)) ‖ sha256(JCS(document))), signed
 *   with BIP340 Schnorr. Keys are 33-byte compressed secp256k1 Multikeys
 *   (0xe701); BIP340 uses their x coordinate. The draft's data-model section
 *   says base64url for proofValue but its algorithms say base58btc multibase;
 *   this follows the algorithms (spec finding S6), as @did-btcr2/cryptosuite does.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { OriginalsError, fail } from "../errors.js";
import { canonicalBytes, isJsonObject, type JsonObject, type JsonValue } from "../json/index.js";

// ---------------------------------------------------------------------------
// multibase / multihash

export function base58btcEncode(bytes: Uint8Array): string {
  return base58.encode(bytes);
}

export function base58btcDecode(text: string): Uint8Array {
  try {
    return base58.decode(text);
  } catch {
    return fail("invalid-evidence", "MULTIBASE_INVALID", "value is not base58btc");
  }
}

/** Multibase, base58btc only (prefix `z`). */
export function multibaseEncode(bytes: Uint8Array): string {
  return `z${base58.encode(bytes)}`;
}

export function multibaseDecode(text: string): Uint8Array {
  if (typeof text !== "string" || !text.startsWith("z")) {
    fail("invalid-evidence", "MULTIBASE_UNSUPPORTED", "only base58btc multibase (z) is accepted");
  }
  return base58btcDecode(text.slice(1));
}

const SHA2_256 = 0x12;

/** sha2-256 multihash: 0x12 0x20 ‖ digest. */
export function sha256Multihash(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(34);
  out[0] = SHA2_256;
  out[1] = 32;
  out.set(sha256(bytes), 2);
  return out;
}

/**
 * Decode a sha2-256 multihash and return its digest. Any other algorithm is
 * outside every profile in this package (VH-Log 1.0 permits SHA-256 only).
 */
export function decodeSha256Multihash(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 2) fail("invalid-evidence", "MULTIHASH_INVALID", "multihash is truncated");
  if (bytes[0] !== SHA2_256) fail("unsupported-profile", "MULTIHASH_UNSUPPORTED", `multihash code 0x${bytes[0].toString(16)} is not sha2-256`);
  if (bytes[1] !== 32 || bytes.length !== 34) fail("invalid-evidence", "MULTIHASH_INVALID", "sha2-256 multihash must carry 32 bytes");
  return bytes.slice(2);
}

export { sha256 };

// ---------------------------------------------------------------------------
// Multikey

export type KeyType = "Ed25519" | "secp256k1";

const MULTICODEC: Record<KeyType, { prefix: [number, number]; length: number }> = {
  Ed25519: { prefix: [0xed, 0x01], length: 32 },
  secp256k1: { prefix: [0xe7, 0x01], length: 33 },
};

export interface DecodedMultikey {
  type: KeyType;
  publicKey: Uint8Array;
}

export function encodeMultikey(type: KeyType, publicKey: Uint8Array): string {
  const { prefix } = MULTICODEC[type];
  return multibaseEncode(new Uint8Array([...prefix, ...publicKey]));
}

/**
 * Decode a public-key Multikey: Ed25519 (32 bytes) or compressed secp256k1
 * (33 bytes, prefix 02 or 03). Decoding is syntactic; whether the bytes are an
 * admissible point is decided when a proof is verified (vh-log-interop-0 §2).
 */
export function decodeMultikey(publicKeyMultibase: string): DecodedMultikey {
  if (typeof publicKeyMultibase !== "string") fail("invalid-evidence", "MULTIKEY_INVALID", "publicKeyMultibase must be a string");
  const bytes = multibaseDecode(publicKeyMultibase);
  for (const type of Object.keys(MULTICODEC) as KeyType[]) {
    const { prefix, length } = MULTICODEC[type];
    if (bytes[0] !== prefix[0] || bytes[1] !== prefix[1]) continue;
    const publicKey = bytes.slice(2);
    if (publicKey.length !== length) fail("invalid-evidence", "MULTIKEY_INVALID", `${type} Multikey must carry ${length} bytes`);
    if (type === "secp256k1" && publicKey[0] !== 2 && publicKey[0] !== 3) {
      fail("invalid-evidence", "MULTIKEY_INVALID", "secp256k1 Multikey must be compressed");
    }
    return { type, publicKey };
  }
  return fail("unsupported-profile", "MULTIKEY_UNSUPPORTED", "Multikey is neither Ed25519 nor secp256k1");
}

/**
 * The Multikey named by a did:key verification method of the form
 * `did:key:<multibase>#<multibase>`, with the two values equal (did:vh, did:webvh).
 * The key is recovered only by decoding; nothing is resolved.
 *
 * With `fragment: "optional"`, a bare `did:key:<multibase>` is accepted too:
 * VH-Log only requires an entry proof's verificationMethod to resolve to an
 * active update key ("Authorized Keys"), and didwebvh-ts signers name their key
 * that way. Witness proofs keep the fragment, which did:webvh requires.
 */
export function didKeyMultikey(verificationMethod: string, options: { fragment?: "required" | "optional" } = {}): string {
  const match = typeof verificationMethod === "string" ? /^did:key:(z[1-9A-HJ-NP-Za-km-z]+)(?:#(z[1-9A-HJ-NP-Za-km-z]+))?$/.exec(verificationMethod) : null;
  const fragmentOk = match && (match[2] === undefined ? options.fragment === "optional" : match[1] === match[2]);
  if (!match || !fragmentOk) {
    fail("invalid-evidence", "DID_KEY_INVALID", "verification method must be did:key:<multikey>#<multikey>");
  }
  decodeMultikey(match[1]);
  return match[1];
}

/** The did:key DID (no fragment) for a Multikey. */
export function didKeyOf(publicKeyMultibase: string): string {
  decodeMultikey(publicKeyMultibase);
  return `did:key:${publicKeyMultibase}`;
}

// ---------------------------------------------------------------------------
// Ed25519 verification

const ED_P = 2n ** 255n - 19n;
const ED_L = 2n ** 252n + 27742317777372353535851937790883648493n;
/** y coordinates of the eight small-order points; masking the sign bit covers all 14 encodings. */
const SMALL_ORDER_Y = new Set([
  0n,
  1n,
  2707385501144840649318225287225658788936804267575313519463743609750303402022n,
  55188659117513257062467267217118295137698188065244968500265048394206261417927n,
  ED_P - 1n,
]);

function littleEndian(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

function admissiblePoint(bytes: Uint8Array): boolean {
  const y = littleEndian(bytes) & ((1n << 255n) - 1n);
  return y < ED_P && !SMALL_ORDER_Y.has(y);
}

/**
 * Ed25519 verification under RFC 8032 with the vh-log-interop-0 acceptance
 * rules: canonical encodings of A and R, neither of small order, S < L, and the
 * uncofactored equation [S]B = R + [k]A with k = SHA-512(R ‖ A ‖ M) mod L.
 * noble's own verify uses the cofactored equation, which accepts signatures
 * with a low-order residue, so the equation is checked here. Only public data
 * is involved, so variable-time arithmetic is acceptable.
 */
export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const rBytes = signature.subarray(0, 32);
  const s = littleEndian(signature.subarray(32));
  if (!admissiblePoint(publicKey) || !admissiblePoint(rBytes) || s >= ED_L) return false;
  try {
    const A = ed25519.Point.fromBytes(publicKey, false);
    const R = ed25519.Point.fromBytes(rBytes, false);
    const hashInput = new Uint8Array(64 + message.length);
    hashInput.set(rBytes, 0);
    hashInput.set(publicKey, 32);
    hashInput.set(message, 64);
    const k = littleEndian(sha512(hashInput)) % ED_L;
    return ed25519.Point.BASE.multiplyUnsafe(s).equals(R.add(A.multiplyUnsafe(k)));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Data Integrity proofs

export type CryptosuiteName = "eddsa-jcs-2022" | "bip340-jcs-2025";

export const CRYPTOSUITES: Readonly<Record<CryptosuiteName, KeyType>> = Object.freeze({
  "eddsa-jcs-2022": "Ed25519",
  "bip340-jcs-2025": "secp256k1",
});

export interface DataIntegrityProof {
  type: "DataIntegrityProof";
  cryptosuite: string;
  verificationMethod: string;
  proofPurpose: string;
  proofValue: string;
  created?: string;
  "@context"?: JsonValue;
  [member: string]: JsonValue | undefined;
}

/** Members Data Integrity defines for a proof. Anything else is rejected (P5.7). */
const PROOF_MEMBERS = new Set([
  "@context", "id", "type", "cryptosuite", "verificationMethod", "proofPurpose",
  "created", "expires", "domain", "challenge", "nonce", "previousProof", "proofValue",
]);

export function isCryptosuite(name: unknown): name is CryptosuiteName {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(CRYPTOSUITES, name);
}

function requireSuite(name: unknown): CryptosuiteName {
  if (!isCryptosuite(name)) {
    fail("unsupported-profile", "CRYPTOSUITE_UNSUPPORTED", `cryptosuite ${JSON.stringify(name)} is not permitted`);
  }
  return name;
}

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Build the proof configuration: the proof without proofValue, with the
 * document's @context. `created` is checked only when creating a proof, where
 * Data Integrity raises PROOF_GENERATION_ERROR; a verifier accepts any value
 * (vh-log-interop-0 section 2), since it is covered by the signature anyway.
 */
function proofConfig(document: JsonObject, options: JsonObject, creating = false): JsonObject {
  const config: JsonObject = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || key === "proofValue") continue;
    if (!PROOF_MEMBERS.has(key)) fail("invalid-evidence", "PROOF_UNKNOWN_MEMBER", `proof member ${JSON.stringify(key)} is not defined by Data Integrity`);
    config[key] = value;
  }
  if (config.type !== "DataIntegrityProof") fail("invalid-evidence", "PROOF_INVALID", "proof type must be DataIntegrityProof");
  requireSuite(config.cryptosuite);
  if (typeof config.verificationMethod !== "string" || typeof config.proofPurpose !== "string") {
    fail("invalid-evidence", "PROOF_INVALID", "proof needs verificationMethod and proofPurpose strings");
  }
  if (creating && config.created !== undefined && (typeof config.created !== "string" || !DATE_TIME.test(config.created))) {
    fail("invalid-evidence", "PROOF_INVALID", "proof created must be an XML Schema dateTime");
  }
  if (document["@context"] !== undefined && config["@context"] === undefined) config["@context"] = document["@context"];
  return config;
}

function withoutUndefined(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

/**
 * The bytes a signer signs for `document` under the proof `options`
 * (everything in the proof except proofValue).
 */
export function proofHashData(document: JsonObject, options: Omit<DataIntegrityProof, "proofValue"> | DataIntegrityProof): Uint8Array {
  if (!isJsonObject(document)) fail("invalid-evidence", "PROOF_INVALID", "document must be a JSON object");
  const unsecured = withoutUndefined(document);
  delete unsecured.proof;
  const config = proofConfig(unsecured, options as JsonObject);
  const configHash = sha256(canonicalBytes(config));
  const documentHash = sha256(canonicalBytes(unsecured));
  const joined = new Uint8Array(64);
  joined.set(configHash, 0);
  joined.set(documentHash, 32);
  return config.cryptosuite === "bip340-jcs-2025" ? sha256(joined) : joined;
}

/** Something that can sign hash data for one Multikey. */
export interface ProofSigner {
  readonly keyType: KeyType;
  readonly publicKeyMultibase: string;
  sign(hashData: Uint8Array): Promise<Uint8Array>;
}

/** Create a proof over `document` (which must not contain `proof`). */
export async function createProof(
  document: JsonObject,
  options: Omit<DataIntegrityProof, "proofValue"> | DataIntegrityProof,
  signer: ProofSigner,
): Promise<DataIntegrityProof> {
  const suite = requireSuite((options as JsonObject).cryptosuite);
  if (CRYPTOSUITES[suite] !== signer.keyType) {
    fail("unsupported-profile", "CRYPTOSUITE_KEY_MISMATCH", `${suite} needs a ${CRYPTOSUITES[suite]} key`);
  }
  const unsecured = withoutUndefined(document);
  const config = proofConfig(unsecured, options as JsonObject, true);
  const signature = await signer.sign(proofHashData(unsecured, config));
  return { ...(config as DataIntegrityProof), proofValue: multibaseEncode(signature) };
}

/**
 * Verify `proof` over `document` with `publicKeyMultibase`. Returns false for a
 * bad signature; throws for a proof or key this package does not accept, so an
 * unsupported suite is never mistaken for a merely invalid one.
 */
export function verifyProof(document: JsonObject, proof: DataIntegrityProof, publicKeyMultibase: string): boolean {
  if (!isJsonObject(proof)) fail("invalid-evidence", "PROOF_INVALID", "proof must be an object");
  const suite = requireSuite(proof.cryptosuite);
  const key = decodeMultikey(publicKeyMultibase);
  if (CRYPTOSUITES[suite] !== key.type) {
    fail("unsupported-profile", "CRYPTOSUITE_KEY_MISMATCH", `${suite} needs a ${CRYPTOSUITES[suite]} key`);
  }
  if (typeof proof.proofValue !== "string") fail("invalid-evidence", "PROOF_INVALID", "proof needs a proofValue string");
  const unsecured = withoutUndefined(document);
  delete unsecured.proof;
  const options = withoutUndefined(proof);
  delete options.proofValue;
  if (options["@context"] !== undefined) {
    // Data Integrity: the document's @context must start with the proof's.
    const proofContext = ([] as JsonValue[]).concat(options["@context"]);
    const documentContext = ([] as JsonValue[]).concat(unsecured["@context"] ?? []);
    const prefix = documentContext.slice(0, proofContext.length);
    if (JSON.stringify(prefix) !== JSON.stringify(proofContext)) return false;
    unsecured["@context"] = options["@context"];
  }
  let signature: Uint8Array;
  try {
    signature = multibaseDecode(proof.proofValue);
  } catch (error) {
    if (error instanceof OriginalsError) return false;
    throw error;
  }
  if (signature.length !== 64) return false;
  const data = proofHashData(unsecured, options);
  try {
    return key.type === "Ed25519"
      ? verifyEd25519(key.publicKey, data, signature)
      : schnorr.verify(signature, data, key.publicKey.slice(1));
  } catch {
    return false;
  }
}

/** A signer holding raw secret key bytes. For tests and local custody only. */
export function localSigner(keyType: KeyType, secretKey: Uint8Array): ProofSigner {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32) {
    fail("invalid-evidence", "SECRET_KEY_INVALID", "secret key must be 32 bytes");
  }
  const secret = secretKey.slice();
  const publicKey = keyType === "Ed25519" ? ed25519.getPublicKey(secret) : secp256k1.getPublicKey(secret, true);
  return {
    keyType,
    publicKeyMultibase: encodeMultikey(keyType, publicKey),
    sign: (hashData) =>
      Promise.resolve(keyType === "Ed25519" ? ed25519.sign(hashData, secret) : schnorr.sign(hashData, secret)),
  };
}
