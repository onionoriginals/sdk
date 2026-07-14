/**
 * verifyEventLog Algorithm
 *
 * Verifies all proofs and hash chain integrity in a Cryptographic Event Log.
 * Returns detailed per-event verification status.
 *
 * @see https://w3c-ccg.github.io/cel-spec/
 */

import { verifyAsync } from '@noble/ed25519';
import type {
  EventLog,
  LogEntry,
  VerifyOptions,
  VerificationResult,
  EventVerification,
  DataIntegrityProof,
  OrdinalsLookup
} from '../types.js';
import { computeDigestMultibase, digestMultibaseEquals } from '../hash.js';
import { canonicalizeEvent, canonicalizeEntryForChain } from '../canonicalize.js';
import { multikey } from '../../crypto/Multikey.js';
import { deriveDidCelFromGenesis, didCelMatchesLog } from '../celDid.js';
import { parseSatoshiIdentifier } from '../../utils/satoshi-validation.js';
import { hexSha256ToDigestMultibase } from '../signerAdapter.js';
import { hashResource } from '../../utils/validation.js';
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
    return JSON.parse(inscription.content.toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Validates the structural requirements of a DataIntegrityProof (field presence,
 * multibase prefix, recognised cryptosuite).  Used as a precondition by the
 * cryptographic verifiers and as the sole check on the fallback / structural-
 * only path.
 */
function structuralCheck(proof: DataIntegrityProof): boolean {
  if (!proof.type || proof.type !== 'DataIntegrityProof') {
    return false;
  }
  if (!proof.cryptosuite) {
    return false;
  }
  if (!proof.proofValue || typeof proof.proofValue !== 'string' || proof.proofValue.length === 0) {
    return false;
  }
  if (!proof.verificationMethod || typeof proof.verificationMethod !== 'string') {
    return false;
  }
  if (!proof.proofPurpose || typeof proof.proofPurpose !== 'string') {
    return false;
  }
  const validCryptosuites = ['eddsa-jcs-2022', 'eddsa-rdfc-2022'];
  if (!validCryptosuites.includes(proof.cryptosuite)) {
    return false;
  }
  if (!proof.proofValue.startsWith('z') && !proof.proofValue.startsWith('u')) {
    return false;
  }
  return true;
}

/**
 * Extracts the Ed25519 public key bytes embedded in a `did:key` verification
 * method URI (`did:key:<multikey>#<fragment>`).  Returns `null` for non-Ed25519
 * keys or if decoding fails — callers must fail closed on `null`.
 */
function extractEd25519FromDidKey(verificationMethod: string): Uint8Array | null {
  try {
    const withoutPrefix = verificationMethod.slice('did:key:'.length);
    const multikeyStr = withoutPrefix.split('#')[0];
    const decoded = multikey.decodePublicKey(multikeyStr);
    return decoded.type === 'Ed25519' ? decoded.key : null;
  } catch {
    return null;
  }
}

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
  // Run structural checks first — these are preconditions for any path.
  if (!structuralCheck(proof)) {
    return { verified: false, cryptographicallyVerified: false };
  }

  // Only handle did:key verification methods.
  if (!proof.verificationMethod.startsWith('did:key:')) {
    return { verified: false, cryptographicallyVerified: false };
  }

  // Only handle eddsa-jcs-2022 cryptosuite.
  if (proof.cryptosuite !== 'eddsa-jcs-2022') {
    return { verified: false, cryptographicallyVerified: false };
  }

  const publicKeyBytes = extractEd25519FromDidKey(proof.verificationMethod);
  if (!publicKeyBytes) {
    // Non-Ed25519 key or decoding failure — fail closed.
    return { verified: false, cryptographicallyVerified: false };
  }

  try {
    const signatureBytes = multikey.decodeMultibase(proof.proofValue);
    const message = canonicalizeEvent(data);
    const ok = await verifyAsync(signatureBytes, message, publicKeyBytes);
    return { verified: ok, cryptographicallyVerified: ok };
  } catch {
    return { verified: false, cryptographicallyVerified: false };
  }
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
 * Returns the full `{ verified, cryptographicallyVerified }` pair.
 */
async function dispatchVerify(
  proof: DataIntegrityProof,
  data: unknown,
  resolveKey?: (verificationMethod: string) => Promise<Uint8Array | null>
): Promise<{ verified: boolean; cryptographicallyVerified: boolean }> {
  // Precondition: structural validity.
  if (!structuralCheck(proof)) {
    return { verified: false, cryptographicallyVerified: false };
  }

  // CEL signatures are Ed25519-over-JCS; any other suite cannot be verified
  // here and must fail closed (incl. eddsa-rdfc-2022).
  if (proof.cryptosuite !== 'eddsa-jcs-2022') {
    return { verified: false, cryptographicallyVerified: false };
  }

  // Obtain the public key.
  let publicKey: Uint8Array | null = null;

  if (proof.verificationMethod.startsWith('did:key:')) {
    // Key is embedded in the identifier — works offline, no resolver needed.
    publicKey = extractEd25519FromDidKey(proof.verificationMethod);
  } else {
    // Key lives in a remote DID document — requires a resolver.
    if (!resolveKey) {
      return { verified: false, cryptographicallyVerified: false };
    }
    publicKey = await resolveKey(proof.verificationMethod);
  }

  if (!publicKey) {
    return { verified: false, cryptographicallyVerified: false };
  }

  try {
    const signatureBytes = multikey.decodeMultibase(proof.proofValue);
    const message = canonicalizeEvent(data);
    const ok = await verifyAsync(signatureBytes, message, publicKey);
    return { verified: ok, cryptographicallyVerified: ok };
  } catch {
    return { verified: false, cryptographicallyVerified: false };
  }
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
    return new Set(key ? [Buffer.from(key).toString('hex')] : []);
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
              if (dec.type === 'Ed25519') keys.add(Buffer.from(dec.key).toString('hex'));
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
      attestation = JSON.parse(inscription.content.toString('utf8'));
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
async function verifyHeadFreshness(
  log: EventLog,
  anchoredSat: AnchoredSat,
  ordinalsProvider: OrdinalsLookup | undefined
): Promise<string | null> {
  if (!ordinalsProvider || typeof ordinalsProvider.getInscriptionsBySatoshi !== 'function') {
    return `STALE_LOG: head freshness was requested but the ordinals provider cannot enumerate inscriptions on satoshi ${anchoredSat.satoshi}; cannot confirm the log is not truncated`;
  }

  let onSat: Array<{ inscriptionId: string }>;
  try {
    onSat = await ordinalsProvider.getInscriptionsBySatoshi(anchoredSat.satoshi);
  } catch (e) {
    return `STALE_LOG: failed to enumerate inscriptions on satoshi ${anchoredSat.satoshi} for the head-freshness check: ${e instanceof Error ? e.message : String(e)}`;
  }

  // The "newest" anchor is chosen by per-inscription block HEIGHT (via
  // getInscriptionById), NOT by list-tail position — otherwise a provider
  // violating the oldest-first contract (returning newest-first) would make a
  // tail-walk pick the OLDEST anchor, present even in a truncated prefix →
  // fail-open (#395 sibling of the non-cooperative-rotation ordering fix).
  // So collect EVERY anchor-carrying inscription with its height + list index.
  // Non-anchor / non-JSON inscriptions are skipped; a genuine FETCH failure
  // fails closed rather than silently skipping a real head.
  const anchors: Array<{ height: number | undefined; listIdx: number; digest: string }> = [];
  for (let idx = 0; idx < onSat.length; idx++) {
    const inscriptionId = onSat[idx].inscriptionId;
    let inscription: Awaited<ReturnType<OrdinalsLookup['getInscriptionById']>>;
    try {
      inscription = await ordinalsProvider.getInscriptionById(inscriptionId);
    } catch (e) {
      return `STALE_LOG: failed to fetch inscription ${inscriptionId} on satoshi ${anchoredSat.satoshi} during the head-freshness check: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (!inscription) continue;
    // #407 phase 2: the anchor DID document rides in inscription metadata
    // (content is the asset media); phase-1 inscriptions carried it as content.
    const doc = didDocumentFromInscription(inscription);
    const digest = extractCelAnchorHeadDigest(doc);
    if (digest !== undefined) {
      anchors.push({ height: inscriptionBlockHeight(inscription), listIdx: idx, digest });
    }
  }

  if (anchors.length === 0) {
    return `STALE_LOG: no OriginalsCelAnchor DID document found on satoshi ${anchoredSat.satoshi}; cannot confirm the presented log is current`;
  }
  // Ordering must be provable: if any anchor candidate lacks a block height, we
  // cannot identify the genuinely-newest one — fail closed (consistent with the
  // non-cooperative rotation ordering check).
  if (anchors.some((c) => c.height === undefined)) {
    return `STALE_LOG: an OriginalsCelAnchor inscription on satoshi ${anchoredSat.satoshi} has no confirmed block height; the newest anchor is unprovable, so head freshness cannot be confirmed`;
  }
  // Highest block wins; same-block ties fall back to list-tail order (highest
  // list index) — the documented oldest-first residual, unprovable intra-block.
  let head = anchors[0];
  for (const c of anchors) {
    if (c.height! > head.height! || (c.height! === head.height! && c.listIdx > head.listIdx)) head = c;
  }
  const headDigest = head.digest;

  const present = log.events.some(
    (ev) => digestMultibaseEquals(headDigest, computeDigestMultibase(canonicalizeEntryForChain(ev)))
  );
  if (!present) {
    return `STALE_LOG: the newest on-chain anchor on satoshi ${anchoredSat.satoshi} commits to head digest ${headDigest}, which is absent from the presented log; the log is truncated or stale`;
  }

  return null;
}

/**
 * did:cel uniqueness — first-anchor-wins (follow-up to the signed-anchored-sat
 * spec). The canonical sat for a did:cel is the sat of its EARLIEST on-chain
 * anchoring: the lowest confirmed block height, GROUPED BY SAT. Multiple
 * inscriptions on the same sat (migrate + rotation reinscriptions) do not
 * compete — only a different, earlier sat wins. A btco-anchored log whose
 * anchored sat is not that canonical sat is a non-canonical dupe.
 *
 * Fail-closed and NOT opt-in: a btco-anchored did:cel log already requires a
 * provider, so a provider that cannot enumerate, an empty enumeration, or any
 * anchoring missing a confirmed block height → `UNIQUENESS_UNVERIFIABLE`. A
 * same-block tie between two DIFFERENT sats → `AMBIGUOUS_CANONICAL` (no finer
 * on-chain order is exposed by the provider contract today).
 *
 * Returns a coded error string on failure, or null when the anchored sat is
 * canonical.
 */
async function verifyUniqueness(
  didCel: string,
  anchoredSat: AnchoredSat,
  ordinalsProvider: OrdinalsLookup | undefined
): Promise<string | null> {
  if (!ordinalsProvider || typeof ordinalsProvider.getAnchoringsForDidCel !== 'function') {
    return `UNIQUENESS_UNVERIFIABLE: the ordinals provider cannot enumerate anchorings for ${didCel}; a btco-anchored did:cel log requires this to confirm first-anchor-wins canonicality`;
  }

  let anchorings: Array<{ satoshi: string; inscriptionId: string; blockHeight?: number }>;
  try {
    anchorings = await ordinalsProvider.getAnchoringsForDidCel(didCel);
  } catch (e) {
    return `UNIQUENESS_UNVERIFIABLE: failed to enumerate anchorings for ${didCel}: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (!Array.isArray(anchorings) || anchorings.length === 0) {
    return `UNIQUENESS_UNVERIFIABLE: no on-chain anchorings found for ${didCel}; cannot confirm the anchored sat ${anchoredSat.satoshi} is canonical`;
  }

  // Every anchoring must carry a confirmed (non-negative integer) block height:
  // the ordering signal must be provable, or canonicality is undecidable.
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
  let inscription: FetchedInscription;
  try {
    inscription = await ordinalsProvider.getInscriptionById(anchoredSat.inscriptionId);
  } catch (e) {
    return `CONTENT_MISMATCH: failed to fetch anchor inscription ${anchoredSat.inscriptionId} to verify its media content: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (!inscription) {
    return `CONTENT_MISMATCH: anchor inscription ${anchoredSat.inscriptionId} not found on chain`;
  }
  // Only phase-2 inscriptions (DID document in metadata) bind media as content.
  const metaDoc = (inscription.metadata as { didDocument?: { id?: unknown } } | undefined)?.didDocument;
  if (!metaDoc) return null;
  // Provider omitted content → availability gap, not a mismatch (the witness
  // proof already gated the metadata DID doc). The resolver gates media strictly.
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
    asJson = JSON.parse(inscription.content.toString('utf8'));
  } catch {
    asJson = undefined;
  }
  const contentDocId = (asJson as { id?: unknown } | undefined)?.id;
  if (typeof contentDocId === 'string' && contentDocId === metaDoc.id) {
    return null;
  }
  const contentHash = hashResource(inscription.content);
  return `CONTENT_MISMATCH: anchor inscription ${anchoredSat.inscriptionId} content hashes to ${contentHash}, which is neither the log's most-recent-resource hash ${head ? head.hash : '(none)'} nor the anchor's own DID document`;
}

/**
 * The log's current on-sat authority anchor: the satoshi a verified migrate
 * event bound the log to, and the inscription that most recently attested
 * authority on it (the migrate inscription, then each accepted non-cooperative
 * rotation's reinscription).
 */
interface AnchoredSat {
  satoshi: string;
  inscriptionId: string;
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
 * Collects the Ed25519 key hexes announced by a DID document's
 * `verificationMethod[].publicKeyMultibase` entries. Non-documents,
 * non-decodable and non-Ed25519 entries are skipped (fail closed at the
 * caller on an empty set).
 */
function ed25519KeyHexesFromDidDocument(content: unknown): Set<string> {
  const keys = new Set<string>();
  if (!content || typeof content !== 'object') return keys;
  const vms = (content as { verificationMethod?: unknown }).verificationMethod;
  if (!Array.isArray(vms)) return keys;
  for (const vm of vms) {
    const pkm = vm && typeof vm === 'object' ? (vm as { publicKeyMultibase?: unknown }).publicKeyMultibase : undefined;
    if (typeof pkm !== 'string') continue;
    try {
      const dec = multikey.decodePublicKey(pkm);
      if (dec.type === 'Ed25519') keys.add(Buffer.from(dec.key).toString('hex'));
    } catch {
      // skip non-decodable verification methods
    }
  }
  return keys;
}

/**
 * Confirmed block height of a getInscriptionById result, when the provider
 * exposes one. `blockHeight` is not declared on the minimal OrdinalsLookup
 * surface, so it is probed structurally — every SDK OrdinalsProvider returns
 * it, and it is the only provider-order-INDEPENDENT ordering signal available
 * to the ordering checks (non-cooperative rotation (d), head freshness).
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
 * Non-cooperative rotation candidacy (#366): after a sat transfer the new
 * owner cannot obtain the old controller's signature, so a rotateKey whose
 * controller proof is NOT authorized by the current key set is accepted IFF
 * ALL of the following hold — every unverifiable step fails closed:
 *
 *  (a) the event carries a `bitcoin-ordinals-2024` witness proof whose
 *      `satoshi` equals the anchored sat, and `verifyBitcoinWitnessProof`
 *      passes IN FULL against THIS event's chain digest (the reinscription
 *      commits to the rotation itself);
 *  (b) the inscribed DID document announces an Ed25519 key of
 *      `data.newController` in its verificationMethod — self-certifying
 *      newControllers only (did:key / long-form did:peer:4);
 *  (c) the event's own controller-proof key is itself a key of newController —
 *      signer ≡ announced ≡ inscribed. This closes the
 *      wrap-someone-else's-reinscription attack: an attacker cannot take the
 *      legitimate buyer's on-sat reinscription and wrap it in a rotateKey
 *      naming (or signed by) themselves;
 *  (d) the rotation's inscription STRICTLY POSTDATES the current anchor
 *      inscription, proven by per-inscription block heights (order-independent
 *      of getInscriptionsBySatoshi's list order); the list index is only a
 *      same-height tiebreak, and missing heights fail closed.
 *
 * No ordering-vs-transfer-tx check is needed (and none is done): only the
 * sat's current UTXO holder can reinscribe it, so a reinscription satisfying
 * (a)–(d) is itself proof of sat control at reinscription time — the sat
 * enforces control, the verifier only orders inscriptions.
 */
async function evaluateNonCooperativeRotation(
  event: LogEntry,
  controllerProofs: { proof: DataIntegrityProof; originalIndex: number }[],
  anchoredSat: AnchoredSat,
  ordinalsProvider: OrdinalsLookup | undefined,
  resolveKey?: (verificationMethod: string) => Promise<Uint8Array | null>
): Promise<{ accepted: true; inscriptionId: string } | { accepted: false; reason: string }> {
  // Hand-off target: a self-certifying newController with embedded Ed25519
  // key material. Resolver-backed targets (did:webvh, …) fail closed — nothing
  // offline binds their keys, and (b)/(c) below need an enumerable key set.
  const rotation = event.data as { newController?: unknown } | null | undefined;
  const newController = typeof rotation?.newController === 'string' ? rotation.newController : undefined;
  const newKeys = newController !== undefined ? await selfCertifyingKeyHexes(newController) : null;
  if (!newKeys || newKeys.size === 0) {
    return { accepted: false, reason: `newController (${String(newController)}) is not a self-certifying DID with an Ed25519 key` };
  }

  // (c) EVERY controller proof on the event must be signed by a key of
  // newController — a mixed old/new or foreign co-signer disqualifies.
  for (const { proof, originalIndex } of controllerProofs) {
    const keyHex = await resolveControllerKeyHex(proof.verificationMethod, resolveKey);
    if (keyHex === null || !newKeys.has(keyHex)) {
      return {
        accepted: false,
        reason: `controller proof ${originalIndex} (${proof.verificationMethod}) is not signed by a key of newController — signer must equal the announced new controller`
      };
    }
  }

  // (a) precondition: a bitcoin witness proof ON THE ANCHORED SAT.
  const candidates = bitcoinWitnessProofs(event).filter(w => w.satoshi === anchoredSat.satoshi);
  if (candidates.length === 0) {
    return { accepted: false, reason: `event carries no bitcoin witness proof on the anchored satoshi ${anchoredSat.satoshi}` };
  }

  const eventDigest = computeDigestMultibase(canonicalizeEntryForChain(event));
  let reason = 'no witness proof satisfied the reinscription conditions';

  // The anchor inscription is fixed across candidates, so fetch its block
  // height ONCE here (not per candidate). A fetch failure is a hard fail-closed:
  // no candidate can be ordered against an anchor we cannot read. Skipped when
  // there is no provider — the loop's verifyBitcoinWitnessProof already returns
  // the clean "requires an ordinalsProvider" rejection in that case.
  let anchorHeight: number | undefined;
  if (ordinalsProvider) {
    try {
      anchorHeight = inscriptionBlockHeight(await ordinalsProvider.getInscriptionById(anchoredSat.inscriptionId));
    } catch (e) {
      return { accepted: false, reason: `failed to fetch anchor inscription ${anchoredSat.inscriptionId}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // First-satisfying-candidate wins (unlike the migrate signed-sat rule, which
  // rejects a witness that disagrees with data.to): both candidates here are
  // necessarily sat-holder-authored, so there's no cross-party escalation to guard against.
  for (const candidate of candidates) {
    // (a) full on-chain verification against THIS event's chain digest:
    // inscription exists, is carried by the claimed (= anchored) sat, and its
    // content commits to the rotation event.
    const anchorError = await verifyBitcoinWitnessProof(candidate.proof, eventDigest, ordinalsProvider);
    if (anchorError !== null) {
      reason = anchorError;
      continue;
    }

    // (b) the reinscribed DID document must ANNOUNCE the new controller's key.
    // verifyBitcoinWitnessProof guaranteed the provider and the inscription
    // content exist; a lookup failure here still fails closed. The fetch also
    // yields the rotation's block height for the (d) ordering check below.
    let announced: Set<string>;
    let rotationHeight: number | undefined;
    try {
      const inscription = await (ordinalsProvider as OrdinalsLookup).getInscriptionById(candidate.inscriptionId);
      if (!inscription) {
        reason = `inscription ${candidate.inscriptionId} not found`;
        continue;
      }
      rotationHeight = inscriptionBlockHeight(inscription);
      // #407 phase 2: the reinscribed DID document rides in metadata (content is
      // the asset media); phase-1 reinscriptions carried it as content.
      const doc = didDocumentFromInscription(inscription);
      if (doc === undefined) {
        reason = `inscription ${candidate.inscriptionId} carries no DID document`;
        continue;
      }
      announced = ed25519KeyHexesFromDidDocument(doc);
    } catch (e) {
      reason = `failed to inspect inscription ${candidate.inscriptionId}: ${e instanceof Error ? e.message : String(e)}`;
      continue;
    }
    if (![...announced].some(k => newKeys.has(k))) {
      reason = `inscribed DID document does not announce an Ed25519 key of newController ${newController}`;
      continue;
    }

    // (d) the reinscription must STRICTLY POSTDATE the current anchor
    // inscription. PRIMARY signal: each inscription's confirmed block height
    // (via getInscriptionById) — independent of getInscriptionsBySatoshi's
    // list order, so a provider violating the documented oldest-first contract
    // cannot invert this check into accepting a pre-anchor inscription. The
    // list index is trusted ONLY as a same-height (same-block) tiebreak.
    // Everything unprovable fails closed: no enumeration capability, either
    // inscription absent from the sat's list, either block height unavailable,
    // or a same-height list that does not place the rotation strictly after
    // the anchor all REJECT the rotation.
    if (typeof ordinalsProvider?.getInscriptionsBySatoshi !== 'function') {
      return { accepted: false, reason: `ordinals provider cannot enumerate inscriptions on satoshi ${anchoredSat.satoshi}; reinscription order is unprovable` };
    }
    let onSat: Array<{ inscriptionId: string }>;
    try {
      onSat = await ordinalsProvider.getInscriptionsBySatoshi(anchoredSat.satoshi);
    } catch (e) {
      reason = `failed to list inscriptions on satoshi ${anchoredSat.satoshi}: ${e instanceof Error ? e.message : String(e)}`;
      continue;
    }
    const anchorIdx = onSat.findIndex(i => i.inscriptionId === anchoredSat.inscriptionId);
    const rotationIdx = onSat.findIndex(i => i.inscriptionId === candidate.inscriptionId);
    if (anchorIdx === -1 || rotationIdx === -1) {
      reason = `rotation inscription ${candidate.inscriptionId} or anchor inscription ${anchoredSat.inscriptionId} is not enumerated on satoshi ${anchoredSat.satoshi}`;
      continue;
    }

    // anchorHeight was fetched once above the loop (anchor is fixed).
    if (rotationHeight === undefined || anchorHeight === undefined) {
      reason = `cannot order rotation inscription ${candidate.inscriptionId} against anchor inscription ${anchoredSat.inscriptionId}: block heights unavailable from the provider; ordering is unprovable`;
      continue;
    }
    if (rotationHeight < anchorHeight) {
      reason = `rotation inscription ${candidate.inscriptionId} (block ${rotationHeight}) predates anchor inscription ${anchoredSat.inscriptionId} (block ${anchorHeight}) on satoshi ${anchoredSat.satoshi}`;
      continue;
    }
    if (rotationHeight === anchorHeight && rotationIdx <= anchorIdx) {
      reason = `rotation inscription ${candidate.inscriptionId} does not appear strictly after anchor inscription ${anchoredSat.inscriptionId} on satoshi ${anchoredSat.satoshi}`;
      continue;
    }

    return { accepted: true, inscriptionId: candidate.inscriptionId };
  }

  return { accepted: false, reason };
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
  return key ? Buffer.from(key).toString('hex') : null;
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
  anchoredSat?: AnchoredSat
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
  let nonCooperativeInscriptionId: string | undefined;
  if (!customVerifier && authorizedKeyIds && index > 0) {
    for (const { proof, originalIndex } of controllerProofs) {
      const keyHex = await resolveControllerKeyHex(proof.verificationMethod, resolveKey);
      if (keyHex === null || !authorizedKeyIds.has(keyHex)) {
        // Non-cooperative rotation (#366): ONLY a rotateKey event — and only
        // when the log already has a bitcoin-anchored authority — may take the
        // alternate, reinscription-attested path instead of failing here. The
        // candidacy re-checks EVERY controller proof against the announced
        // newController (condition c), so once accepted the remaining
        // per-proof checks against the OLD set are superseded. Every other
        // event type, and every failed candidacy, fails exactly as before.
        let candidacyReason: string | undefined;
        if (event.type === 'rotateKey' && anchoredSat) {
          const candidacy = await evaluateNonCooperativeRotation(
            event, controllerProofs, anchoredSat, ordinalsProvider, resolveKey
          );
          if (candidacy.accepted) {
            nonCooperativeInscriptionId = candidacy.inscriptionId;
            break;
          }
          candidacyReason = candidacy.reason;
        }
        errors.push(
          `Event ${index}, Proof ${originalIndex}: signer ${proof.verificationMethod} is not authorized by the log's create event`
        );
        if (candidacyReason !== undefined) {
          errors.push(`Event ${index}: non-cooperative rotation rejected: ${candidacyReason}`);
        }
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
        const { verified, cryptographicallyVerified } = await dispatchVerify(proof, eventData, resolveKey);
        if (!verified) {
          allControllerProofsValid = false;
          errors.push(`Event ${index}, Proof ${originalIndex}: Verification failed`);
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
    // Report the non-cooperative acceptance only when the event fully
    // verified — a candidacy followed by a signature/witness failure is not
    // an accepted rotation.
    ...(nonCooperativeInscriptionId !== undefined && allControllerProofsValid && chainValid
      ? { nonCooperativeRotation: { inscriptionId: nonCooperativeInscriptionId } }
      : {}),
    errors,
  };

  if (witnessResults.length > 0) {
    result.witnessProofs = witnessResults;
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
  // `authorizedKeyIds` EVOLVES: each event is authorized against the set as it
  // stood when the event was appended, and a fully valid rotateKey event swaps
  // the set for subsequent iterations.
  //
  // Companion walk state (#366): once a btco migrate's SIGNED anchoring sat is
  // confirmed by a matching bitcoin witness proof, the log's authority is
  // anchored to that sat. Default-path only; a custom verifier owns semantics.
  let anchoredSat: AnchoredSat | undefined;
  for (let i = 0; i < log.events.length; i++) {
    const event = log.events[i];
    const previousEvent = i > 0 ? log.events[i - 1] : undefined;
    const eventResult = await verifyEvent(event, i, options?.verifier, previousEvent, options?.resolveKey, authorizedKeyIds, options?.ordinalsProvider, anchoredSat);

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
            }
          }
        }
      } else if (event.type === 'rotateKey' && eventResult.nonCooperativeRotation && anchoredSat) {
        // The accepted reinscription becomes the new anchor, so a CHAINED
        // non-cooperative rotation must reinscribe strictly after it.
        anchoredSat = { satoshi: anchoredSat.satoshi, inscriptionId: eventResult.nonCooperativeRotation.inscriptionId };
      }
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
    uniquenessError = (await verifyUniqueness(assetDid, anchoredSat, options?.ordinalsProvider)) ?? undefined;
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
  };
}
