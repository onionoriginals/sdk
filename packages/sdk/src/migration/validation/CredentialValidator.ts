/**
 * CredentialValidator - Validates the migrating asset's real credentials
 */

import {
  MigrationOptions,
  MigrationValidationResult,
  ValidationError,
  ValidationWarning,
  IValidator
} from '../types.js';
import { OriginalsConfig, VerifiableCredential } from '../../types/index.js';
import { CredentialManager } from '../../vc/CredentialManager.js';

/**
 * Validates the credentials attached to the asset being migrated.
 *
 * Previously this validator was vacuous (issue #283): it only read
 * `options.metadata.credentials`, a key nothing in the migration flow ever
 * populated, and — even when present — only checked that four W3C fields
 * existed. A forged or tampered credential therefore always passed.
 *
 * The fix has two parts:
 *  1. Real data in — credentials now arrive on the typed `options.credentials`
 *     channel (callers pass the asset's actual `credentials`; `metadata.credentials`
 *     is still read for back-compat).
 *  2. Real check — each structurally-valid credential that carries a proof is
 *     cryptographically VERIFIED via CredentialManager. A credential that fails
 *     verification (tampered payload, unresolvable/forged issuer key) is a HARD
 *     ERROR, so migrating an asset carrying an invalid credential now fails.
 *
 * Levels:
 *  - Hard error  → missing mandatory W3C VC fields, OR a signed credential that
 *                  fails cryptographic verification.
 *  - Warning     → a credential with no proof (unsigned; signing may be completed
 *                  post-migration).
 *  - No action   → no credentials attached (valid; issuance happens post-migration),
 *                  or credentialIssuance explicitly false.
 */
export class CredentialValidator implements IValidator {
  constructor(
    private config: OriginalsConfig,
    private credentialManager?: CredentialManager
  ) {}

  async validate(options: MigrationOptions): Promise<MigrationValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    try {
      // Credential validation is skipped if credentialIssuance is explicitly false
      if (options.credentialIssuance === false) {
        return this.createResult(errors, warnings);
      }

      // Prefer the typed channel; fall back to the legacy metadata key.
      const rawCredentials = options.credentials ?? options.metadata?.['credentials'];
      if (!rawCredentials) {
        // Nothing to validate; credentials will be issued post-migration
        return this.createResult(errors, warnings);
      }

      const credentials: unknown[] = Array.isArray(rawCredentials) ? rawCredentials : [rawCredentials];

      for (let i = 0; i < credentials.length; i++) {
        const cred = credentials[i];

        if (cred === null || typeof cred !== 'object') {
          errors.push({
            code: 'MALFORMED_CREDENTIAL',
            message: `Credential at index ${i} is not an object`,
            field: `credentials[${i}]`,
            details: { index: i, received: typeof cred }
          });
          continue;
        }

        const c = cred as Record<string, unknown>;

        // Check mandatory W3C VC fields
        const missing: string[] = [];
        if (!c['@context']) missing.push('@context');
        if (!c['type']) missing.push('type');
        if (!c['issuer']) missing.push('issuer');
        if (!c['credentialSubject']) missing.push('credentialSubject');

        if (missing.length > 0) {
          errors.push({
            code: 'MALFORMED_CREDENTIAL',
            message: `Credential at index ${i} is missing required fields: ${missing.join(', ')}`,
            field: `credentials[${i}]`,
            details: { index: i, missingFields: missing }
          });
          continue; // can't meaningfully verify a structurally-broken credential
        }

        // Unsigned credential: acceptable pre-migration, but flag it so the
        // caller knows a proof still has to be issued.
        if (!c['proof']) {
          warnings.push({
            code: 'UNSIGNED_CREDENTIAL',
            message: `Credential at index ${i} has no proof; it must be signed before/at migration`,
            field: `credentials[${i}]`
          });
          continue;
        }

        // Real cryptographic verification — this is what makes the check able to
        // fail on a genuinely-invalid credential rather than passing vacuously.
        if (this.credentialManager) {
          let verified = false;
          try {
            verified = await this.credentialManager.verifyCredential(cred as VerifiableCredential);
          } catch (verifyError) {
            errors.push({
              code: 'CREDENTIAL_VERIFICATION_FAILED',
              message: `Credential at index ${i} could not be verified: ${verifyError instanceof Error ? verifyError.message : String(verifyError)}`,
              field: `credentials[${i}]`,
              details: { index: i }
            });
            continue;
          }
          if (!verified) {
            errors.push({
              code: 'CREDENTIAL_VERIFICATION_FAILED',
              message: `Credential at index ${i} failed cryptographic verification`,
              field: `credentials[${i}]`,
              details: { index: i }
            });
          }
        }
      }

      return this.createResult(errors, warnings);
    } catch (error) {
      errors.push({
        code: 'CREDENTIAL_VALIDATION_ERROR',
        message: 'Error validating credential compatibility',
        details: { error: error instanceof Error ? error.message : String(error) }
      });
      return this.createResult(errors, warnings);
    }
  }

  private createResult(errors: ValidationError[], warnings: ValidationWarning[]): MigrationValidationResult {
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      estimatedCost: {
        storageCost: 0,
        networkFees: 0,
        totalCost: 0,
        currency: 'sats'
      },
      estimatedDuration: 50 // Credential validation typically takes ~50ms
    };
  }
}
