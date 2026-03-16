import {
  VerifiableCredential,
  BitstringStatusListEntry,
  BitstringStatusListSubject,
  StatusPurpose,
} from '../types';
import { gzipSync, gunzipSync } from 'node:zlib';

/**
 * Options for creating a new status list.
 */
export interface StatusListOptions {
  /** Unique ID for the status list credential (URL or URN) */
  id: string;
  /** Issuer DID */
  issuer: string;
  /** Status purpose: 'revocation' or 'suspension' */
  statusPurpose: StatusPurpose;
  /** Number of entries in the bitstring (minimum 131072 per spec, default 131072) */
  length?: number;
}

/**
 * Result of checking a credential's revocation/suspension status.
 */
export interface StatusCheckResult {
  /** Whether the credential's status bit is set */
  isSet: boolean;
  /** The purpose that was checked */
  statusPurpose: StatusPurpose;
  /** The index that was checked */
  statusListIndex: number;
}

// Minimum bitstring length per W3C spec
const MINIMUM_BITSTRING_LENGTH = 131072;

/**
 * Manages W3C Bitstring Status List credentials for credential revocation and suspension.
 *
 * Implements the W3C Verifiable Credentials Bitstring Status List v1.0 specification.
 * Status lists use a compressed bitstring where each bit represents the status of a credential.
 *
 * @example
 * ```typescript
 * const manager = new StatusListManager();
 *
 * // Create a status list credential
 * const statusListVC = manager.createStatusListCredential({
 *   id: 'https://example.com/status/1',
 *   issuer: 'did:example:issuer',
 *   statusPurpose: 'revocation',
 * });
 *
 * // Allocate a status entry for a new credential
 * const entry = manager.allocateStatusEntry(
 *   'https://example.com/status/1',
 *   42,
 *   'revocation'
 * );
 *
 * // Revoke a credential by setting its bit
 * const updatedVC = manager.setStatus(statusListVC, 42, true);
 *
 * // Check if a credential is revoked
 * const result = manager.checkStatus(entry, updatedVC);
 * // result.isSet === true
 * ```
 */
export class StatusListManager {
  /**
   * Create a new BitstringStatusListCredential with an empty (all-zeros) bitstring.
   *
   * @param options - Configuration for the status list
   * @returns An unsigned BitstringStatusListCredential
   */
  createStatusListCredential(options: StatusListOptions): VerifiableCredential {
    const length = options.length ?? MINIMUM_BITSTRING_LENGTH;

    if (length < MINIMUM_BITSTRING_LENGTH) {
      throw new Error(
        `Status list length must be at least ${MINIMUM_BITSTRING_LENGTH} per W3C spec, got ${length}`
      );
    }

    const bitstring = new Uint8Array(Math.ceil(length / 8));
    const encodedList = StatusListManager.encodeBitstring(bitstring);

    const credential: VerifiableCredential = {
      '@context': [
        'https://www.w3.org/ns/credentials/v2',
      ],
      type: ['VerifiableCredential', 'BitstringStatusListCredential'],
      id: options.id,
      issuer: options.issuer,
      issuanceDate: new Date().toISOString(),
      credentialSubject: {
        type: 'BitstringStatusList',
        statusPurpose: options.statusPurpose,
        encodedList,
      } as BitstringStatusListSubject,
    };

    return credential;
  }

  /**
   * Create a BitstringStatusListEntry to embed in a credential's `credentialStatus`.
   *
   * @param statusListCredentialId - URL/URN of the status list credential
   * @param statusListIndex - Bit index within the status list
   * @param statusPurpose - Purpose: 'revocation' or 'suspension'
   * @returns A BitstringStatusListEntry object
   */
  allocateStatusEntry(
    statusListCredentialId: string,
    statusListIndex: number,
    statusPurpose: StatusPurpose
  ): BitstringStatusListEntry {
    if (!Number.isInteger(statusListIndex) || statusListIndex < 0) {
      throw new Error('statusListIndex must be a non-negative integer');
    }

    return {
      id: `${statusListCredentialId}#${statusListIndex}`,
      type: 'BitstringStatusListEntry',
      statusPurpose,
      statusListIndex: String(statusListIndex),
      statusListCredential: statusListCredentialId,
    };
  }

  /**
   * Set or clear a status bit in a BitstringStatusListCredential.
   *
   * @param statusListCredential - The status list credential to update
   * @param index - The bit index to set or clear
   * @param value - true to set (revoke/suspend), false to clear (un-suspend)
   * @returns A new credential with the updated bitstring
   */
  setStatus(
    statusListCredential: VerifiableCredential,
    index: number,
    value: boolean
  ): VerifiableCredential {
    this.validateStatusListCredential(statusListCredential);

    if (!Number.isInteger(index) || index < 0) {
      throw new Error('index must be a non-negative integer');
    }

    const subject = statusListCredential.credentialSubject as BitstringStatusListSubject;
    const bitstring = StatusListManager.decodeBitstring(subject.encodedList);

    const byteIndex = Math.floor(index / 8);
    const bitIndex = 7 - (index % 8); // MSB first

    if (byteIndex >= bitstring.length) {
      throw new Error(
        `index ${index} exceeds status list capacity of ${bitstring.length * 8}`
      );
    }

    const updated = new Uint8Array(bitstring);
    if (value) {
      updated[byteIndex] |= (1 << bitIndex);
    } else {
      updated[byteIndex] &= ~(1 << bitIndex);
    }

    const newSubject: BitstringStatusListSubject = {
      ...subject,
      encodedList: StatusListManager.encodeBitstring(updated),
    };

    return {
      ...statusListCredential,
      credentialSubject: newSubject,
      issuanceDate: new Date().toISOString(),
    };
  }

