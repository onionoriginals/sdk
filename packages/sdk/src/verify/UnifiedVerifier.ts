/**
 * SPIKE / PoC — NOT a shipped API.
 *
 * Prototype of a single `verify(document)` front door that infers the document
 * kind and delegates to the existing, concern-specific verifiers. This file is
 * intentionally internal (not exported from the package index) until the design
 * in plans/013-unified-verify-design.md is approved.
 *
 * Covered in this PoC: W3C Verifiable Credentials (via the issuer-bound
 * `Verifier` from plan 001) and CEL event logs (via `verifyEventLog`). did:btco
 * resolution is described in the design doc but not wired here.
 */
import { Verifier, type StatusListResolver } from '../vc/Verifier.js';
import { verifyEventLog } from '@originals/cel';
import { createDidManagerKeyResolver } from '@originals/cel';
import type { DIDManager } from '../did/DIDManager.js';
import type { VerifiableCredential } from '../types/index.js';
import type { EventLog, OrdinalsLookup } from '@originals/cel';

export type VerifiableKind = 'credential' | 'eventLog' | 'unknown';

/**
 * Whether a security-relevant check actually ran, and what it found:
 * - `checked`: the check ran and passed.
 * - `failed`: the check ran and did not pass (this always makes `verified: false`).
 * - `unknown`: the check did NOT run, because a required dependency
 *   (a `statusListResolver`, an `ordinalsProvider`) was not configured, or
 *   because the caller explicitly asked for signature-only verification. An
 *   `unknown` entry is not evidence of anything — a caller that needs that
 *   property to hold must supply the dependency or reject `unknown` per its
 *   own policy (issue #600).
 */
export type CheckState = 'checked' | 'failed' | 'unknown';

/** Normalized result shape across all verifier branches. */
export interface UnifiedVerificationResult {
  kind: VerifiableKind;
  verified: boolean;
  errors: string[];
  /**
   * Per-check breakdown of what actually ran, keyed by the properties
   * relevant to this document's kind. `verified: true` means every listed
   * check is `checked`; it never means an `unknown` entry can be read as a
   * pass. A credential result reports `signature`/`status`, each
   * independently attributable.
   *
   * An event-log result also reports `signature`/`freshness`, but
   * `verifyEventLog` returns one aggregate verdict bundling proof validity,
   * chain/authority checks, uniqueness and (when requested) head-freshness —
   * it does not expose which sub-check failed. So for an event log:
   *  - `signature` reflects that WHOLE bundled verdict (`checked`/`failed`),
   *    not narrowly cryptographic proof validity — a `failed` here may be a
   *    stale head or a uniqueness conflict, not necessarily a bad signature;
   *  - `freshness` is populated only as an affirmative, provable signal:
   *    `checked` when the log is actually btco-anchored, a provider was
   *    consulted, and the log verified (head-freshness gates `verified`, so a
   *    true verdict proves it passed); `unknown` in every other case,
   *    INCLUDING when the bundled verdict failed — a false verdict is never
   *    attributed to freshness specifically, since it cannot be
   *    distinguished from a proof, chain, or uniqueness failure without
   *    deeper support from `verifyEventLog` itself.
   */
  assurance: Partial<Record<'signature' | 'status' | 'freshness', CheckState>>;
  /** The raw result from the underlying verifier, for callers that need detail. */
  details?: unknown;
}

/**
 * Whether any event in the log carries a `bitcoin-ordinals-2024` witness
 * proof — i.e. the log is anchored to a satoshi, so head-freshness is
 * something to actually check rather than the documented no-op
 * `checkHeadFreshness` is for an unanchored log (see `VerifyOptions.checkHeadFreshness`
 * in `@originals/cel`).
 */
function eventLogHasBitcoinWitness(log: EventLog): boolean {
  // `document` reaches verify() as `unknown` and classifyDocument only checks
  // that `events` is an array — a malformed/attacker-supplied log can have a
  // missing or non-array `proof` (or a non-object event) on some entry.
  // verifyEventLog itself handles that by returning a failed result; this
  // helper must not throw on the same input and turn verify() into a
  // rejected promise instead of the `verified: false` result it should be.
  return log.events.some((event) => {
    const proof = (event as { proof?: unknown } | null)?.proof;
    return (
      Array.isArray(proof) &&
      proof.some((p) => (p as { cryptosuite?: string } | null)?.cryptosuite === 'bitcoin-ordinals-2024')
    );
  });
}

/** Heuristic discriminator. Returns the kind a document should route to. */
export function classifyDocument(document: unknown): VerifiableKind {
  if (!document || typeof document !== 'object') return 'unknown';
  const doc = document as Record<string, unknown>;

  // CEL event log: has an `events` array.
  if (Array.isArray(doc.events)) return 'eventLog';

  // W3C Verifiable Credential: `type` includes 'VerifiableCredential'.
  const type = doc.type;
  const types = Array.isArray(type) ? type : typeof type === 'string' ? [type] : [];
  if (types.includes('VerifiableCredential')) return 'credential';

  return 'unknown';
}

