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
   * pass. A credential result reports `signature`/`status`; an event-log
   * result reports `signature`/`freshness` (chain-proof validity and
   * btco-anchoring/head-freshness respectively).
   */
  assurance: Partial<Record<'signature' | 'status' | 'freshness', CheckState>>;
  /** The raw result from the underlying verifier, for callers that need detail. */
  details?: unknown;
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
          const statusRes = await verifier.checkCredentialStatus(credential);
          statusState = statusRes.verified ? 'checked' : 'failed';
          if (!statusRes.verified) {
            verified = false;
            errors.push(...statusRes.errors);
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
        const provider = signatureOnly ? undefined : this.options?.ordinalsProvider;
        const res = await verifyEventLog(document as EventLog, {
          resolveKey: createDidManagerKeyResolver(this.didManager),
          ordinalsProvider: provider,
          checkHeadFreshness: provider !== undefined,
        });
        // Whether a witness/head-freshness check was actually needed and run
        // is internal to verifyEventLog; conservatively report `unknown`
        // whenever no provider was consulted, rather than guessing it was
        // vacuous. `verified` itself already fails closed when a provider was
        // genuinely required (see verifyEventLog's own witness handling).
        const freshness: CheckState = signatureOnly || provider === undefined ? 'unknown' : (res.verified ? 'checked' : 'failed');
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
