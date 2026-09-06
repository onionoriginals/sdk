import { ed25519 } from "@noble/curves/ed25519.js";
import { p256, p384 } from "@noble/curves/nist.js";
import { base58, base64urlnopad } from "@scure/base";
import { randomBytes } from "@noble/hashes/utils.js";
import { canonicalizeValue } from "./values.js";
import { CelError, requireThat } from "./errors.js";
import {
  ALGORITHMS,
  decodeBase58,
  decodeController,
  hashJson,
} from "./primitives.js";
import { validateEntry, validateEvent } from "./profile.js";
import type {
  ControllerProof,
  CelEvent,
  Algorithm,
  CelEntry,
} from "./types.js";

/** Cryptographic preimage only: does not establish proof purpose, authorization or profile acceptance. */
export function jcsSigningMessage(
  document: unknown,
  configuration: unknown,
  algorithm: Algorithm,
): Uint8Array {
  requireThat(
    Object.prototype.hasOwnProperty.call(ALGORITHMS, algorithm),
    "CEL_ALGORITHM",
    "Unsupported signing algorithm",
  );
  const hash = ALGORITHMS[algorithm].hash,
    utf8 = new TextEncoder();
  return Uint8Array.from([
    ...hash(utf8.encode(canonicalizeValue(configuration))),
    ...hash(utf8.encode(canonicalizeValue(document))),
  ]);
}

/** Verify a cryptographic known answer. Call verifyEntry/verifyHistory for profile and authority checks. */
export function verifyJcsSignature(
  document: unknown,
  configuration: unknown,
  signature: Uint8Array,
  controller: string,
): boolean {
  const key = decodeController(controller),
    bytes = jcsSigningMessage(document, configuration, key.algorithm);
  return key.algorithm === "Ed25519"
    ? ed25519.verify(signature, bytes, key.publicKey, { zip215: false })
    : (key.algorithm === "P-256" ? p256 : p384).verify(
        signature,
        bytes,
        key.publicKey,
        { prehash: true, lowS: false },
      );
}

/** Authenticate every supplied proof. The history fold separately enforces controller authority. */
export function verifyEntry(input: unknown): {
  digest: string;
  signers: string[];
} {
  const entry = validateEntry(input),
    proofs = Array.isArray(entry.proof) ? entry.proof : [entry.proof];
  const signers = proofs.map((proof) => {
    const controller = proof.verificationMethod.split("#")[0];
    const { proofValue, ...configuration } = proof;
    const valid = verifyJcsSignature(
      entry.event,
      configuration,
      decodeBase58(proofValue),
      controller,
    );
    requireThat(valid, "CEL_SIGNATURE", "Invalid controller signature");
    return controller;
  });
  return { digest: hashJson(entry.event), signers };
}

/** Explicit cryptosuite signer. The callback signs the message bytes using the selected suite's message algorithm. */
export interface CelSigner {
  readonly algorithm: Algorithm;
  readonly controller: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/** Create a local signer; the secret is copied and never included in exported documents. */
export function createLocalSigner(
  algorithm: Algorithm,
  secretKey: Uint8Array,
): CelSigner {
  if (!Object.prototype.hasOwnProperty.call(ALGORITHMS, algorithm))
    throw new CelError(
      "unsupported",
      "CEL_ALGORITHM",
      "Unsupported signing algorithm",
    );
  requireThat(
    secretKey instanceof Uint8Array,
    "CEL_KEY",
    "Expected secret key bytes",
  );
  const secret = new Uint8Array(secretKey),
    spec = ALGORITHMS[algorithm];
  let publicKey: Uint8Array;
  try {
    publicKey = (
      algorithm === "Ed25519" ? ed25519 : algorithm === "P-256" ? p256 : p384
    ).getPublicKey(secret);
  } catch {
    throw new CelError("invalid", "CEL_KEY", "Invalid secret key");
  }
  const controller =
    "did:key:z" + base58.encode(Uint8Array.from([...spec.codec, ...publicKey]));
  decodeController(controller);
  return Object.freeze({
    algorithm,
    controller,
    sign: (message: Uint8Array): Promise<Uint8Array> =>
      Promise.resolve(
        algorithm === "Ed25519"
          ? ed25519.sign(message, secret)
          : (algorithm === "P-256" ? p256 : p384).sign(message, secret, {
              prehash: true,
              lowS: false,
            }),
      ),
  });
}

/** Generate the profile's fresh 16-byte creation nonce. */
export function createNonce(): string {
  return base64urlnopad.encode(randomBytes(16));
}

/** Sign a copied, validated event and locally verify the returned proof before returning success. */
export async function signEvent(
  input: unknown,
  signer: CelSigner,
  options: { created?: string } = {},
): Promise<CelEntry & { proof: ControllerProof[] }> {
  const event: CelEvent = validateEvent(input);
  const controller = signer.controller,
    algorithm = signer.algorithm;
  const key = decodeController(controller);
  if (!Object.prototype.hasOwnProperty.call(ALGORITHMS, algorithm))
    throw new CelError(
      "unsupported",
      "CEL_ALGORITHM",
      "Unsupported signing algorithm",
    );
  requireThat(
    key.algorithm === algorithm,
    "CEL_SIGNER",
    "Configured signer algorithm does not match its controller",
  );
  const spec = ALGORITHMS[algorithm];
  const configuration = {
    type: "DataIntegrityProof" as const,
    cryptosuite: spec.suite,
    verificationMethod: key.verificationMethod,
    proofPurpose: "assertionMethod" as const,
    created: options.created ?? new Date().toISOString(),
  };
  // Validate options before invoking a remote signer. The temporary value is never returned.
  validateEntry({
    event,
    proof: [
      {
        ...configuration,
        proofValue: "z" + base58.encode(new Uint8Array(spec.signature)),
      },
    ],
  });
  const signature = await signer.sign(
    jcsSigningMessage(event, configuration, algorithm),
  );
  requireThat(
    signature instanceof Uint8Array && signature.length === spec.signature,
    "CEL_SIGNER",
    "Signer returned an invalid signature",
  );
  const entry = {
    event,
    proof: [{ ...configuration, proofValue: "z" + base58.encode(signature) }],
  };
  verifyEntry(entry);
  return entry;
}
