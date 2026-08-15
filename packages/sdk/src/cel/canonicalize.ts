import { sha256 } from '@noble/hashes/sha2.js';

/**
 * CEL Event Canonicalization
 *
 * Provides a single, correct serialization for CEL event hashing and signing.
 *
 * WARNING: The pattern `JSON.stringify(x, Object.keys(x).sort())` is NOT
 * equivalent to JCS and must NOT be used here. When the second argument to
 * JSON.stringify is an array it acts as a property allowlist applied at every
 * nesting level — any key not present in the top-level key list is silently
 * dropped from nested objects. This means nested data fields, resource
 * metadata, and even `proofValue` inside a `proof` array are omitted from the
 * hash input, defeating the security properties of the hash chain.
 * Always use `canonicalizeEvent` instead.
 */

/**
 * Canonicalizes a value to JCS-style JSON (lexicographically sorted keys at
 * every nesting level) and returns UTF-8 bytes. This is the single
 * serialization used for CEL event hashing and signing.
 *
 * @param data - The value to canonicalize (any JSON-serializable type)
 * @returns UTF-8 encoded bytes of the canonical JSON representation
 */
export function canonicalizeEvent(data: unknown): Uint8Array {
  // JCS uses JSON with lexicographically sorted keys at every nesting level.
  // The replacer function recurses into every object (but leaves arrays and
  // primitives untouched), so no key at any depth is ever dropped.
  const json = JSON.stringify(data, (_, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value).sort().reduce((sorted: Record<string, unknown>, key) => {
        sorted[key] = value[key];
        return sorted;
      }, {});
    }
    return value;
  });
  return new TextEncoder().encode(json);
}

/**
 * Returns the exact bytes a witness must sign when attesting to a CEL event
 * (issue #314). `witnessEvent` hands `witness.witness(digestMultibase)` only
 * the Multibase digest *string* (from `computeDigestMultibase`), and
 * verification (`verifyEventLog` → `dispatchVerify`) checks the witness
 * signature against `canonicalizeEvent(digestMultibase)` — i.e. the UTF-8
 * bytes of the JSON-*quoted* digest (`"uEiD…"`, surrounding quotes INCLUDED),
 * not the raw digest bytes.
 *
 * This convention is easy to get subtly wrong: a third-party witness that
 * signs the decoded digest bytes, or the unquoted string, produces a proof
 * that fails verification with no hint why. Expose the contract as a helper so
 * external witness implementations can sign the correct preimage:
 *
 * @example
 * ```typescript
 * const message = witnessSigningBytes(digestMultibase); // bytes to sign
 * const proofValue = multibaseEncode(await ed25519.sign(message, privateKey));
 * ```
 *
 * @param digestMultibase - The Multibase-encoded event digest to attest to
 *   (exactly the value passed to `WitnessService.witness`).
 * @returns UTF-8 bytes of the canonical (JSON-quoted) digest — the witness
 *   signature preimage.
 */
export function witnessSigningBytes(digestMultibase: string): Uint8Array {
  return canonicalizeEvent(digestMultibase);
}

/**
 * Extracts the *committed* fields of a log entry — exactly the message the
 * signer signs (`{ type, data, previousEvent? }`) — and canonicalizes them for
 * use as the hash-chain preimage.
 *
 * The `proof` array is deliberately excluded. It carries both the signature
 * (`proofValue`) and unsigned, mutable metadata (`created`, `type`,
 * `cryptosuite`, `verificationMethod`, `proofPurpose`, and witness proofs that
 * may be appended after the fact). None of those metadata fields are part of
 * the signed message, so chaining over them would make the chain link depend
 * on data that no signature commits to: a mutation of `proof.created` or
 * `proof.verificationMethod` would "break" the chain even though it was never
 * provable in the first place, and appending a (non-gating) witness proof to a
 * prior event would retroactively break every later link. The chain must
 * depend only on the committed fields.
 *
 * `previousEvent` is omitted when absent so the preimage of a first event is
 * `{ type, data }`, matching what the verifier reconstructs.
 *
 * @param entry - A log entry (only `type`, `data`, `previousEvent` are read)
 * @returns UTF-8 encoded bytes of the canonical committed payload
 */
export function canonicalizeEntryForChain(
  entry: { type: unknown; data: unknown; previousEvent?: unknown }
): Uint8Array {
  return canonicalizeEvent(committedFields(entry));
}

/**
 * The committed subset of a log entry — `{ type, data, previousEvent? }` — as
 * a plain object. The signature and the chain link both cover exactly this;
 * the `proof` array is excluded (see {@link canonicalizeEntryForChain}).
 *
 * `previousEvent` is omitted when absent so a first event's payload is
 * `{ type, data }`, matching what the verifier reconstructs.
 */
export function committedFields(
  entry: { type: unknown; data: unknown; previousEvent?: unknown }
): { type: unknown; data: unknown; previousEvent?: unknown } {
  const committed: { type: unknown; data: unknown; previousEvent?: unknown } = {
    type: entry.type,
    data: entry.data,
  };
  if (entry.previousEvent !== undefined) {
    committed.previousEvent = entry.previousEvent;
  }
  return committed;
}

/**
 * The CEL proof signing input (plan 042): `sha256(JCS(proofConfig)) ||
 * sha256(JCS(committedEvent))`, mirroring the W3C Data Integrity hashing step.
 *
 * The proof CONFIGURATION is bound into the signature. Before 042 the signer
 * signed the event alone, so `created`, `verificationMethod`, `proofPurpose`
 * and even `cryptosuite` were unattested: they could be edited after the fact
 * without invalidating anything. `created` in particular was a freely
 * forgeable timestamp sitting inside a structure whose whole purpose is
 * tamper-evidence.
 *
 * Binding the configuration also makes the two constructions mutually
 * exclusive, which is what lets the verifier dispatch on `cryptosuite` safely:
 * relabelling a legacy proof to the new suite breaks it (the legacy signature
 * does not cover the config), and relabelling a new proof to the legacy suite
 * breaks it too (the legacy preimage is not what was signed). Both directions
 * fail closed.
 *
 * The payload is canonicalized AS GIVEN rather than reshaped: this primitive
 * also secures the proofless did:btco documents that authenticate a competing
 * anchoring, which are not events and would be destroyed by forcing the
 * `{ type, data, previousEvent }` shape onto them. Callers pass exactly the
 * bytes they mean, on both the signing and verifying side.
 *
 * @param payload - the object the proof attests to (for an event, its
 *   committed fields — `{ type, data, previousEvent? }`)
 * @param proofConfig - the proof WITHOUT `proofValue`
 */
export function celProofSigningInput(
  payload: unknown,
  proofConfig: Record<string, unknown>
): Uint8Array {
  const config = { ...proofConfig };
  delete config.proofValue;
  const configHash = sha256(canonicalizeEvent(config));
  const eventHash = sha256(canonicalizeEvent(payload));
  const out = new Uint8Array(configHash.length + eventHash.length);
  out.set(configHash, 0);
  out.set(eventHash, configHash.length);
  return out;
}
