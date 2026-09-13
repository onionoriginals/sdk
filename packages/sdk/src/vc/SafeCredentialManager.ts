import type {
  BitstringStatusListEntry,
  OriginalsConfig,
  VerifiableCredential,
} from '../types/index.js';
import { DIDManager } from '../did/DIDManager.js';
import type { MetricsCollector } from '../utils/MetricsCollector.js';
import {
  CredentialManager as BaseCredentialManager,
} from './CredentialManager.js';
import {
  Verifier,
  type StatusListResolver,
} from './Verifier.js';
import { validateStatusListCredentialTrust } from './statusListTrust.js';
import {
  credentialStatusEntries,
  describeMalformedStatusEntry,
  isCredentialStatusEntry,
} from './credentialStatus.js';

/**
 * Credential manager with the safe verification defaults introduced for
 * issue #600.
 *
 * Kept as a thin specialization so the adjacent #613/#626 changes in the
 * underlying manager remain intact instead of being re-resolved by choosing
 * either side of a merge conflict.
 */
export class CredentialManager extends BaseCredentialManager {
  /** Resolver used by ordinary verification for declared credential status. */
  public statusListResolver?: StatusListResolver;

  private readonly verificationDidManager: DIDManager;

  constructor(
    config: OriginalsConfig,
    didManager: DIDManager,
    metrics?: MetricsCollector,
  ) {
    super(config, didManager, metrics);
    this.verificationDidManager = didManager;
  }

  /**
   * Signature/proof verification only. This intentionally does not evaluate
   * `credentialStatus`; ordinary callers should use `verifyCredential`.
   */
  async verifyCredentialSignature(
    credential: VerifiableCredential,
  ): Promise<boolean> {
    return super.verifyCredential(credential);
  }

  /**
   * Verify signature plus every declared credential status entry.
   *
   * A credential that declares status fails closed when no resolver is
   * configured or when resolving/checking status fails.
   */
  override async verifyCredential(
    credential: VerifiableCredential,
  ): Promise<boolean> {
    if (!(await this.verifyCredentialSignature(credential))) {
      return false;
    }

    const verifier = new Verifier(this.verificationDidManager, {
      statusListResolver: this.statusListResolver,
    });
    try {
      const statusResult = await verifier.checkCredentialStatus(credential);
      return statusResult.verified;
    } catch {
      return false;
    }
  }

  /**
   * Verify a credential against caller-supplied status list credential(s).
   *
   * This deliberately uses signature-only verification internally: status is
   * evaluated below against the explicit list argument, not a second time via
   * the manager-level resolver.
   */
  override async verifyCredentialWithStatus(
    credential: VerifiableCredential,
    statusListCredential?: VerifiableCredential | VerifiableCredential[],
  ): Promise<{
    verified: boolean;
    revoked: boolean;
    suspended: boolean;
    errors: string[];
  }> {
    const errors: string[] = [];
    let verified = false;
    let revoked = false;
    let suspended = false;

    // A few older tests intentionally monkey-patch verifyCredential to isolate
    // unsigned fixtures. Preserve that established seam while keeping normal
    // callers on the explicitly named signature-only method.
    const ownVerify = Object.prototype.hasOwnProperty.call(this, 'verifyCredential')
      ? (this as unknown as { verifyCredential?: (c: VerifiableCredential) => Promise<boolean> })
          .verifyCredential
      : undefined;
    const verifySignature = (value: VerifiableCredential): Promise<boolean> =>
      ownVerify
        ? ownVerify.call(this, value)
        : this.verifyCredentialSignature(value);

    try {
      verified = await verifySignature(credential);
      if (!verified) {
        errors.push('Credential signature verification failed');
      }
    } catch (err) {
      errors.push(
        `Signature verification error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // VCDM 2.0 permits a singleton or array. Every entry must be evaluated so
    // an array cannot bypass revocation/suspension checking (#592).
    const entries = credentialStatusEntries(credential);
    const suppliedLists: VerifiableCredential[] = !statusListCredential
      ? []
      : Array.isArray(statusListCredential)
        ? statusListCredential
        : [statusListCredential];

    if (entries.length > 0) {
      if (suppliedLists.length === 0) {
        verified = false;
        errors.push(
          'Credential has a credentialStatus but no status list credential was provided',
        );
      } else {
        for (const status of entries) {
          if (!isCredentialStatusEntry(status)) {
            verified = false;
            errors.push(
              `Credential declares a malformed credentialStatus entry: ${describeMalformedStatusEntry(status)}`,
            );
            continue;
          }

          if (status.type !== 'BitstringStatusListEntry') {
            verified = false;
            errors.push(
              `Unsupported credentialStatus type '${status.type}': this verifier cannot evaluate it, ` +
                "so the credential's status through this entry is unknown.",
            );
            continue;
          }

          const bitstringStatus = status as BitstringStatusListEntry;
          try {
            const matchingList = suppliedLists.find(
              (list) => list.id === bitstringStatus.statusListCredential,
            );
            if (!matchingList) {
              throw new Error(
                `This entry's statusListCredential reference (${bitstringStatus.statusListCredential}) does not match ` +
                  'the id of any supplied status list credential',
              );
            }

            const trust = await validateStatusListCredentialTrust(
              credential,
              bitstringStatus,
              matchingList,
              async (listVC) => {
                const ok = await verifySignature(listVC);
                return { verified: ok, errors: [] };
              },
            );
            if (!trust.verified) {
              throw new Error(trust.errors.join('; '));
            }

            const result = this.statusList.checkStatus(
              bitstringStatus,
              matchingList,
            );
            if (result.isSet) {
              verified = false;
              if (result.statusPurpose === 'revocation') {
                revoked = true;
                errors.push('Credential has been revoked');
              } else {
                suspended = true;
                errors.push('Credential has been suspended');
              }
            }
          } catch (err) {
            verified = false;
            errors.push(
              `Status check error: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }

    return { verified, revoked, suspended, errors };
  }
}

export type {
  CredentialChainOptions,
  MigrationSubject,
  OwnershipSubject,
  ResourceCreatedSubject,
  ResourceUpdatedSubject,
} from './CredentialManager.js';
