/**
 * verifyEventLog Algorithm
 *
 * Verifies all proofs and hash chain integrity in a Cryptographic Event Log.
 * Returns detailed per-event verification status.
 *
 * @see https://w3c-ccg.github.io/cel-spec/
 */

import { bytesToHex } from '@noble/hashes/utils.js';
import type {
  EventLog,
  LogEntry,
  VerifyOptions,
  VerificationResult,
  EventVerification,
  EntryAuthorClass,
  DataIntegrityProof,
  OrdinalsLookup
} from '../types.js';
import { computeDigestMultibase, digestMultibaseEquals } from '../hash.js';
import { canonicalizeEntryForChain } from '../canonicalize.js';
import { multikey } from '../crypto/Multikey.js';
import { deriveDidCelFromGenesis, didCelMatchesLog } from '../celDid.js';
import { parseSatoshiIdentifier } from '../utils/satoshi-validation.js';
import { hexSha256ToDigestMultibase } from '../signerAdapter.js';
import {
  structuralCheck,
  structuralCheckReason,
  extractEd25519FromDidKey,
  verifyProofWithKey,
  verifyDidKeyProof,
} from '../proofVerification.js';
import { hashResource } from '../utils/hash.js';
import { hexToBytes } from '../utils/encoding.js';
import { mostRecentResourceHead } from '../resourceHead.js';

/** getInscriptionById result shape (narrowed for reuse). */
type FetchedInscription = Awaited<ReturnType<OrdinalsLookup['getInscriptionById']>>;

/**
 * Extracts the asset DID document an anchoring inscription carries. Under #407
 * phase 2 the DID document rides in the inscription's CBOR METADATA
 * (`metadata.didDocument`) — its content is the asset media. Legacy phase-1
 * inscriptions carried the DID document as JSON CONTENT, so this falls back to
 * parsing content when no metadata document is present. Returns undefined when
 * neither source yields an object.
 */
function didDocumentFromInscription(inscription: FetchedInscription): unknown {
  const metaDoc = (inscription?.metadata as { didDocument?: unknown } | undefined)?.didDocument;
  if (metaDoc && typeof metaDoc === 'object') return metaDoc;
  if (inscription?.content === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(inscription.content));
  } catch {
    return undefined;
  }
}

// Structural check, did:key extraction and the offline signature check live in
// `../proofVerification.js` so the SEALING path can reuse them without pulling
// this module's Bitcoin/resource dependencies in (see algorithms/sealProof.ts).

/**
 * Cryptographically verifies a `did:key` Ed25519 `eddsa-jcs-2022` proof.
 *
 * The public key is extracted directly from the `verificationMethod` URI
 * (`did:key:<multikey>#<fragment>`) so no DID resolver is required.
 *
 * @param proof - The DataIntegrityProof to verify
 * @param data  - The event payload that was signed
 * @returns `{ verified: boolean; cryptographicallyVerified: boolean }`
 */
export async function verifyDidKeyEd25519Proof(
  proof: DataIntegrityProof,
  data: unknown
): Promise<{ verified: boolean; cryptographicallyVerified: boolean }> {
  const { verified, cryptographicallyVerified } = await verifyDidKeyProof(proof, data);
  return { verified, cryptographicallyVerified };
}

/**
 * Dispatching verifier used when no custom verifier is provided.
 *
 * Verifies ALL proof methods cryptographically or fails closed:
 * - `did:key` proofs: key is extracted locally (offline, no resolver).
 * - All other DID methods: key is fetched via `resolveKey`; if no resolver is
 *   provided the proof fails closed.
 *
 * Structural validity is only a precondition — it never alone yields
 * `verified: true`.
 *
 * `reason` explains a failure ("unsupported cryptosuite …", "signature
 * mismatch", …) so `errors` can say more than "Verification failed".
 */
async function dispatchVerify(
  proof: DataIntegrityProof,
  data: unknown,
  resolveKey?: (verificationMethod: string) => Promise<Uint8Array | null>
): Promise<{ verified: boolean; cryptographicallyVerified: boolean; reason?: string }> {
  // Precondition: structural validity — which now includes the cryptosuite
  // check, so a suite this dispatcher cannot verify is rejected in one place
  // rather than admitted by the validator and failed closed here.
  const structural = structuralCheckReason(proof);
  if (structural) {
    return { verified: false, cryptographicallyVerified: false, reason: structural };
  }

  // Obtain the public key.
  let publicKey: Uint8Array | null = null;

  if (proof.verificationMethod.startsWith('did:key:')) {
    // Key is embedded in the identifier — works offline, no resolver needed.
    publicKey = extractEd25519FromDidKey(proof.verificationMethod);
    if (!publicKey) {
      return { verified: false, cryptographicallyVerified: false, reason: 'non-Ed25519 did:key' };
    }
  } else {
    // Key lives in a remote DID document — requires a resolver.
    if (!resolveKey) {
      return {
        verified: false,
        cryptographicallyVerified: false,
        reason: `no resolver for ${proof.verificationMethod}`,
      };
    }
    publicKey = await resolveKey(proof.verificationMethod);
    if (!publicKey) {
      return {
        verified: false,
        cryptographicallyVerified: false,
        reason: `unresolvable key for ${proof.verificationMethod}`,
      };
    }
  }

  return verifyProofWithKey(proof, data, publicKey);
}

/**
 * Extracts the Ed25519 public key(s) embedded in a SELF-CERTIFYING DID
 * (did:key, or long-form did:peer numalgo-4 which embeds its DID document).
 *
 * Returns:
 * - a Set of hex-encoded keys when the DID is self-certifying (possibly empty —
 *   no Ed25519 key is embedded, or a long-form did:peer:4 whose embedded
 *   document fails to parse — callers MUST fail closed on an empty set);
 * - null when the DID is not self-certifying / not checkable offline
 *   (short-form did:peer:4, other DID methods). Caller semantics on null
 *   differ: the legacy `data.did` path keeps trust-on-first-use, the did:cel
 *   genesis path falls back to VM-DID equality + resolver vouching, and the
 *   rotateKey path fails closed (no proof-of-possession design yet).
 */
async function selfCertifyingKeyHexes(did: unknown): Promise<Set<string> | null> {
  if (typeof did !== 'string') return null;

  // Cap before base58 decode (O(n²), per-event amplifiable via rotateKey): over
  // the bound, fail closed (empty) for the prefixes we'd otherwise decode; null
  // for everything else, matching this function's null-vs-empty semantics.
  if (did.length > 2048) {
    const selfCertifying = did.startsWith('did:key:')
      || (did.startsWith('did:peer:4') && did.split(':').length >= 4);
    return selfCertifying ? new Set() : null;
  }

  if (did.startsWith('did:key:')) {
    // Pure local decode — a did:key IS its key, so a decode failure or a
    // non-Ed25519 key means no Ed25519 proof can be bound to it (empty set →
    // fail closed at the caller).
    const key = extractEd25519FromDidKey(did);
    return new Set(key ? [bytesToHex(key)] : []);
  }

  if (did.startsWith('did:peer:4')) {
    // Only the LONG form (did:peer:4<hash>:<encodedDoc>) embeds the document
    // and is checkable offline; the short form carries only a hash.
    if (did.split(':').length < 4) return null;
    try {
      const mod = await import('@aviarytech/did-peer') as unknown as {
        resolve: (did: string) => Promise<Record<string, unknown>>;
      };
      const doc = await mod.resolve(did);
      const keys = new Set<string>();
      const vms = (doc as { verificationMethod?: Array<{ publicKeyMultibase?: unknown }> }).verificationMethod;
      if (Array.isArray(vms)) {
        for (const vm of vms) {
          if (vm && typeof vm.publicKeyMultibase === 'string') {
            try {
              const dec = multikey.decodePublicKey(vm.publicKeyMultibase);
              if (dec.type === 'Ed25519') keys.add(bytesToHex(dec.key));
            } catch {
              // skip non-decodable verification methods
            }
          }
        }
      }
      return keys;
    } catch {
      // A LONG-FORM did:peer:4 embeds its own document; if that document
      // cannot be parsed the DID is malformed. Fail closed (empty set) rather
      // than returning null and silently degrading to the caller's weaker
      // fallback branch (TOFU / VM-equality).
      return new Set();
    }
  }

  return null;
}

/**
 * Verifies the hash chain for a single event.
 * 
 * @param event - The current event to verify
 * @param index - The index of the event in the log
 * @param previousEvent - The previous event in the log (undefined for first event)
 * @returns Object with chainValid boolean and any errors
 */
function verifyChain(
  event: LogEntry,
  index: number,
  previousEvent: LogEntry | undefined
): { chainValid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (index === 0) {
    // First event must NOT have previousEvent
    if (event.previousEvent !== undefined) {
      errors.push(`Event ${index}: First event must not have previousEvent field`);
      return { chainValid: false, errors };
    }
  } else {
    // Subsequent events must have previousEvent that matches hash of prior event
    if (event.previousEvent === undefined) {
      errors.push(`Event ${index}: Missing previousEvent reference`);
      return { chainValid: false, errors };
    }
    
    if (!previousEvent) {
      errors.push(`Event ${index}: Cannot verify chain - previous event not provided`);
      return { chainValid: false, errors };
    }
    
    // Compute the expected hash of the previous event. The chain link covers
    // ONLY the committed fields ({type, data, previousEvent}) — the same
    // message the signer signed. The proof array (proofValue + unsigned
    // metadata like created/verificationMethod, plus any witness proofs added
    // later) is excluded, so the chain cannot depend on data no signature
    // commits to. See canonicalizeEntryForChain.
    const expectedHash = computeDigestMultibase(canonicalizeEntryForChain(previousEvent));

    // Digest-level comparison (not string equality): logs written by SDK
    // releases before the #258 multihash fix carry legacy bare-digest
    // previousEvent values, and Bitcoin-anchored logs cannot be recomputed.
    if (!digestMultibaseEquals(event.previousEvent, expectedHash)) {
      errors.push(`Event ${index}: Hash chain broken - previousEvent does not match hash of prior event`);
      return { chainValid: false, errors };
    }
  }
  
  return { chainValid: true, errors: [] };
}

/**
 * Returns true when the proof is a third-party witness attestation.
 * Mirrors the discriminator in src/cel/serialization/cbor.ts.
 * Controller proofs never carry `witnessedAt` (confirmed: createSigner /
 * createEventLog do not set this field).
 */
function isWitnessProof(p: DataIntegrityProof): boolean {
  return 'witnessedAt' in p && typeof (p as { witnessedAt?: unknown }).witnessedAt === 'string';
}

/** Cryptosuite identifier of Bitcoin ordinals witness proofs. */
const BITCOIN_WITNESS_CRYPTOSUITE = 'bitcoin-ordinals-2024';

/**
 * Verifies a `bitcoin-ordinals-2024` witness proof against the Bitcoin chain.
 *
 * Unlike other witness proofs, the bitcoin witness is what makes a btco log's
 * on-chain identity (`did:btco:<satoshi>`) resolvable — its satoshi/txid/
 * inscriptionId fields are excluded from the controller signature and the
 * hash chain, so they are attacker-editable unless independently verified.
 * Verification checks that:
 *  1. the claimed inscription exists,
 *  2. it is carried by the claimed satoshi, and
 *  3. its content commits to the event's digest (the same digest the witness
 *     inscribed — see witnessEvent/BitcoinWitness).
 *
 * Returns an error string on failure, or null when the proof is anchored.
 */
