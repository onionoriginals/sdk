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
import { Verifier } from '../vc/Verifier';
import { verifyEventLog } from '../cel/algorithms/verifyEventLog';
import type { DIDManager } from '../did/DIDManager';
import type { VerifiableCredential } from '../types';
import type { EventLog } from '../cel/types';

export type VerifiableKind = 'credential' | 'eventLog' | 'unknown';

/** Normalized result shape across all verifier branches. */
export interface UnifiedVerificationResult {
  kind: VerifiableKind;
  verified: boolean;
  errors: string[];
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

export class UnifiedVerifier {
  constructor(private didManager: DIDManager) {}

  /**
   * Verify a document by inferring its kind and delegating to the appropriate
   * verifier. The credential branch goes through the issuer-bound `Verifier`
   * (plan 001) — it never trusts a proof-embedded key.
   */
  async verify(document: unknown): Promise<UnifiedVerificationResult> {
    const kind = classifyDocument(document);

    switch (kind) {
      case 'credential': {
        const verifier = new Verifier(this.didManager);
        const res = await verifier.verifyCredential(document as VerifiableCredential);
        return { kind, verified: res.verified, errors: res.errors, details: res };
      }
      case 'eventLog': {
        const res = await verifyEventLog(document as EventLog);
        return { kind, verified: res.verified, errors: res.errors, details: res };
      }
      default:
        return {
          kind: 'unknown',
          verified: false,
          errors: ['Unable to classify document: no recognized credential or event-log shape'],
        };
    }
  }
}