export interface UnifiedVerifierOptions {
  /**
   * Required to verify event logs carrying bitcoin-ordinals-2024 witness
   * proofs — btco anchoring is gating (see verifyEventLog) — and to check
   * head freshness. Without it, `freshness` reports `unknown` rather than
   * being silently skipped; `verified` still fails closed for a log whose
   * witness proof actually requires a provider.
   */
  ordinalsProvider?: OrdinalsLookup;
  /**
   * Required to check a credential's `credentialStatus` (revocation /
   * suspension). Without it, a credential that declares a status entry
   * fails closed (its status is unknown, not verified) unless `signatureOnly`
   * is set.
   */
  statusListResolver?: StatusListResolver;
  /**
   * Explicitly request signature/proof-only verification for this call:
   * status and head-freshness checks are skipped even when their
   * dependencies are configured, and reported `unknown` rather than
   * `checked`. Ordinary callers should leave this false — the safe default
   * runs every check it can and fails closed on what it can't (issue #600).
   * Use this only when the caller has an independent, out-of-band reason to
   * trust current authority (e.g. offline/air-gapped verification).
   */
  signatureOnly?: boolean;
}

export class UnifiedVerifier {
  constructor(
    private didManager: DIDManager,
    private options?: UnifiedVerifierOptions
  ) {}

  /**
   * Verify a document by inferring its kind and delegating to the appropriate
   * verifier. The credential branch goes through the issuer-bound `Verifier`
   * (plan 001) — it never trusts a proof-embedded key.
   *
   * Safe by default: status/freshness checks run whenever their dependency is
   * configured, and a declared-but-uncheckable property fails closed rather
   * than being silently treated as passing (issue #600). Consult
   * `result.assurance` rather than `result.verified` alone to tell "checked
   * and passed" apart from "not checked at all".
   */
  async verify(document: unknown): Promise<UnifiedVerificationResult> {
    const kind = classifyDocument(document);
    const signatureOnly = this.options?.signatureOnly === true;

    switch (kind) {
      case 'credential': {
        const credential = document as VerifiableCredential;
        const verifier = new Verifier(this.didManager, { statusListResolver: this.options?.statusListResolver });
        const sigRes = await verifier.verifyCredential(credential, { checkStatus: false });

        let statusState: CheckState;
        let verified = sigRes.verified;
        const errors = [...sigRes.errors];

        if (!sigRes.verified) {
          // Signature already failed; status is moot and was not evaluated.
          statusState = 'unknown';
        } else if (signatureOnly) {
          statusState = 'unknown';
        } else if (!credential.credentialStatus) {
          statusState = 'checked'; // nothing declared: vacuously fine
        } else if (!this.options?.statusListResolver) {
          // Declared but uncheckable: a missing dependency, not a pass.
          statusState = 'unknown';
          verified = false;
          errors.push(
            'Credential declares credentialStatus but no statusListResolver is configured; status is unknown, not verified.'
          );
        } else {
          try {
            // checkCredentialStatus awaits statusListResolver directly with
            // no internal try/catch; a rejecting resolver (a network
            // failure, not a bug) must not escape this method as a thrown
            // exception — verify() always returns a result, never rejects.
            const statusRes = await verifier.checkCredentialStatus(credential);
            statusState = statusRes.verified ? 'checked' : 'failed';
            if (!statusRes.verified) {
              verified = false;
              errors.push(...statusRes.errors);
            }
          } catch (err) {
            statusState = 'unknown';
            verified = false;
            errors.push(`statusListResolver failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        return {
          kind,
          verified,
          errors,
          assurance: { signature: sigRes.verified ? 'checked' : 'failed', status: statusState },
          details: { signature: sigRes },
        };
      }
      case 'eventLog': {
        const log = document as EventLog;
        const provider = signatureOnly ? undefined : this.options?.ordinalsProvider;
        const res = await verifyEventLog(log, {
          resolveKey: createDidManagerKeyResolver(this.didManager),
          ordinalsProvider: provider,
          checkHeadFreshness: provider !== undefined,
        });
        // Only claim freshness was actually exercised when the log is
        // genuinely anchored (checkHeadFreshness is a documented no-op
        // otherwise) AND a provider was consulted. Even then, only ever
        // report the affirmative `checked` case: a false `verified` cannot be
        // attributed to freshness specifically over proof/chain/uniqueness
        // (see the field's doc on UnifiedVerificationResult.assurance).
        const freshnessExercised = !signatureOnly && provider !== undefined && eventLogHasBitcoinWitness(log);
        const freshness: CheckState = freshnessExercised && res.verified ? 'checked' : 'unknown';
        return {
          kind,
          verified: res.verified,
          errors: res.errors,
          assurance: { signature: res.verified ? 'checked' : 'failed', freshness },
          details: res,
        };
      }
      default:
        return {
          kind: 'unknown',
          verified: false,
          errors: ['Unable to classify document: no recognized credential or event-log shape'],
          assurance: {},
        };
    }
  }
}