async function verifyBitcoinWitnessProof(
  proof: DataIntegrityProof,
  expectedDigest: string,
  ordinalsProvider: OrdinalsLookup | undefined
): Promise<string | null> {
  // Structural validity first (the generic structuralCheck does not apply —
  // its cryptosuite whitelist is for signature proofs): a proof missing its
  // basic Data Integrity fields must not be accepted just because an
  // inscription happens to match.
  if (proof.type !== 'DataIntegrityProof') {
    return `bitcoin witness proof has invalid type (${String(proof.type)})`;
  }
  if (!proof.proofValue || typeof proof.proofValue !== 'string') {
    return `bitcoin witness proof is missing proofValue`;
  }
  if (!proof.verificationMethod || typeof proof.verificationMethod !== 'string') {
    return `bitcoin witness proof is missing verificationMethod`;
  }
  if (!proof.proofPurpose || typeof proof.proofPurpose !== 'string') {
    return `bitcoin witness proof is missing proofPurpose`;
  }

  if (!ordinalsProvider) {
    return `bitcoin witness proof cannot be verified without an ordinalsProvider (required for btco anchoring)`;
  }

  const record = proof as unknown as { satoshi?: unknown; inscriptionId?: unknown; txid?: unknown };
  const satoshi = record.satoshi;
  const inscriptionId = record.inscriptionId;
  if (typeof satoshi !== 'string' || satoshi.length === 0 || typeof inscriptionId !== 'string' || inscriptionId.length === 0) {
    return `bitcoin witness proof is missing satoshi/inscriptionId`;
  }

  let inscription: Awaited<ReturnType<OrdinalsLookup['getInscriptionById']>>;
  try {
    inscription = await ordinalsProvider.getInscriptionById(inscriptionId);
  } catch (e) {
    return `failed to look up bitcoin witness inscription ${inscriptionId}: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (!inscription) {
    return `bitcoin witness inscription ${inscriptionId} not found on chain`;
  }

  // The inscription must be carried by the claimed satoshi — otherwise the
  // proof re-binds the asset to a different did:btco identity.
  if (typeof inscription.satoshi === 'string' && inscription.satoshi.length > 0) {
    if (inscription.satoshi !== satoshi) {
      return `bitcoin witness inscription ${inscriptionId} is carried by satoshi ${inscription.satoshi}, not the claimed ${satoshi}`;
    }
  } else if (typeof ordinalsProvider.getInscriptionsBySatoshi === 'function') {
    try {
      const onSat = await ordinalsProvider.getInscriptionsBySatoshi(satoshi);
      if (!onSat.some((i) => i.inscriptionId === inscriptionId)) {
        return `bitcoin witness inscription ${inscriptionId} is not carried by the claimed satoshi ${satoshi}`;
      }
    } catch (e) {
      return `failed to verify satoshi ${satoshi} for bitcoin witness inscription: ${e instanceof Error ? e.message : String(e)}`;
    }
  } else {
    return `ordinals provider cannot confirm which satoshi carries inscription ${inscriptionId}; failing closed`;
  }

  if (typeof record.txid === 'string' && typeof inscription.txid === 'string' && inscription.txid.length > 0 && record.txid !== inscription.txid) {
    return `bitcoin witness proof txid (${record.txid}) does not match the inscription's txid (${inscription.txid})`;
  }

  // The inscription must commit to the event's digest — the exact digest
  // witnessEvent computed over the committed fields (computed once by the caller
  // and shared with ordinary witness verification). Two accepted shapes:
  //  (a) a witness ATTESTATION with a top-level `digestMultibase` inscribed as
  //      JSON CONTENT (BitcoinWitness / BtcoCelManager), or
  //  (b) the asset's own inscribed DID document carrying an OriginalsCelAnchor
  //      service whose headDigestMultibase is this event's chain digest — under
  //      #407 phase 2 that document rides in inscription METADATA (content is
  //      the asset media); phase-1 inscriptions carried it as content.
  //      (LifecycleManager.inscribeOnBitcoin — the anchoring inscription IS the
  //      witness artifact, #367.)
  // Anything else fails closed.
  const metaDoc = (inscription.metadata as { didDocument?: unknown } | undefined)?.didDocument;
  // No commitment source at all (no content AND no metadata DID doc): a clear,
  // non-alarming diagnostic (distinct from "content is not valid JSON", which
  // implies tampering).
  if (inscription.content === undefined && !metaDoc) {
    return `bitcoin witness inscription ${inscriptionId} content is missing`;
  }
  let attestation: unknown;
  if (inscription.content !== undefined) {
    try {
      attestation = JSON.parse(new TextDecoder().decode(inscription.content));
    } catch {
      attestation = undefined; // content is media (phase 2) — shape (a) N/A
    }
  }
  const attested = (attestation as { digestMultibase?: unknown } | null)?.digestMultibase;
  const didDoc = didDocumentFromInscription(inscription);
  const commits =
    (typeof attested === 'string' && digestMultibaseEquals(attested, expectedDigest)) ||
    didDocumentCommitsToDigest(didDoc, expectedDigest);
  if (!commits) {
    return `bitcoin witness inscription ${inscriptionId} does not commit to this event's digest`;
  }

  return null;
}

/**
 * True when `content` parses as a DID document whose `OriginalsCelAnchor`
 * service commits to `expectedDigest` (the event's chain digest). Strictly
 * structural and fail-closed: a missing/malformed id, service array, anchor
 * entry, or headDigestMultibase — or a digest mismatch — all return false.
 */
function didDocumentCommitsToDigest(content: unknown, expectedDigest: string): boolean {
  if (!content || typeof content !== 'object') return false;
  const doc = content as { id?: unknown; service?: unknown };
  if (typeof doc.id !== 'string' || !doc.id.startsWith('did:')) return false;
  if (!Array.isArray(doc.service)) return false;
  return doc.service.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const svc = entry as { type?: unknown; serviceEndpoint?: unknown };
    if (svc.type !== 'OriginalsCelAnchor') return false;
    const ep = svc.serviceEndpoint;
    if (!ep || typeof ep !== 'object') return false;
    const head = (ep as { headDigestMultibase?: unknown }).headDigestMultibase;
    return typeof head === 'string' && digestMultibaseEquals(head, expectedDigest);
  });
}

/**
 * Returns the `headDigestMultibase` of a DID document's first
 * `OriginalsCelAnchor` service, or undefined when `content` is not a DID
 * document carrying such an anchor. Sibling of `didDocumentCommitsToDigest` —
 * that COMPARES against an expected digest, this EXTRACTS the committed one.
 */
function extractCelAnchorHeadDigest(content: unknown): string | undefined {
  if (!content || typeof content !== 'object') return undefined;
  const doc = content as { id?: unknown; service?: unknown };
  if (typeof doc.id !== 'string' || !doc.id.startsWith('did:')) return undefined;
  if (!Array.isArray(doc.service)) return undefined;
  for (const entry of doc.service) {
    if (!entry || typeof entry !== 'object') continue;
    const svc = entry as { type?: unknown; serviceEndpoint?: unknown };
    if (svc.type !== 'OriginalsCelAnchor') continue;
    const ep = svc.serviceEndpoint;
    if (!ep || typeof ep !== 'object') continue;
    const head = (ep as { headDigestMultibase?: unknown }).headDigestMultibase;
    if (typeof head === 'string' && head.length > 0) return head;
  }
  return undefined;
}

/**
 * Head-freshness check (#366 truncated-log defense): a provenance-completeness
 * guard against being handed a pre-rotation prefix that verifies on its own.
 * This is off the ownership path — ownership is sat control, read live from
 * Bitcoin (see LifecycleManager.getCurrentOwner); this check only defends the
 * authoring record (the CEL) from looking complete when it isn't.
 *
 * Given the log's anchored satoshi, enumerate its inscriptions, take the NEWEST
 * anchor-carrying DID document — chosen by per-inscription block HEIGHT, not
 * list position, so a contract-violating newest-first provider cannot fail this
 * check open (#395) — and REQUIRE its `headDigestMultibase` to equal the chain
 * digest of SOME event PRESENT in the log. Present-in-log, not is-the-head: a
 * legitimate holder may have appended events not yet re-inscribed, so a mid-log
 * match passes; only a head committing to an event the presented log OMITS (a
 * truncation) fails. Missing block heights → fail closed; same-block ties fall
 * back to list-tail order (the documented oldest-first residual).
 *
 * Fail-closed: the caller ASKED for freshness, so any inability to check — no
 * provider, no enumeration capability, a lookup that throws, or no anchor
 * document on the sat — is a `STALE_LOG` failure, never a silent pass.
 *
 * Returns a `STALE_LOG`-coded error string on failure, or null when fresh.
 */
/**
 * Selects the NEWEST OriginalsCelAnchor-bearing inscription on a satoshi, chosen
 * by per-inscription block HEIGHT (via getInscriptionById), NOT list-tail
 * position — otherwise a provider violating the oldest-first contract (returning
 * newest-first) could make a tail-walk pick the OLDEST anchor (#395). Fail-closed
 * throughout: no enumeration capability, an enumeration/fetch that throws, no
 * anchor on the sat, or any anchor candidate missing a confirmed block height all
 * return `{ error }`. Same-block ties fall back to list-tail order (the
 * documented oldest-first residual, unprovable intra-block).
 *
 * Under #407 phase 2 the anchor DID document rides in inscription metadata
 * (content is the asset media); phase-1 inscriptions carried it as content —
 * didDocumentFromInscription handles both.
 *
 * Shared by head-freshness and the content-as-ordinal gate so BOTH agree on which
 * inscription is the current anchor (a cooperative rotation leaves `anchoredSat`
 * pointing at the migrate inscription, so neither may rely on it).
 */
export async function selectNewestAnchorInscription(
  satoshi: string,
  ordinalsProvider: OrdinalsLookup | undefined
): Promise<{ inscription: NonNullable<FetchedInscription>; digest: string } | { error: string }> {
  if (!ordinalsProvider || typeof ordinalsProvider.getInscriptionsBySatoshi !== 'function') {
    return { error: `the ordinals provider cannot enumerate inscriptions on satoshi ${satoshi}` };
  }
  let onSat: Array<{ inscriptionId: string }>;
  try {
    onSat = await ordinalsProvider.getInscriptionsBySatoshi(satoshi);
  } catch (e) {
    return { error: `failed to enumerate inscriptions on satoshi ${satoshi}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const anchors: Array<{ height: number | undefined; listIdx: number; digest: string; inscription: NonNullable<FetchedInscription> }> = [];
  for (let idx = 0; idx < onSat.length; idx++) {
    const inscriptionId = onSat[idx].inscriptionId;
    let inscription: FetchedInscription;
    try {
      inscription = await ordinalsProvider.getInscriptionById(inscriptionId);
    } catch (e) {
      return { error: `failed to fetch inscription ${inscriptionId} on satoshi ${satoshi}: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!inscription) continue;
    const doc = didDocumentFromInscription(inscription);
    const digest = extractCelAnchorHeadDigest(doc);
    if (digest !== undefined) {
      anchors.push({ height: inscriptionBlockHeight(inscription), listIdx: idx, digest, inscription });
    }
  }
  if (anchors.length === 0) {
    return { error: `no OriginalsCelAnchor DID document found on satoshi ${satoshi}` };
  }
  if (anchors.some((c) => c.height === undefined)) {
    return { error: `an OriginalsCelAnchor inscription on satoshi ${satoshi} has no confirmed block height; the newest anchor is unprovable` };
  }
  let head = anchors[0];
  for (const c of anchors) {
    if (c.height! > head.height! || (c.height! === head.height! && c.listIdx > head.listIdx)) head = c;
  }
  return { inscription: head.inscription, digest: head.digest };
}