  /**
   * Check the status of a credential against a status list credential.
   *
   * @param entry - The BitstringStatusListEntry from the credential's credentialStatus
   * @param statusListCredential - The resolved status list credential
   * @returns Status check result indicating if the bit is set
   */
  checkStatus(
    entry: BitstringStatusListEntry,
    statusListCredential: VerifiableCredential
  ): StatusCheckResult {
    this.validateStatusListCredential(statusListCredential);

    const subject = statusListCredential.credentialSubject as BitstringStatusListSubject;

    if (entry.statusPurpose !== subject.statusPurpose) {
      throw new Error(
        `Status purpose mismatch: entry has '${entry.statusPurpose}' but status list has '${subject.statusPurpose}'`
      );
    }

    const index = parseInt(entry.statusListIndex, 10);
    if (isNaN(index) || index < 0) {
      throw new Error(`Invalid statusListIndex: ${entry.statusListIndex}`);
    }

    const bitstring = StatusListManager.decodeBitstring(subject.encodedList);
    const byteIndex = Math.floor(index / 8);
    const bitIndex = 7 - (index % 8);

    if (byteIndex >= bitstring.length) {
      throw new Error(
        `statusListIndex ${index} exceeds status list capacity of ${bitstring.length * 8}`
      );
    }

    const isSet = (bitstring[byteIndex] & (1 << bitIndex)) !== 0;

    return {
      isSet,
      statusPurpose: entry.statusPurpose,
      statusListIndex: index,
    };
  }

  /**
   * Batch-set multiple status bits in a single operation.
   *
   * @param statusListCredential - The status list credential to update
   * @param updates - Array of [index, value] pairs
   * @returns A new credential with all bits updated
   */
  batchSetStatus(
    statusListCredential: VerifiableCredential,
    updates: Array<[index: number, value: boolean]>
  ): VerifiableCredential {
    this.validateStatusListCredential(statusListCredential);

    const subject = statusListCredential.credentialSubject as BitstringStatusListSubject;
    const bitstring = StatusListManager.decodeBitstring(subject.encodedList);
    const updated = new Uint8Array(bitstring);

    for (const [index, value] of updates) {
      if (!Number.isInteger(index) || index < 0) {
        throw new Error(`index must be a non-negative integer, got ${index}`);
      }

      const byteIndex = Math.floor(index / 8);
      const bitIndex = 7 - (index % 8);

      if (byteIndex >= updated.length) {
        throw new Error(
          `index ${index} exceeds status list capacity of ${updated.length * 8}`
        );
      }

      if (value) {
        updated[byteIndex] |= (1 << bitIndex);
      } else {
        updated[byteIndex] &= ~(1 << bitIndex);
      }
    }

    const newSubject: BitstringStatusListSubject = {
      ...subject,
      encodedList: StatusListManager.encodeBitstring(updated),
    };

    return {
      ...statusListCredential,
      credentialSubject: newSubject,
      issuanceDate: new Date().toISOString(),
    };
  }

  /**
   * Get the total capacity (number of credential slots) in a status list credential.
   */
  getCapacity(statusListCredential: VerifiableCredential): number {
    this.validateStatusListCredential(statusListCredential);
    const subject = statusListCredential.credentialSubject as BitstringStatusListSubject;
    const bitstring = StatusListManager.decodeBitstring(subject.encodedList);
    return bitstring.length * 8;
  }

  /**
   * Count how many bits are currently set in a status list credential.
   */
  getSetCount(statusListCredential: VerifiableCredential): number {
    this.validateStatusListCredential(statusListCredential);
    const subject = statusListCredential.credentialSubject as BitstringStatusListSubject;
    const bitstring = StatusListManager.decodeBitstring(subject.encodedList);
    let count = 0;
    for (const byte of bitstring) {
      let b = byte;
      while (b) {
        count += b & 1;
        b >>= 1;
      }
    }
    return count;
  }

  /**
   * Encode a bitstring to the W3C multibase+GZIP format.
   * Format: 'u' (multibase base64url) prefix + base64url(gzip(bitstring))
   */
  static encodeBitstring(bitstring: Uint8Array): string {
    const compressed = gzipSync(Buffer.from(bitstring));
    const base64url = Buffer.from(compressed)
      .toString('base64url');
    return 'u' + base64url;
  }

  /**
   * Decode a W3C encoded bitstring (multibase base64url + GZIP).
   */
  static decodeBitstring(encoded: string): Uint8Array {
    if (!encoded || encoded[0] !== 'u') {
      throw new Error(
        'Invalid encoded bitstring: must start with multibase base64url prefix "u"'
      );
    }
    const compressed = Buffer.from(encoded.slice(1), 'base64url');
    return new Uint8Array(gunzipSync(compressed));
  }

  private validateStatusListCredential(vc: VerifiableCredential): void {
    if (!vc.type?.includes('BitstringStatusListCredential')) {
      throw new Error(
        'Invalid status list credential: must include type "BitstringStatusListCredential"'
      );
    }
    const subject = vc.credentialSubject as BitstringStatusListSubject;
    if (subject?.type !== 'BitstringStatusList') {
      throw new Error(
        'Invalid status list credential: credentialSubject.type must be "BitstringStatusList"'
      );
    }
    if (!subject.encodedList) {
      throw new Error(
        'Invalid status list credential: missing encodedList'
      );
    }
  }
}
