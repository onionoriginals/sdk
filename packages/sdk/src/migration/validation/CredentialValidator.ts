/**
 * CredentialValidator - Validates credential compatibility for migration
 */

import {
  MigrationOptions,
  MigrationValidationResult,
  ValidationError,
  ValidationWarning,
  IValidator
} from '../types';
import { OriginalsConfig } from '../../types';
import { CredentialManager } from '../../vc/CredentialManager';

/**
 * Required top-level fields for a structurally well-formed W3C Verifiable Credential.
 * We do NOT re-verify cryptographic proofs here — that is the job of CredentialManager.
 * The goal is to catch obviously malformed credentials (missing mandatory fields)
 * before committing to a migration that will fail later.
 *
 * Design decision (DEF-020): conservative structural check only.
 * - Hard error  → credential is missing one or more mandatory W3C VC fields
 *                 (@context, type, issuer, credentialSubject).
 * - Warning     → credential is present but structurally ambiguous (e.g. unusual
 *                 shapes we can't fully validate without schema resolution).
 * - No action   → no credentials attached (valid; issuance happens post-migration).
 *
 * Credentials are supplied via options.metadata.credentials as an array of
 * plain objects (not yet signed, or already-signed VCs attached to the asset).
 */
export class CredentialValidator implements IValidator {
  constructor(
    private config: OriginalsConfig,
    private credentialManager: CredentialManager
  ) {}

  async validate(options: MigrationOptions): Promise<MigrationValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    try {
      // Credential validation is skipped if credentialIssuance is explicitly false
      if (options.credentialIssuance === false) {
        return this.createResult(errors, warnings);
      }

      // Retrieve credentials from metadata (optional — no credentials is valid)
      const rawCredentials = options.metadata?.['credentials'];
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
            field: `metadata.credentials[${i}]`,
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
            field: `metadata.credentials[${i}]`,
            details: { index: i, missingFields: missing }
          });
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