async function verifyHeadFreshness(
  log: EventLog,
  anchoredSat: AnchoredSat,
  ordinalsProvider: OrdinalsLookup | undefined
): Promise<string | null> {
  const newest = await selectNewestAnchorInscription(anchoredSat.satoshi, ordinalsProvider);
  if ('error' in newest) {
    return `STALE_LOG: ${newest.error}; cannot confirm the presented log is not truncated`;
  }
  const present = log.events.some(
    (ev) => digestMultibaseEquals(newest.digest, computeDigestMultibase(canonicalizeEntryForChain(ev)))
  );
  if (!present) {
    return `STALE_LOG: the newest on-chain anchor on satoshi ${anchoredSat.satoshi} commits to head digest ${newest.digest}, which is absent from the presented log; the log is truncated or stale`;
  }
  return null;
}

/**
 * Authenticates a COMPETING anchoring (#402): true iff its inscribed did:btco
 * document carries a DataIntegrityProof (eddsa-jcs-2022) signed by a key in the
 * verified log's authorized-key history. Without this gate, `getAnchoringsForDidCel`
 * counts ANY inscription that back-links the did:cel via `alsoKnownAs` — so a
 * non-controller could inscribe `{alsoKnownAs:[didCel]}` on their own earlier sat
 * and permanently DENY an honest mint (deny-only front-run). A bare back-link, or
 * a proof by an unauthorized key, therefore does NOT count.
 *
 * The signed payload is the DID document with its `proof` removed, verified with
 * the SAME `eddsa-jcs-2022` primitive the CEL uses (`dispatchVerify` over
 * `canonicalizeEvent(docWithoutProof)`). NOTE: this is THIS codebase's signing
 * convention — JCS over the proofless document — NOT W3C Data Integrity, which
 * signs over document + proof-options (the proof sans `proofValue`); don't treat
 * them as interchangeable if a real VCDM proof path is ever added. Authorization
 * compares the resolved
 * PUBLIC KEY against the history set — not the VM URI string — matching the
 * controller-binding elsewhere in this file. Fail-closed throughout: a missing
 * doc, a malformed/structurally-invalid proof, an unresolvable or unauthorized
 * key, or a bad signature all yield false (the competitor simply does not count).
 */
async function anchoringDocAuthenticated(
  didDocument: Record<string, unknown> | undefined,
  authorizedKeyHexes: Set<string>,
  resolveKey?: (verificationMethod: string) => Promise<Uint8Array | null>
): Promise<boolean> {
  if (!didDocument || typeof didDocument !== 'object') return false;
  const rawProof = (didDocument as { proof?: unknown }).proof;
  const proofs = Array.isArray(rawProof) ? rawProof : rawProof ? [rawProof] : [];
  if (proofs.length === 0) return false;

  // Canonicalize over the document WITHOUT any proof (all proofs stripped).
  const docWithoutProof: Record<string, unknown> = { ...didDocument };
  delete docWithoutProof.proof;

  for (const candidate of proofs) {
    if (!candidate || typeof candidate !== 'object') continue;
    const proof = candidate as DataIntegrityProof;
    if (!structuralCheck(proof)) continue;
    // KEY must be in the log's authorized-key history.
    const keyHex = await resolveControllerKeyHex(proof.verificationMethod, resolveKey);
    if (keyHex === null || !authorizedKeyHexes.has(keyHex)) continue;
    // SIGNATURE must verify over the proofless document.
    const { verified } = await dispatchVerify(proof, docWithoutProof, resolveKey);
    if (verified) return true;
  }
  return false;
}

/**
 * did:cel uniqueness — first-anchor-wins (follow-up to the signed-anchored-sat
 * spec). The canonical sat for a did:cel is the sat of its EARLIEST on-chain
 * anchoring: the lowest confirmed block height, GROUPED BY SAT. Multiple
 * inscriptions on the same sat (migrate + rotation reinscriptions) do not
 * compete — only a different, earlier sat wins. A btco-anchored log whose
 * anchored sat is not that canonical sat is a non-canonical dupe.
 *
 * COMPETITOR AUTHENTICATION (#402): only CONTROLLER-authenticated anchorings
 * count. The log's OWN anchored sat always counts (it is the artifact under
 * verification). A competitor on a DIFFERENT sat counts only if its inscribed
 * did:btco document is signed by a key in THIS log's authorized-key history
 * (`anchoringDocAuthenticated`). An unauthenticated back-link — a bare
 * `alsoKnownAs`, or a proof by an unauthorized key — is IGNORED, so a
 * non-controller cannot front-run and deny an honest mint. A genuinely
 * controller-signed earlier anchoring on a different sat still competes (legit
 * dupe detection preserved).
 *
 * Fail-closed and NOT opt-in: a btco-anchored did:cel log already requires a
 * provider, so a provider that cannot enumerate, an empty enumeration, or any
 * COUNTABLE anchoring missing a confirmed block height → `UNIQUENESS_UNVERIFIABLE`.
 * A same-block tie between two DIFFERENT sats → `AMBIGUOUS_CANONICAL` (no finer
 * on-chain order is exposed by the provider contract today).
 *
 * Returns a coded error string on failure, or null when the anchored sat is
 * canonical.
 */
async function verifyUniqueness(
  didCel: string,
  anchoredSat: AnchoredSat,
  authorizedKeyHexes: Set<string>,
  ordinalsProvider: OrdinalsLookup | undefined,
  resolveKey?: (verificationMethod: string) => Promise<Uint8Array | null>
): Promise<string | null> {
  if (!ordinalsProvider || typeof ordinalsProvider.getAnchoringsForDidCel !== 'function') {
    return `UNIQUENESS_UNVERIFIABLE: the ordinals provider cannot enumerate anchorings for ${didCel}; a btco-anchored did:cel log requires this to confirm first-anchor-wins canonicality`;
  }

  let rawAnchorings: Array<{ satoshi: string; inscriptionId: string; blockHeight?: number; didDocument?: Record<string, unknown> }>;
  try {
    // Sat-scope hint (#473): a provider without a global back-link index may
    // enumerate only the log's own anchored sat (see OrdinalsLookup contract).
    rawAnchorings = await ordinalsProvider.getAnchoringsForDidCel(didCel, { satoshi: anchoredSat.satoshi });
  } catch (e) {
    return `UNIQUENESS_UNVERIFIABLE: failed to enumerate anchorings for ${didCel}: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (!Array.isArray(rawAnchorings) || rawAnchorings.length === 0) {
    return `UNIQUENESS_UNVERIFIABLE: no on-chain anchorings found for ${didCel}; cannot confirm the anchored sat ${anchoredSat.satoshi} is canonical`;
  }

  // #402 filter: keep only COUNTABLE anchorings — the log's own anchored sat
  // (always) plus controller-authenticated competitors on other sats. Everything
  // else (unauthenticated back-links) is dropped BEFORE any ordering logic, so it
  // can never trip NON_CANONICAL_ANCHOR / AMBIGUOUS_CANONICAL. Fail-closed by
  // construction: a competitor the provider cannot surface a doc for, or whose
  // doc is not authorized-signed, simply does not count.
  // ACCEPTED TRADE-OFF: an OrdinalsProvider that doesn't populate `didDocument`
  // (backward-compat) makes ALL competitors uncountable — closing the DoS but
  // also silently suppressing legit-dupe detection (a genuine earlier
  // controller-signed mint on another sat would be ignored). Providers must
  // surface the doc (see OrdinalsLookup/OrdinalsProvider docs) to restore it.
  // A SAT-SCOPED enumeration (#473: only the log's own sat, the tier the
  // shipped production providers implement) lands in the SAME accepted state
  // by construction: competitors are never enumerated, so never counted.
  const anchorings: Array<{ satoshi: string; inscriptionId: string; blockHeight?: number }> = [];
  for (const a of rawAnchorings) {
    if (a.satoshi === anchoredSat.satoshi) {
      anchorings.push(a);
    } else if (await anchoringDocAuthenticated(a.didDocument, authorizedKeyHexes, resolveKey)) {
      anchorings.push(a);
    }
  }

  if (anchorings.length === 0) {
    // No countable anchoring at all: the log's OWN anchored sat is absent from
    // the enumeration (its inscribed did:btco doc is missing the did:cel
    // back-link) and every competitor was unauthenticated. Cannot confirm
    // canonicality — fail closed.
    return `UNIQUENESS_UNVERIFIABLE: the log's own anchoring sat ${anchoredSat.satoshi} for ${didCel} is absent from the on-chain enumeration and no controller-authenticated competitor was found; cannot confirm canonicality`;
  }

  // Every COUNTABLE anchoring must carry a confirmed (non-negative integer) block
  // height: the ordering signal must be provable, or canonicality is undecidable.
  for (const a of anchorings) {
    if (typeof a.blockHeight !== 'number' || !Number.isInteger(a.blockHeight) || a.blockHeight < 0) {
      return `UNIQUENESS_UNVERIFIABLE: anchoring ${a.inscriptionId} on satoshi ${a.satoshi} has no confirmed block height; first-anchor-wins ordering is unprovable`;
    }
  }

  // Group by sat; each sat's competitor is its EARLIEST anchoring.
  const earliestBySat = new Map<string, number>();
  for (const a of anchorings) {
    const cur = earliestBySat.get(a.satoshi);
    if (cur === undefined || a.blockHeight! < cur) earliestBySat.set(a.satoshi, a.blockHeight!);
  }

  // Lowest earliest-height across DISTINCT sats is canonical.
  let minHeight = Infinity;
  for (const h of earliestBySat.values()) if (h < minHeight) minHeight = h;
  const canonicalSats = [...earliestBySat.entries()].filter(([, h]) => h === minHeight).map(([s]) => s);

  if (canonicalSats.length > 1) {
    return `AMBIGUOUS_CANONICAL: ${canonicalSats.length} distinct sats (${canonicalSats.join(', ')}) share the earliest block ${minHeight} for ${didCel}; no finer on-chain order is available, so canonicality is undecidable`;
  }

  const canonicalSat = canonicalSats[0];
  if (anchoredSat.satoshi !== canonicalSat) {
    // Distinguish a genuine competing mint from a self-inflicted enumeration
    // gap: if the log's OWN anchored sat is absent from the enumeration, the
    // real cause is a missing back-link (its inscribed did:btco doc did not list
    // this did:cel in alsoKnownAs), not a rival dupe. Both fail closed.
    if (!earliestBySat.has(anchoredSat.satoshi)) {
      return `NON_CANONICAL_ANCHOR: the log's own anchoring sat ${anchoredSat.satoshi} for ${didCel} is absent from the on-chain enumeration — its inscribed did:btco document may be missing the did:cel back-link in alsoKnownAs; the canonical (earliest-anchored) sat is ${canonicalSat}`;
    }
    return `NON_CANONICAL_ANCHOR: the log is anchored on satoshi ${anchoredSat.satoshi} for ${didCel}, but the canonical (earliest-anchored) sat is ${canonicalSat}; this is a non-canonical dupe`;
  }

  return null;
}

/**
 * Content-as-ordinal integrity (#407 phase 2). The anchoring inscription IS the
 * asset: its CONTENT is the asset's current media. When the anchor inscription
 * carries media, its content MUST hash to the log's most-recent-resource hash —
 * so a chain-reconstructed asset cannot present media that disagrees with its
 * signed provenance. A tampered/wrong-media content fails closed.
 *
 * The single legitimate non-media shape: a pure-reference asset (the head
 * resource has no inline bytes) whose writer inscribed the DID document itself
 * as content (no media on-chain). That is accepted iff the content parses as the
 * anchor's OWN DID document (id == metadata.didDocument.id) — anything else is a
 * mismatch. It cannot be abused to forge media: fake media never hashes to the
 * head, and substituting the DID document only DECLINES to prove media (which
 * only the sat holder, re-inscribing, could do — an honest owner choice).
 *
 * Skipped for phase-1 inscriptions (no metadata DID document) and when the
 * provider omits content (availability gap, not a mismatch; the resolver, which
 * needs the bytes, gates that separately). Runs only once an `anchoredSat` is
 * established (which already required a verified bitcoin witness proof → a
 * provider).
 *
 * Returns a `CONTENT_MISMATCH`-coded error string on failure, or null.
 */
async function verifyAnchorContentMatchesHead(
  log: EventLog,
  anchoredSat: AnchoredSat,
  ordinalsProvider: OrdinalsLookup | undefined
): Promise<string | null> {
  if (!ordinalsProvider) return null;
  // Check the CURRENT anchor — the newest anchor inscription on the sat, not
  // `anchoredSat` (a cooperative rotation leaves that at the migrate inscription,
  // whose media predates any later resource update / reinscription).
  const newest = await selectNewestAnchorInscription(anchoredSat.satoshi, ordinalsProvider);
  if ('error' in newest) {
    // No enumerable anchor to check the media against. Not a content mismatch —
    // the witness-proof path already gated the anchor's DID document, and the
    // resolver (which needs the bytes) gates media strictly on its own path.
    return null;
  }
  const inscription = newest.inscription;
  const inscriptionId = inscription.inscriptionId;
  // Only phase-2 inscriptions (DID document in metadata) bind media as content.
  const metaDoc = (inscription.metadata as { didDocument?: { id?: unknown } } | undefined)?.didDocument;
  if (!metaDoc) return null;
  // Provider omitted content → availability gap, not a mismatch.
  if (inscription.content === undefined) return null;
  const head = mostRecentResourceHead(log);
  // Media match: content hashes to the log's current resource head.
  if (head && hashResource(inscription.content).toLowerCase() === head.hash.toLowerCase()) {
    return null;
  }
  // No-media fallback: content is the anchor's own DID document (pure-reference
  // asset — no inline media to inscribe).
  let asJson: unknown;
  try {
    asJson = JSON.parse(new TextDecoder().decode(inscription.content));
  } catch {
    asJson = undefined;
  }
  const contentDocId = (asJson as { id?: unknown } | undefined)?.id;
  if (typeof contentDocId === 'string' && contentDocId === metaDoc.id) {
    return null;
  }
  const contentHash = hashResource(inscription.content);
  return `CONTENT_MISMATCH: anchor inscription ${inscriptionId} content hashes to ${contentHash}, which is neither the log's most-recent-resource hash ${head ? head.hash : '(none)'} nor the anchor's own DID document`;
}

/**
 * The log's current on-sat authority anchor: the satoshi a verified migrate
 * event bound the log to, and the inscription that most recently attested
 * authority on it (the migrate inscription, then each accepted post-anchor
 * append's reinscription).
 */
interface AnchoredSat {
  satoshi: string;
  inscriptionId: string;
}

/**
 * The sat gate for a post-anchor event: authority is sat control, proven by
 * the reinscription itself — only the current UTXO holder can reinscribe the
 * sat. Requires (the event's own bitcoin witness proofs were already verified
 * IN FULL against its chain digest — they gate proofValid — so this checks the
 * remaining conditions):
 *  - a bitcoin witness proof ON the anchoring sat exists (an off-chain append,
 *    or one witnessed only on some other sat, is simply unauthorized);
 *  - the reinscription STRICTLY POSTDATES the current anchor inscription,
 *    proven by per-inscription confirmed block heights (order-independent of
 *    getInscriptionsBySatoshi's list order); the list index is only a
 *    same-height tiebreak, and everything unprovable fails closed.
 * On success the accepted inscription becomes the new anchor.
 */
async function postAnchorSatGate(
  event: LogEntry,
  index: number,
  anchoredSat: AnchoredSat,
  ordinalsProvider: OrdinalsLookup | undefined
): Promise<{ inscriptionId: string } | { error: string }> {
  const candidates = bitcoinWitnessProofs(event).filter(w => w.satoshi === anchoredSat.satoshi);
  if (candidates.length === 0) {
    return {
      error: `Event ${index}: post-anchor events must be inscribed on the anchoring satoshi ${anchoredSat.satoshi} - only the sat holder can append`
    };
  }
  if (!ordinalsProvider || typeof ordinalsProvider.getInscriptionsBySatoshi !== 'function') {
    return { error: `Event ${index}: ordinals provider cannot enumerate inscriptions on satoshi ${anchoredSat.satoshi}; reinscription order is unprovable` };
  }

  let anchorHeight: number | undefined;
  try {
    anchorHeight = inscriptionBlockHeight(await ordinalsProvider.getInscriptionById(anchoredSat.inscriptionId));
  } catch (e) {
    return { error: `Event ${index}: failed to fetch anchor inscription ${anchoredSat.inscriptionId}: ${e instanceof Error ? e.message : String(e)}` };
  }
  let onSat: Array<{ inscriptionId: string }>;
  try {
    onSat = await ordinalsProvider.getInscriptionsBySatoshi(anchoredSat.satoshi);
  } catch (e) {
    return { error: `Event ${index}: failed to list inscriptions on satoshi ${anchoredSat.satoshi}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const anchorIdx = onSat.findIndex(i => i.inscriptionId === anchoredSat.inscriptionId);

  let reason = `Event ${index}: no witness proof on satoshi ${anchoredSat.satoshi} satisfied the reinscription-ordering conditions`;
  for (const candidate of candidates) {
    let candidateHeight: number | undefined;
    try {
      candidateHeight = inscriptionBlockHeight(await ordinalsProvider.getInscriptionById(candidate.inscriptionId));
    } catch (e) {
      reason = `Event ${index}: failed to fetch inscription ${candidate.inscriptionId}: ${e instanceof Error ? e.message : String(e)}`;
      continue;
    }
    const candidateIdx = onSat.findIndex(i => i.inscriptionId === candidate.inscriptionId);
    if (anchorIdx === -1 || candidateIdx === -1) {
      reason = `Event ${index}: inscription ${candidate.inscriptionId} or anchor inscription ${anchoredSat.inscriptionId} is not enumerated on satoshi ${anchoredSat.satoshi}`;
      continue;
    }
    if (candidateHeight === undefined || anchorHeight === undefined) {
      reason = `Event ${index}: cannot order inscription ${candidate.inscriptionId} against anchor inscription ${anchoredSat.inscriptionId}: block heights unavailable from the provider; ordering is unprovable`;
      continue;
    }
    if (candidateHeight < anchorHeight) {
      reason = `Event ${index}: inscription ${candidate.inscriptionId} (block ${candidateHeight}) predates anchor inscription ${anchoredSat.inscriptionId} (block ${anchorHeight}) on satoshi ${anchoredSat.satoshi}`;
      continue;
    }
    if (candidateHeight === anchorHeight && candidateIdx <= anchorIdx) {
      reason = `Event ${index}: inscription ${candidate.inscriptionId} does not appear strictly after anchor inscription ${anchoredSat.inscriptionId} on satoshi ${anchoredSat.satoshi}`;
      continue;
    }
    return { inscriptionId: candidate.inscriptionId };
  }
  return { error: reason };
}

/**
 * The fields a HOLDER entry's data may carry — an allowlist, deliberately: a
 * field added to the create/update shape next year must not become silently
 * assertable by a holder. Everything else is an authenticity claim only a key
 * in the creator's lineage may make.
 */
const HOLDER_DATA_ALLOWLIST = new Set(['author', 'statement', 'occurredAt', 'links', 'ext']);
const HOLDER_STATEMENT_MAX_CHARS = 4096;

/** Errors for a holder entry's data shape; empty when the shape is allowed. */
function holderDataShapeErrors(data: unknown, index: number): string[] {
  const errors: string[] = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return [`Event ${index}: a holder entry's data must be an object`];
  }
  const record = data as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    if (!HOLDER_DATA_ALLOWLIST.has(key)) {
      errors.push(
        `Event ${index}: a holder entry may not set \`${key}\`; only a key in the creator's lineage can make authenticity claims about the work`
      );
    }
  }
  if (record.statement !== undefined && (typeof record.statement !== 'string' || record.statement.length > HOLDER_STATEMENT_MAX_CHARS)) {
    errors.push(`Event ${index}: a holder entry's \`statement\` must be a string of at most ${HOLDER_STATEMENT_MAX_CHARS} characters`);
  }
  if (record.occurredAt !== undefined && typeof record.occurredAt !== 'string') {
    errors.push(`Event ${index}: a holder entry's \`occurredAt\` must be a string`);
  }
  if (record.links !== undefined && (!Array.isArray(record.links) || record.links.some(l => typeof l !== 'string'))) {
    errors.push(`Event ${index}: a holder entry's \`links\` must be an array of string URLs`);
  }
  if (record.ext !== undefined && (record.ext === null || typeof record.ext !== 'object' || Array.isArray(record.ext))) {
    errors.push(`Event ${index}: a holder entry's \`ext\` must be an object`);
  }
  return errors;
}

/**
 * Extracts the well-formed `bitcoin-ordinals-2024` witness proofs of an event
 * (those carrying non-empty string satoshi/inscriptionId). Malformed entries
 * are skipped here — verifyBitcoinWitnessProof still gates them in the witness
 * loop, so skipping cannot launder a bad proof.
 */
function bitcoinWitnessProofs(
  event: LogEntry
): Array<{ proof: DataIntegrityProof; satoshi: string; inscriptionId: string }> {
  if (!Array.isArray(event.proof)) return [];
  const out: Array<{ proof: DataIntegrityProof; satoshi: string; inscriptionId: string }> = [];
  for (const p of event.proof) {
    if (!p || typeof p !== 'object' || !isWitnessProof(p)) continue;
    if (p.cryptosuite !== BITCOIN_WITNESS_CRYPTOSUITE) continue;
    const rec = p as unknown as { satoshi?: unknown; inscriptionId?: unknown };
    if (
      typeof rec.satoshi === 'string' && rec.satoshi.length > 0 &&
      typeof rec.inscriptionId === 'string' && rec.inscriptionId.length > 0
    ) {
      out.push({ proof: p, satoshi: rec.satoshi, inscriptionId: rec.inscriptionId });
    }
  }
  return out;
}

/**
 * Confirmed block height of a getInscriptionById result, when the provider
 * exposes one. `blockHeight` is not declared on the minimal OrdinalsLookup
 * surface, so it is probed structurally — every SDK OrdinalsProvider returns
 * it, and it is the only provider-order-INDEPENDENT ordering signal available
 * to the ordering checks (head freshness).
 *
 * Only a non-negative INTEGER counts as a confirmed height; anything else
 * (including the null OrdHttp/QuickNode return until an inscription has ≥1
 * confirmation) yields undefined → fail closed. Behavior change (#395): an
 * UNCONFIRMED reinscription is now rejected by the ordering checks until it
 * confirms — intended, fail-closed.
 */
function inscriptionBlockHeight(inscription: unknown): number | undefined {
  const h = (inscription as { blockHeight?: unknown } | null | undefined)?.blockHeight;
  return typeof h === 'number' && Number.isInteger(h) && h >= 0 ? h : undefined;
}

/**
 * Resolves a proof's controller PUBLIC KEY, which is the correct unit of
 * authorization: two verification methods identify the same signer iff they
 * resolve to the same key material.
 *
 * Comparing raw verification-method URIs is wrong in both directions:
 * - too loose if the fragment is stripped (`#key-0` vs `#key-1` in one DID doc
 *   are DISTINCT keys), and
 * - too strict if compared verbatim (the same key spelled with a different but
 *   equivalent VM id — which the key resolver already treats as equal — would
 *   be rejected).
 *
 * did:key proofs carry the key in the identifier (resolved offline); other
 * methods use the same `resolveKey` resolver as `dispatchVerify`. Returns a hex
 * string so keys can be compared/stored in a Set, or null if unresolvable.
 */
async function resolveControllerKeyHex(
  verificationMethod: string,
  resolveKey?: (verificationMethod: string) => Promise<Uint8Array | null>
): Promise<string | null> {
  let key: Uint8Array | null = null;
  if (verificationMethod.startsWith('did:key:')) {
    key = extractEd25519FromDidKey(verificationMethod);
  } else if (resolveKey) {
    try {
      key = await resolveKey(verificationMethod);
    } catch {
      key = null;
    }
  }
  return key ? bytesToHex(key) : null;
}

/**
 * Verifies a single event's proofs.
 *
 * Controller proofs (those without `witnessedAt`) gate the overall
 * `proofValid`/`cryptographicallyVerified` result.  Witness proofs (those with
 * `witnessedAt`) are verified with the same mechanism and reported in
 * `witnessProofs`, but a failed or unresolvable witness does NOT affect the
 * overall result — witnesses add trust, they do not let a third party's
 * availability invalidate the controller's signature.
 *
 * When a custom verifier is provided it is used for every proof (controller +
 * witness) on the legacy / test path.
 *
 * @param event - The event to verify
 * @param index - The index of the event in the log
 * @param customVerifier - Optional caller-supplied verifier (overrides dispatch)
 * @param previousEvent - The previous event in the log (undefined for first event)
 * @param resolveKey - Optional key resolver for non-did:key proofs
 * @returns EventVerification result
 */
/**
 * Resource-update chain continuity (#407 phase 1 — content-addressed separation).
 *
 * A resource-shaped `update` event (`data.resourceId` + `data.previousVersionHash`
 * present) MUST chain forward from the last-known hash of its resourceId:
 *  - first update for a resourceId: if genesis BOUND that resourceId to a digest
 *    (ExternalReference carried an `id`, #401), `previousVersionHash` must match
 *    THAT digest specifically; otherwise (legacy id-less genesis) it may match
 *    ANY genesis digest;
 *  - subsequent updates: it must match the prior update's `toHash`.
 * The new current hash is the SIGNED `data.toHash` field — NOT recomputed from
 * content, which no longer lives in the event (#407): the bytes travel in the
 * content-addressed store (resources array / envelope blobs), and CONTENT
 * INTEGRITY (does a blob actually hash to `toHash`) is bound at load time by
 * loadAsset. Here we check only the hash chain over the signed hashes. All hashes
 * are compared as digestMultibase. On success the per-resourceId map is advanced;
 * on any failure an error string is returned (fail closed) and the map is left
 * untouched.
 */
function checkResourceUpdateContinuity(
  data: { resourceId: unknown; previousVersionHash: unknown; toHash?: unknown },
  genesisDigests: Set<string>,
  genesisDigestById: Map<string, string>,
  currentResourceHash: Map<string, string>
): string | null {
  const resourceId = data.resourceId as string;
  if (typeof data.toHash !== 'string' || data.toHash.length === 0) {
    return `resource update for ${resourceId} is missing a signed toHash; cannot verify continuity`;
  }
  let prevDigest: string;
  let newDigest: string;
  try {
    prevDigest = hexSha256ToDigestMultibase(data.previousVersionHash as string);
    newDigest = hexSha256ToDigestMultibase(data.toHash);
  } catch (e) {
    return `resource update for ${resourceId} has an unparseable hash: ${e instanceof Error ? e.message : String(e)}`;
  }

  const known = currentResourceHash.get(resourceId);
  let matches: boolean;
  if (known !== undefined) {
    // Subsequent update: chain from this resource's prior derived hash.
    matches = digestMultibaseEquals(prevDigest, known);
  } else {
    // First update. If genesis bound this resourceId (#401), it MUST chain from
    // that specific digest — not any genesis resource's digest (which would let
    // a fabricated/mismatched resourceId anchor off an unrelated resource). Only
    // an id-less legacy genesis falls back to matching any genesis digest.
    const boundDigest = genesisDigestById.get(resourceId);
    matches = boundDigest !== undefined
      ? digestMultibaseEquals(prevDigest, boundDigest)
      : [...genesisDigests].some((d) => digestMultibaseEquals(prevDigest, d));
  }
  if (!matches) {
    return `resource update for ${resourceId}: previousVersionHash does not match the last-known hash (chain-continuity broken)`;
  }

  currentResourceHash.set(resourceId, newDigest);
  return null;
}

async function verifyEvent(
  event: LogEntry,
  index: number,
  customVerifier: ((proof: DataIntegrityProof, data: unknown) => Promise<boolean>) | undefined,
  previousEvent: LogEntry | undefined,
  resolveKey?: (verificationMethod: string) => Promise<Uint8Array | null>,
  authorizedKeyIds?: Set<string>,
  ordinalsProvider?: OrdinalsLookup,
  // Post-anchor events (except the legacy v0 transfer read path) are exempt
  // from the key-lineage check: their authority is sat control, enforced by
  // the walk's sat gate. The walk decides this — pre-anchor events never skip.
  skipAuthorization?: boolean
): Promise<EventVerification> {
  const errors: string[] = [];

  // Verify hash chain
  const chainResult = verifyChain(event, index, previousEvent);
  const chainValid = chainResult.chainValid;
  errors.push(...chainResult.errors);

  // Check that event has proofs
  if (!event.proof || !Array.isArray(event.proof) || event.proof.length === 0) {
    errors.push(`Event ${index}: No proofs found`);
    return {
      index,
      type: event.type,
      proofValid: false,
      chainValid,
      errors,
    };
  }

  // Build the signed payload — must exactly match what createSigner in the CLI
  // passes to canonicalizeEvent: { type, data, ...(previousEvent ? { previousEvent } : {}) }
  const eventData = {
    type: event.type,
    data: event.data,
    ...(event.previousEvent ? { previousEvent: event.previousEvent } : {}),
  };

  // Separate controller proofs from witness proofs.
  const controllerProofs: { proof: DataIntegrityProof; originalIndex: number }[] = [];
  const witnessProofEntries: { proof: DataIntegrityProof; originalIndex: number }[] = [];

  for (let i = 0; i < event.proof.length; i++) {
    if (isWitnessProof(event.proof[i])) {
      witnessProofEntries.push({ proof: event.proof[i], originalIndex: i });
    } else {
      controllerProofs.push({ proof: event.proof[i], originalIndex: i });
    }
  }

  // Require at least one controller proof.
  if (controllerProofs.length === 0) {
    errors.push(`Event ${index}: no controller proof`);
    return {
      index,
      type: event.type,
      proofValid: false,
      chainValid,
      errors,
    };
  }

  // Controller binding: on the default (dispatch) path, every controller proof
  // must be signed by a key authorized by the log's create event. Without this,
  // any key can append/rename/migrate/deactivate someone else's log and it
  // verifies (confirmed forgeable). Authorization compares the resolved PUBLIC
  // KEY (not the VM URI string), so it is neither fooled by two distinct keys
  // in one DID document nor tripped up by the same key under an equivalent VM
  // id. A custom verifier takes full responsibility for authorization, so this
  // check is skipped there.
  if (!customVerifier && authorizedKeyIds && index > 0 && !skipAuthorization) {
    for (const { proof, originalIndex } of controllerProofs) {
      const keyHex = await resolveControllerKeyHex(proof.verificationMethod, resolveKey);
      if (keyHex === null || !authorizedKeyIds.has(keyHex)) {
        errors.push(
          `Event ${index}, Proof ${originalIndex}: signer ${proof.verificationMethod} is not authorized by the log's create event`
        );
        return {
          index,
          type: event.type,
          proofValid: false,
          chainValid,
          cryptographicallyVerified: false,
          errors,
        };
      }
    }
  }

  // Author binding: `data.author` commits the signer's identity INSIDE the
  // chain digest (proofs are excluded from it, so without this an entry's
  // proof could be stripped and the identical data re-signed by another key
  // — the entry would survive with a forged author). Whenever an event
  // declares an author, it must be a self-certifying DID and the event's
  // SINGLE controller proof must resolve to one of its keys. Presence is not
  // (yet) required — the SDK writes `data.author` on every post-anchor
  // append, and the sat-gated authority model requires it there. A custom
  // verifier owns proof semantics entirely, so the check is skipped on that
  // path (documented as unsafe for btco logs).
  const declaredAuthor = (event.data as { author?: unknown } | null | undefined)?.author;
  if (!customVerifier && typeof declaredAuthor === 'string') {
    const fail = (message: string): EventVerification => {
      errors.push(message);
      return {
        index,
        type: event.type,
        proofValid: false,
        chainValid,
        cryptographicallyVerified: false,
        errors,
      };
    };
    if (controllerProofs.length !== 1) {
      return fail(
        `Event ${index}: an authored event must carry exactly one controller proof (found ${controllerProofs.length})`
      );
    }
    const authorKeys = await selfCertifyingKeyHexes(declaredAuthor);
    if (!authorKeys || authorKeys.size === 0) {
      return fail(
        `Event ${index}: data.author (${declaredAuthor}) is not a self-certifying DID with an Ed25519 key (did:key or long-form did:peer:4)`
      );
    }
    const { proof, originalIndex } = controllerProofs[0];
    const signerKeyHex = await resolveControllerKeyHex(proof.verificationMethod, resolveKey);
    if (signerKeyHex === null || !authorKeys.has(signerKeyHex)) {
      return fail(
        `Event ${index}, Proof ${originalIndex}: signer ${proof.verificationMethod} is not a key of data.author ${declaredAuthor} — the committed author must be the actual signer`
      );
    }
  }

  // Verify controller proofs — these gate `proofValid` and `cryptographicallyVerified`.
  let allControllerProofsValid = true;
  let allCryptographicallyVerified = true;

  for (const { proof, originalIndex } of controllerProofs) {
    try {
      if (customVerifier) {
        const isValid = await customVerifier(proof, eventData);
        if (!isValid) {
          allControllerProofsValid = false;
          errors.push(`Event ${index}, Proof ${originalIndex}: Verification failed`);
        }
        // When a custom verifier is used we cannot assert cryptographic verification.
        allCryptographicallyVerified = false;
      } else {
        const { verified, cryptographicallyVerified, reason } = await dispatchVerify(proof, eventData, resolveKey);
        if (!verified) {
          allControllerProofsValid = false;
          errors.push(
            `Event ${index}, Proof ${originalIndex}: Verification failed${reason ? ` (${reason})` : ''}`
          );
        }
        if (!cryptographicallyVerified) {
          allCryptographicallyVerified = false;
        }
      }
    } catch (error) {
      allControllerProofsValid = false;
      allCryptographicallyVerified = false;
      const message = error instanceof Error ? error.message : 'Unknown error';
      errors.push(`Event ${index}, Proof ${originalIndex}: ${message}`);
    }
  }

  // Verify witness proofs. Ordinary (signature-based) witness proofs are
  // NON-GATING: results go into `witnessProofs` only. Bitcoin ordinals witness
  // proofs are the exception — they define the asset's resolvable did:btco
  // identity, so on the default path they are verified against the chain and
  // GATE the result (see verifyBitcoinWitnessProof). A custom verifier owns
  // proof semantics entirely, so bitcoin gating is skipped on that path.
  const witnessResults: { verificationMethod: string; verified: boolean }[] = [];

  // Witnesses attest to the event DIGEST, not the event object: witnessEvent
  // hands `witness.witness(digestMultibase)` only the digest string, so an
  // honest witness signs that string. Verifying witness signatures against
  // the event object could never succeed (issue #240). Computed once and
  // shared with bitcoin-anchor verification below.
  const witnessedDigest = witnessProofEntries.length > 0
    ? computeDigestMultibase(canonicalizeEntryForChain(event))
    : undefined;

  for (const { proof, originalIndex } of witnessProofEntries) {
    let witnessVerified = false;
    try {
      if (customVerifier) {
        witnessVerified = await customVerifier(proof, eventData);
      } else if (proof.cryptosuite === BITCOIN_WITNESS_CRYPTOSUITE) {
        const anchorError = await verifyBitcoinWitnessProof(proof, witnessedDigest as string, ordinalsProvider);
        witnessVerified = anchorError === null;
        if (anchorError !== null) {
          // A failed btco anchor gates BOTH signals: the event is not valid
          // and must not be reported as cryptographically verified either.
          allControllerProofsValid = false;
          allCryptographicallyVerified = false;
          errors.push(`Event ${index}, Proof ${originalIndex}: ${anchorError}`);
        }
      } else {
        const { verified } = await dispatchVerify(proof, witnessedDigest, resolveKey);
        witnessVerified = verified;
      }
    } catch {
      witnessVerified = false;
    }
    witnessResults.push({ verificationMethod: proof.verificationMethod, verified: witnessVerified });
  }

  const result: EventVerification = {
    index,
    type: event.type,
    proofValid: allControllerProofsValid,
    chainValid,
    ...(customVerifier ? {} : { cryptographicallyVerified: allCryptographicallyVerified }),
    errors,
  };

  if (witnessResults.length > 0) {
    result.witnessProofs = witnessResults;
  }

  // The signer's did:key (default path only; a custom verifier owns proof
  // semantics and no class machinery runs there). When the event committed a
  // (verified-bound) author, that IS the signer; otherwise it is derived from
  // the first controller proof — offline for did:key VMs, via the resolver
  // for the rest.
  if (!customVerifier) {
    if (typeof declaredAuthor === 'string') {
      result.authorKey = declaredAuthor;
    } else {
      const vm0 = controllerProofs[0].proof.verificationMethod;
      if (vm0.startsWith('did:key:')) {
        result.authorKey = vm0.split('#')[0];
      } else {
        const hex = await resolveControllerKeyHex(vm0, resolveKey);
        if (hex) {
          try {
            result.authorKey = `did:key:${multikey.encodePublicKey(hexToBytes(hex), 'Ed25519')}`;
          } catch {
            // non-encodable key material: leave authorKey absent
          }
        }
      }
    }
  }

  return result;
}

/**
 * Verifies all proofs and hash chain integrity in an event log.
 *
 * This algorithm verifies:
 * - Each event has at least one proof
 * - Each proof is structurally valid (type, cryptosuite, proofValue, verificationMethod, proofPurpose)
 * - Proofs use valid cryptosuite (eddsa-jcs-2022 or eddsa-rdfc-2022)
 * - The first event has no previousEvent field
 * - The first event is a `create` event
 * - No event follows a `deactivate` event (a deactivated log is sealed)
 * - Each subsequent event's previousEvent matches the digestMultibase of the prior event
 *
 * When no custom verifier is provided, `did:key` + `eddsa-jcs-2022` proofs
 * are cryptographically verified using the public key embedded in the DID.
 * Other verification methods fall back to structural-only verification and are
 * tagged with `cryptographicallyVerified: false` in the per-event results.
 *
 * @param log - The event log to verify
 * @param options - Optional verification options including custom verifier
 * @returns VerificationResult with detailed per-event status including chainValid
 *
 * @example
 * ```typescript
 * // Full cryptographic verification for did:key proofs (default)
 * const result = await verifyEventLog(eventLog);
 * if (result.verified) {
 *   console.log('All proofs are valid and hash chain is intact');
 * }
 *
 * // With custom cryptographic verifier
 * const result = await verifyEventLog(eventLog, {
 *   verifier: async (proof, data) => {
 *     const publicKey = await resolvePublicKey(proof.verificationMethod);
 *     return verifyEdDsaSignature(data, proof.proofValue, publicKey);
 *   }
 * });
 * ```
 */
export async function verifyEventLog(
  log: EventLog,
  options?: VerifyOptions
): Promise<VerificationResult> {
  const errors: string[] = [];
  const eventVerifications: EventVerification[] = [];

  // Validate log structure
  if (!log || !log.events) {
    return {
      verified: false,
      errors: ['Invalid event log: missing events array'],
      events: [],
    };
  }

  if (!Array.isArray(log.events)) {
    return {
      verified: false,
      errors: ['Invalid event log: events is not an array'],
      events: [],
    };
  }

  if (log.events.length === 0) {
    return {
      verified: false,
      errors: ['Invalid event log: empty events array'],
      events: [],
    };
  }

  // The first event must be a `create` event: every state-derivation path
  // (PeerCelManager/WebVHCelManager/BtcoCelManager/CLI deriveCurrentState)
  // requires it, so a log that "verifies" without one would be verified yet
  // un-derivable. Fail closed.
  if (log.events[0].type !== 'create') {
    return {
      verified: false,
      errors: [`Invalid event log: first event must be a 'create' event (found '${String(log.events[0].type)}')`],
      events: [],
    };
  }

  // A `deactivate` event seals the log (deactivateEventLog refuses to append
  // to a deactivated log). Enforce the same rule at verification: any event
  // AFTER a deactivate means the sealed log was mutated, so the log must not
  // verify — even if every signature and chain link is individually valid.
  const deactivateIndex = log.events.findIndex(e => e.type === 'deactivate');
  const deactivationViolated = deactivateIndex !== -1 && deactivateIndex < log.events.length - 1;
  if (deactivationViolated) {
    errors.push(
      `Invalid event log: event ${deactivateIndex} is a 'deactivate' event but ` +
      `${log.events.length - 1 - deactivateIndex} event(s) follow it; a deactivated log is sealed and must not be extended`
    );
  }

  // Establish the INITIAL authorized controller key from the create event
  // (event 0): the root of authority. The set is not fixed for the life of the
  // log — a fully valid `rotateKey` event REPLACES it with the new controller's
  // keys (hand-off semantics; see the rotation arm in the event loop below).
  //
  // SECURITY: the hash chain and the controller signature cover only
  // { type, data, previousEvent } — NOT the proof array. So an attacker can
  // append their own valid controller proof to the create event without
  // breaking the chain or the owner's signature. If we seeded the authorized
  // set from ALL of the create event's controller proofs, that injected key
  // would become authorized and could sign forged later events. To close this,
  // the create event must carry EXACTLY ONE controller proof; more than one is
  // treated as tampering (its unsigned proof array cannot disambiguate the
  // real root from an injected co-signer) and fails the whole log.
  //
  // When a custom verifier is supplied, the caller owns proof semantics and
  // authorization (verifyEvent skips the controller-key binding on that path),
  // so this default authority check is skipped too — consistently.
  const createEvent = log.events[0];

  // Genesis shape discrimination (drives both the authority binding below and
  // the assetDid/expectedDid semantics). Legacy logs embed the asset DID in
  // `data.did`; did:cel genesis logs carry the holder's key in `data.controller`
  // and DERIVE the asset DID from the event (no self-reference). A non-string
  // `data.did` is malformed and treated as absent.
  const genesisData = createEvent.data as { did?: unknown; controller?: unknown } | null | undefined;
  const legacyDid = typeof genesisData?.did === 'string' ? genesisData.did : undefined;
  const celController = legacyDid === undefined && typeof genesisData?.controller === 'string'
    ? genesisData.controller
    : undefined;

  // Seed for resource-update continuity from the genesis resource digests
  // (ExternalReference.digestMultibase). Two seeds (#401):
  //  - `genesisResourceDigestById`: when a genesis ref carries its resource `id`,
  //    that resource's FIRST update MUST chain from ITS OWN genesis digest.
  //  - `genesisResourceDigests` (flat): legacy/hand-built geneses whose refs have
  //    no `id` fall back to matching ANY genesis digest (the pre-#401 behavior).
  // Subsequent updates always chain from the prior derived hash.
  const genesisResourceDigests = new Set<string>();
  const genesisResourceDigestById = new Map<string, string>();
  {
    const genesisResources = (createEvent.data as { resources?: unknown } | null | undefined)?.resources;
    if (Array.isArray(genesisResources)) {
      for (const r of genesisResources) {
        const dm = (r as { digestMultibase?: unknown })?.digestMultibase;
        if (typeof dm !== 'string' || dm.length === 0) continue;
        genesisResourceDigests.add(dm);
        const id = (r as { id?: unknown })?.id;
        if (typeof id === 'string' && id.length > 0) genesisResourceDigestById.set(id, dm);
      }
    }
  }
  const currentResourceHash = new Map<string, string>();

  let authorizedKeyIds = new Set<string>();
  // The UNION of every key the log's key history ever authorized (genesis
  // controller + each accepted rotation's newController). Unlike authorizedKeyIds
  // — which a rotation REPLACES (hand-off semantics) — this only grows, because a
  // legitimate earlier btco anchoring may have been signed by an EARLIER
  // controller key. Used solely to authenticate competing anchorings in #402
  // uniqueness (it never relaxes per-event authorization, which stays scoped to
  // authorizedKeyIds as it stood when each event was appended).
  const allAuthorizedKeyHexes = new Set<string>();
  let authorityError: string | undefined;
  if (!options?.verifier) {
    // A non-array proof (missing, object, string, …) yields zero controller
    // proofs → authorityError below, rather than throwing on .filter.
    const createControllerProofs = Array.isArray(createEvent.proof)
      ? createEvent.proof.filter(p => !isWitnessProof(p))
      : [];
    if (createControllerProofs.length !== 1) {
      authorityError =
        `Create event must have exactly one controller proof to establish authority (found ` +
        `${createControllerProofs.length}); the create event's proof array is not signed, so ` +
        `additional controller proofs cannot be trusted.`;
    } else {
      const rootKeyHex = await resolveControllerKeyHex(createControllerProofs[0].verificationMethod, options?.resolveKey);
      if (rootKeyHex) {
        if (celController !== undefined) {
          // did:cel genesis: `data.controller` DEFINES authority — the create
          // event's signing key MUST be a key of that controller. FAIL CLOSED,
          // NEVER blind trust-on-first-use: without this an attacker can copy a
          // victim's genesis `data` verbatim, re-sign event 0 with their own
          // key, and mint a "valid" log for the victim's derived did:cel under
          // the attacker's key.
          //
          // Two ways to bind, both fail-closed:
          //  - self-certifying controller (did:key / long-form did:peer:4): its
          //    key material is embedded, so the root key MUST be one of those
          //    keys — checked offline, no resolver, no fallback.
          //  - resolver-backed controller (did:webvh, …): its keys cannot be
          //    enumerated offline, so the root proof's verificationMethod MUST
          //    belong to the controller DID (proof VM DID === controller). The
          //    resolver then vouches for that key and the signature is checked
          //    downstream. A foreign-DID signer (e.g. a did:key claiming a
          //    did:webvh controller) is not the controller and fails closed.
          const controllerKeys = await selfCertifyingKeyHexes(celController);
          const rootProofVm = createControllerProofs[0].verificationMethod;
          const bound = controllerKeys !== null
            ? controllerKeys.has(rootKeyHex)
            : rootProofVm.split('#')[0] === celController;
          if (!bound) {
            authorityError =
              `Create event proof key (${rootProofVm}) is not a key of ` +
              `the genesis controller ${celController}; the log was not created by that controller.`;
          } else {
            authorizedKeyIds.add(rootKeyHex);
          }
        } else {
          // Legacy / shapeless self-certifying binding (unchanged): when the
          // create event's `data.did` is a did:key or long-form did:peer:4, the
          // identifier itself embeds the controller's key material, so the
          // create-event signing key can be checked against it offline. Without
          // this, an attacker can copy a victim's create event `data` verbatim,
          // re-sign event 0 with their own did:key, and produce a "valid"
          // provenance log for the victim's DID under the attacker's key.
          //
          // The check applies only when the create proof's verificationMethod
          // is itself a did:key: that is the offline-checkable pattern the SDK
          // emits (PeerCelManager embeds the signer's key in the generated
          // did:peer). Resolver-backed verification methods (did:webvh, …)
          // cannot embed their key in the asset DID at create time, so they
          // keep trust-on-first-use — their authority is whatever the
          // verifier's resolveKey vouches for. Non-self-certifying `data.did`
          // methods and shapeless logs also keep trust-on-first-use.
          const embeddedKeys = createControllerProofs[0].verificationMethod.startsWith('did:key:')
            ? await selfCertifyingKeyHexes(legacyDid)
            : null;
          if (embeddedKeys !== null && !embeddedKeys.has(rootKeyHex)) {
            authorityError =
              `Create event controller key (${createControllerProofs[0].verificationMethod}) is not a key ` +
              `embedded in the self-certifying DID ${String(legacyDid)}; the log was not created by that DID's controller.`;
          } else {
            authorizedKeyIds.add(rootKeyHex);
          }
        }
      } else {
        // The create event's key could not be resolved (e.g. a transient
        // resolver failure or an unsupported key type). Fail closed with a
        // distinct authority error rather than leaving authorizedKeyIds empty,
        // which would silently reject every subsequent event as "not
        // authorized" and turn a valid log into a false negative.
        authorityError =
          `Create event controller key (${createControllerProofs[0].verificationMethod}) could not be ` +
          `resolved to establish authority; cannot safely authorize subsequent events.`;
      }
    }
  }

  // Verify each event's proofs and hash chain. The loop is index-ordered and
  // authority is SPLIT AT THE BTCO ANCHOR:
  //  - PRE-anchor, authority is key lineage: each event is authorized against
  //    `authorizedKeyIds` as it stood when the event was appended, and a fully
  //    valid rotateKey event swaps the set for subsequent iterations.
  //  - POST-anchor (every event after the verified btco migrate), authority is
  //    SAT CONTROL: an event is authorized iff it commits its author in
  //    `data.author`, its single controller proof is that author's key, and it
  //    carries a fully verified `bitcoin-ordinals-2024` witness proof on the
  //    anchoring sat whose inscription strictly postdates the current anchor.
  //    The signer does NOT have to be in `authorizedKeyIds`, and appending
  //    never modifies it — rotateKey/deactivate/migrate are rejected outright
  //    post-anchor (holding the sat grants the right to append, not control of
  //    the key set). The legacy v0 `transfer` read path keeps the key-lineage
  //    check so pre-existing logs stay verifiable.
  //
  // Companion walk state: once a btco migrate's SIGNED anchoring sat is
  // confirmed by a matching bitcoin witness proof, the log's authority is
  // anchored to that sat, and the creator lineage is FROZEN (`creatorKeyHexes`
  // snapshot). Default-path only; a custom verifier owns semantics.
  let anchoredSat: AnchoredSat | undefined;
  // The creator lineage frozen at the anchor (item 5): exactly authorizedKeyIds
  // at the moment anchoredSat is first set. Post-anchor entries signed by these
  // keys are creator entries; everything else that passes the sat gate is a
  // holder entry.
  let creatorKeyHexes: Set<string> | undefined;
  // The creator lineage as did:keys, genesis first (reported on the result).
  const creatorKeys: string[] = [];
  // Distinct holder authors (did:keys) in first-append order, and their key
  // hexes for the #402 uniqueness union: the asset's own later reinscriptions
  // are holder-authored, so competitor authentication must recognize them.
  const holders: string[] = [];
  const holderKeyHexes = new Set<string>();
  // Seed the history union with the genesis-authorized key(s) established above.
  for (const k of authorizedKeyIds) allAuthorizedKeyHexes.add(k);
  if (!options?.verifier) {
    for (const k of authorizedKeyIds) {
      try {
        creatorKeys.push(`did:key:${multikey.encodePublicKey(hexToBytes(k), 'Ed25519')}`);
      } catch { /* non-encodable key material: omit from the reported lineage */ }
    }
  }
  for (let i = 0; i < log.events.length; i++) {
    const event = log.events[i];
    const previousEvent = i > 0 ? log.events[i - 1] : undefined;
    // Post-anchor events (except legacy v0 transfers) are authorized by the
    // sat gate below, not by key lineage.
    const isV1Transfer = event.type === 'transfer' &&
      (event.data as { newController?: unknown } | null | undefined)?.newController !== undefined;
    const isLegacyV0Transfer = event.type === 'transfer' && !isV1Transfer;
    const postAnchor = !options?.verifier && anchoredSat !== undefined;
    const eventResult = await verifyEvent(
      event, i, options?.verifier, previousEvent, options?.resolveKey, authorizedKeyIds,
      options?.ordinalsProvider, postAnchor && !isLegacyV0Transfer
    );
    // The class this iteration derives for the entry (default path only).
    let entryClass: EntryAuthorClass | undefined;

    // There is no transfer event in this model: ownership is the sat, moved by
    // a plain Bitcoin transaction, never a log event. A v1 transfer (one that
    // assigns a controller) is rejected ANYWHERE; the v0 legacy shape
    // (previousOwner/newOwner/txid, no authority effect) stays readable.
    if (!options?.verifier && isV1Transfer) {
      eventResult.proofValid = false;
      eventResult.errors.push(
        `Event ${i}: transfer events cannot assign a controller (data.newController); ownership is the sat, moved by a Bitcoin transaction, never a log event`
      );
    }

    // Post-anchor policy: the sat decides. Type rejections first, then the sat
    // gate for updates.
    if (postAnchor && anchoredSat) {
      if (event.type === 'rotateKey') {
        eventResult.proofValid = false;
        eventResult.errors.push(
          `Event ${i}: rotateKey is not permitted after the btco anchor; holding the sat grants the right to append, not control of the key set`
        );
      } else if (event.type === 'deactivate') {
        eventResult.proofValid = false;
        eventResult.errors.push(
          `Event ${i}: deactivate is not permitted after the btco anchor`
        );
      } else if (event.type === 'migrate') {
        eventResult.proofValid = false;
        eventResult.errors.push(
          `Event ${i}: migrate is not permitted after the btco anchor`
        );
      } else if (event.type === 'update' && eventResult.proofValid && eventResult.chainValid) {
        const author = (event.data as { author?: unknown } | null | undefined)?.author;
        if (typeof author !== 'string') {
          eventResult.proofValid = false;
          eventResult.errors.push(
            `Event ${i}: post-anchor events must commit the appending key in data.author`
          );
        } else {
          // verifyEvent already bound the (present) author: exactly one
          // controller proof, self-certifying author, signer ≡ author.
          const gate = await postAnchorSatGate(event, i, anchoredSat, options?.ordinalsProvider);
          if ('error' in gate) {
            eventResult.proofValid = false;
            eventResult.errors.push(gate.error);
          } else {
            const authorHexes = await selfCertifyingKeyHexes(author);
            const isCreatorEntry = [...(authorHexes ?? [])].some(h => creatorKeyHexes?.has(h) === true);
            if (isCreatorEntry) {
              entryClass = 'creator';
              anchoredSat = { satoshi: anchoredSat.satoshi, inscriptionId: gate.inscriptionId };
            } else {
              const shapeErrors = holderDataShapeErrors(event.data, i);
              if (shapeErrors.length > 0) {
                eventResult.proofValid = false;
                eventResult.errors.push(...shapeErrors);
                entryClass = 'holder';
              } else {
                entryClass = 'holder';
                anchoredSat = { satoshi: anchoredSat.satoshi, inscriptionId: gate.inscriptionId };
                if (!holders.includes(author)) holders.push(author);
                for (const h of authorHexes ?? []) holderKeyHexes.add(h);
              }
            }
          }
        }
      }
      // Legacy v0 transfers pass through on the key-lineage path (no sat gate,
      // no author requirement) — the legacy read path.
    }

    // Resource-update continuity (default path only; a custom verifier owns
    // proof semantics). Only engage for resource-shaped updates that otherwise
    // verified — a failed proof/chain already fails the event.
    if (!options?.verifier && event.type === 'update' && eventResult.proofValid && eventResult.chainValid) {
      const rd = event.data as { resourceId?: unknown; previousVersionHash?: unknown; toHash?: unknown } | null;
      if (rd && typeof rd.resourceId === 'string' && typeof rd.previousVersionHash === 'string') {
        // Rebuild as a literal: narrowing on rd's optional props doesn't
        // propagate to the whole-object type expected by the helper below.
        const err = checkResourceUpdateContinuity(
          { resourceId: rd.resourceId, previousVersionHash: rd.previousVersionHash, toHash: rd.toHash },
          genesisResourceDigests,
          genesisResourceDigestById,
          currentResourceHash
        );
        if (err) {
          eventResult.proofValid = false;
          eventResult.errors.push(`Event ${i}: ${err}`);
        }
      }
    }

    // rotateKey hand-off. Order matters: the rotation event must pass ALL its
    // checks (chain link, signature, CURRENT-set authorization, gating witness
    // proofs) BEFORE the set is swapped — a failed rotation must not rotate.
    // Skipped on the custom-verifier path, where the caller owns authorization.
    if (!options?.verifier && event.type === 'rotateKey' && eventResult.proofValid && eventResult.chainValid) {
      const rotation = event.data as { newController?: unknown } | null | undefined;
      const newController = typeof rotation?.newController === 'string' ? rotation.newController : undefined;
      // v1 requires a SELF-CERTIFYING newController (did:key, or long-form
      // did:peer:4): its key material is embedded, so the hand-off target is
      // checkable offline. Resolver-backed newControllers (did:webvh, …) fail
      // closed — VM-DID equality has no meaning here (nothing is signed by the
      // new key yet); supporting them needs a proof-of-possession design.
      const newKeys = newController !== undefined ? await selfCertifyingKeyHexes(newController) : null;
      if (!newKeys || newKeys.size === 0) {
        // Unbindable target fails the EVENT (and therefore the log) — an
        // accepted rotation to nowhere would strand or hijack the log.
        eventResult.proofValid = false;
        eventResult.errors.push(
          `Event ${i}: rotateKey has an unbindable newController (${String(newController)}); ` +
          `a rotation target must be a self-certifying DID carrying an Ed25519 key`
        );
      } else {
        // REPLACE, not union — hand-off semantics (design spec §2/§5); keeping
        // the old keys would reopen the stale-key window rotation closes.
        authorizedKeyIds = newKeys;
        // The uniqueness history union (#402) DOES accumulate: an earlier
        // anchoring signed by this now-superseded controller must still be
        // recognizable as a legit competitor.
        for (const k of newKeys) allAuthorizedKeyHexes.add(k);
        // Only PRE-anchor rotations reach here (post-anchor rotateKey fails
        // above), so this extends the reported creator lineage.
        if (typeof newController === 'string' && !creatorKeys.includes(newController)) {
          creatorKeys.push(newController);
        }
      }
    }

    // anchoredSat maintenance (default path; a fully verified event only —
    // an unverified migrate witness must never anchor authority, guaranteed
    // because bitcoin witness proofs GATE proofValid).
    if (!options?.verifier && eventResult.proofValid && eventResult.chainValid) {
      if (event.type === 'migrate') {
        const mdata = event.data as { layer?: unknown; to?: unknown } | null | undefined;
        if (mdata?.layer === 'btco') {
          // The canonical anchoring sat is the controller-SIGNED did:btco in
          // data.to (design 2026-07-13), NOT the unsigned witness array. A btco
          // migrate that does not sign a parseable sat is UNBOUND.
          let signedSat: string | undefined;
          if (typeof mdata.to === 'string') {
            try { signedSat = String(parseSatoshiIdentifier(mdata.to)); } catch { signedSat = undefined; }
          }
          if (signedSat === undefined) {
            eventResult.proofValid = false;
            eventResult.errors.push(
              `Event ${i}: UNBOUND_ANCHOR: a btco migrate must sign a resolvable did:btco anchoring sat in data.to (found ${String(mdata.to)})`
            );
          } else {
            // proofValid=true ⇒ every bitcoin witness proof already verified
            // on-chain. Require them to carry the SIGNED sat: a witness on any
            // other sat is a cross-sat fork attempt; none on the signed sat is
            // witness-stripping. Both fail closed.
            const witnessed = bitcoinWitnessProofs(event);
            const offSignedSat = witnessed.find(w => w.satoshi !== signedSat);
            const onSignedSat = witnessed.find(w => w.satoshi === signedSat);
            if (offSignedSat) {
              eventResult.proofValid = false;
              eventResult.errors.push(
                `Event ${i}: bitcoin witness proof satoshi ${offSignedSat.satoshi} does not match the signed anchoring sat ${signedSat}`
              );
            } else if (!onSignedSat) {
              eventResult.proofValid = false;
              eventResult.errors.push(
                `Event ${i}: btco migrate signs anchoring sat ${signedSat} but carries no verifiable bitcoin witness proof on it`
              );
            } else {
              anchoredSat = { satoshi: signedSat, inscriptionId: onSignedSat.inscriptionId };
              // Freeze the creator lineage at the anchor (item 5): post-anchor
              // rotateKey is rejected, so the set can never legitimately change
              // again. Snapshot explicitly rather than relying on that.
              creatorKeyHexes = new Set(authorizedKeyIds);
            }
          }
        }
      }
    }

    // Entry class (default path only; total — a mystery entry never defaults
    // to `creator`). Post-anchor updates were classified by the sat-gate
    // branch above; everything else is a creator entry iff the lineage was
    // established and the event verified under it.
    if (!options?.verifier) {
      eventResult.authorClass = entryClass ?? (
        !authorityError && eventResult.proofValid && eventResult.chainValid && eventResult.authorKey !== undefined
          ? 'creator'
          : 'unattributed'
      );
    }

    eventVerifications.push(eventResult);

    if (!eventResult.proofValid || !eventResult.chainValid) {
      errors.push(...eventResult.errors);
    }
  }

  // Head-freshness (#366): buyer-requested truncated-log defense. Default OFF,
  // so existing callers see zero behavior change. `anchoredSat` is default-path
  // authority state that never establishes on the custom-verifier path, so
  // requesting the check there is a configuration error (it would silently pass)
  // and instead fails closed.
  let staleLogError: string | undefined;
  if (options?.checkHeadFreshness) {
    if (options?.verifier) {
      staleLogError =
        `head-freshness check is incompatible with a custom verifier: the custom path skips the ` +
        `on-chain authority walk that head freshness is validated against`;
    } else if (anchoredSat) {
      staleLogError = await verifyHeadFreshness(log, anchoredSat, options?.ordinalsProvider) ?? undefined;
    }
    // No anchoredSat ⇒ the log was never btco-anchored (a signed btco migrate
    // that failed the anchor checks failed the whole log above), so there is
    // nothing to be fresh against — the flag is a no-op.
  }

  // assetDid: the DERIVED did:cel for new-shape genesis logs, the declared
  // data.did for legacy logs, absent for shapeless logs. Pure derivation — no
  // authority machinery — so it is reported even on the custom-verifier path.
  let assetDid: string | undefined;
  if (celController !== undefined) assetDid = deriveDidCelFromGenesis(createEvent);
  else if (legacyDid !== undefined) assetDid = legacyDid;

  // did:cel uniqueness — first-anchor-wins (follow-up spec). Runs whenever a
  // did:cel log is btco-anchored (`anchoredSat` set by the walk) and a provider
  // is present. NOT gated on checkHeadFreshness: it is part of the btco
  // verification contract, not an opt-in extra. Skipped on the custom-verifier
  // path (which owns proof semantics and never establishes `anchoredSat`).
  let uniquenessError: string | undefined;
  if (!options?.verifier && anchoredSat && typeof assetDid === 'string' && assetDid.startsWith('did:cel:')) {
    // Union with the verified post-anchor holder keys: the asset's own later
    // reinscriptions are holder-authored, so competitor authentication (#402)
    // must recognize them in the cross-sat case.
    const recognizedKeyHexes = holderKeyHexes.size > 0
      ? new Set([...allAuthorizedKeyHexes, ...holderKeyHexes])
      : allAuthorizedKeyHexes;
    uniquenessError = (await verifyUniqueness(assetDid, anchoredSat, recognizedKeyHexes, options?.ordinalsProvider, options?.resolveKey)) ?? undefined;
  }

  // Content-as-ordinal integrity (#407 phase 2): a phase-2 anchor inscription's
  // media content must hash to the log's most-recent-resource hash. Part of the
  // btco verification contract (not opt-in); skipped on the custom-verifier path
  // (which owns proof semantics and never establishes `anchoredSat`).
  let contentMismatchError: string | undefined;
  if (!options?.verifier && anchoredSat) {
    contentMismatchError = (await verifyAnchorContentMatchesHead(log, anchoredSat, options?.ordinalsProvider)) ?? undefined;
  }

  // expectedDid: reject a log that does not back the caller's expected DID.
  // Scoped to the non-custom-verifier path — that path owns proof semantics and
  // the authority binding above is skipped there. did:cel is matched by suffix
  // derivation; legacy by string equality; a shapeless log backs no DID.
  let expectedDidError: string | undefined;
  if (options?.expectedDid !== undefined && !options?.verifier) {
    const matches = celController !== undefined
      ? didCelMatchesLog(options.expectedDid, log)
      : options.expectedDid === legacyDid;
    if (!matches) {
      expectedDidError = `log does not back expected DID ${options.expectedDid}`;
    }
  }

  // Determine overall verification status (both proofs AND chain must be valid,
  // and the create event must establish a single unambiguous authority key).
  const allProofsValid = eventVerifications.every(ev => ev.proofValid);
  const allChainsValid = eventVerifications.every(ev => ev.chainValid);

  if (authorityError) {
    errors.unshift(authorityError);
  }
  if (expectedDidError) {
    errors.push(expectedDidError);
  }
  if (staleLogError) {
    errors.push(staleLogError);
  }
  if (uniquenessError) {
    errors.push(uniquenessError);
  }
  if (contentMismatchError) {
    errors.push(contentMismatchError);
  }

  return {
    verified: allProofsValid && allChainsValid && !authorityError && !deactivationViolated && !expectedDidError && !staleLogError && !uniquenessError && !contentMismatchError,
    errors,
    events: eventVerifications,
    ...(assetDid !== undefined ? { assetDid } : {}),
    // Class machinery is default-path only; never synthesized under a custom
    // verifier.
    ...(options?.verifier ? {} : { creatorKeys, holders }),
  };
}
