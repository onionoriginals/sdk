import { StructuredError } from './telemetry.js';

/**
 * The highest ordinal number a satoshi can have. Because of block-reward
 * rounding at each halving, total supply never reaches the nominal 21M BTC
 * (2,100,000,000,000,000 sats); the last satoshi ever mined is ordinal
 * 2,099,999,997,689,999. Using the nominal figure over-accepted ~2.3M
 * non-existent sat numbers (issue #292).
 */
export const MAX_SATOSHI_SUPPLY = 2_099_999_997_689_999;

/**
 * Validation result interface for satoshi number validation
 */
export interface SatoshiValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validates a satoshi number for use in Bitcoin ordinals and did:btco DIDs.
 * 
 * @param satoshi - The satoshi identifier to validate (string or number)
 * @returns Validation result with descriptive error if invalid
 * 
 * @example
 * ```typescript
 * const result = validateSatoshiNumber('123456');
 * if (!result.valid) {
 *   throw new Error(result.error);
 * }
 * ```
 */
export function validateSatoshiNumber(satoshi: string | number): SatoshiValidationResult {
  // Check for null, undefined, or empty string
  if (satoshi === null || satoshi === undefined || satoshi === '') {
    return {
      valid: false,
      error: 'Satoshi identifier cannot be null, undefined, or empty string'
    };
  }

  // Convert to string for validation
  const satoshiStr = String(satoshi).trim();

  // Check for empty string after trimming
  if (satoshiStr === '') {
    return {
      valid: false,
      error: 'Satoshi identifier cannot be empty or whitespace-only string'
    };
  }

  // Check for numeric format (must be all digits, no decimals, no scientific notation)
  if (!/^[0-9]+$/.test(satoshiStr)) {
    return {
      valid: false,
      error: 'Satoshi identifier must be a non-negative integer (no decimals, no scientific notation, no non-numeric characters)'
    };
  }

  // Convert to number for range validation
  const satoshiNum = Number(satoshiStr);

  // Check for valid number conversion
  if (!Number.isFinite(satoshiNum)) {
    return {
      valid: false,
      error: 'Satoshi identifier must be a finite number'
    };
  }

  // Check for decimals (would be truncated by Number())
  if (satoshiNum !== Math.floor(satoshiNum)) {
    return {
      valid: false,
      error: 'Satoshi identifier cannot contain decimal places'
    };
  }

  // Check for negative numbers
  if (satoshiNum < 0) {
    return {
      valid: false,
      error: 'Satoshi identifier must be non-negative (>= 0)'
    };
  }

  // Check for maximum supply range
  if (satoshiNum > MAX_SATOSHI_SUPPLY) {
    return {
      valid: false,
      error: `Satoshi identifier must be within Bitcoin's total supply (0 to ${MAX_SATOSHI_SUPPLY.toLocaleString()})`
    };
  }

  return { valid: true };
}

/**
 * Validates a satoshi identifier and returns its canonical decimal string form.
 *
 * A did:btco identifier embeds the satoshi number verbatim, so the string that
 * gets baked into the DID must be canonical: no surrounding whitespace and no
 * leading zeros. `validateSatoshiNumber` accepts `' 42 '` and `'007'` (it
 * trims/parses before checking), but building a DID from the raw argument would
 * yield an unresolvable id like `did:btco: 42 ` or a non-canonical `did:btco:007`
 * that never matches the canonically-inscribed `did:btco:42`/`did:btco:7`.
 *
 * @param satoshi - The satoshi identifier to canonicalize (string or number)
 * @returns The canonical decimal string (e.g. '42')
 * @throws {StructuredError} If the satoshi is invalid
 */
export function canonicalizeSatoshi(satoshi: string | number): string {
  const result = validateSatoshiNumber(satoshi);
  if (!result.valid) {
    throw new StructuredError('INVALID_SATOSHI', result.error || 'Invalid satoshi identifier');
  }
  // Safe: validateSatoshiNumber guarantees an all-digits string within
  // MAX_SATOSHI_SUPPLY (~2.1e15), which is below Number.MAX_SAFE_INTEGER, so the
  // round-trip through Number is exact and simply strips whitespace/leading zeros.
  return String(Number(String(satoshi).trim()));
}

/**
 * Parses a satoshi identifier from various formats and validates it.
 * 
 * Supported formats:
 * - Plain satoshi number: "123456"
 * - did:btco DID: "did:btco:123456", "did:btco:test:123456", "did:btco:sig:123456"
 * - Ordinal notation: "123456" (same as plain number, for future extensions)
 * 
 * @param identifier - The identifier to parse
 * @returns The extracted satoshi number
 * @throws {StructuredError} If the identifier format is invalid or satoshi is invalid
 * 
 * @example
 * ```typescript
 * const satoshi = parseSatoshiIdentifier('did:btco:123456');
 * console.log(satoshi); // 123456
 * ```
 */
export function parseSatoshiIdentifier(identifier: string): number {
  if (!identifier || typeof identifier !== 'string') {
    throw new StructuredError(
      'INVALID_SATOSHI_IDENTIFIER',
      'Satoshi identifier must be a non-empty string'
    );
  }

  const trimmed = identifier.trim();

  if (trimmed === '') {
    throw new StructuredError(
      'INVALID_SATOSHI_IDENTIFIER',
      'Satoshi identifier cannot be empty or whitespace-only'
    );
  }

  let satoshiStr: string;

  // Check if it's a did:btco DID
  if (trimmed.startsWith('did:btco:')) {
    const parts = trimmed.split(':');
    
    // Handle different network prefixes:
    // did:btco:123456 (mainnet)
    // did:btco:test:123456 (testnet)
    // did:btco:sig:123456 (signet)
    // did:btco:reg:123456 (regtest)
    if (parts.length === 3) {
      // Mainnet format: did:btco:satoshi
      satoshiStr = parts[2];
    } else if (parts.length === 4) {
      // Network-specific format: did:btco:network:satoshi
      const network = parts[2];
      if (network !== 'test' && network !== 'sig' && network !== 'reg') {
        throw new StructuredError(
          'INVALID_SATOSHI_IDENTIFIER',
          `Invalid did:btco DID format: unsupported network "${network}"`
        );
      }
      satoshiStr = parts[3];
    } else {
      throw new StructuredError(
        'INVALID_SATOSHI_IDENTIFIER',
        'Invalid did:btco DID format: expected "did:btco:satoshi" or "did:btco:network:satoshi"'
      );
    }
  } else {
    // Assume it's a plain satoshi number
    satoshiStr = trimmed;
  }

  // Validate the extracted satoshi
  const validation = validateSatoshiNumber(satoshiStr);
  if (!validation.valid) {
    throw new StructuredError(
      'INVALID_SATOSHI_IDENTIFIER',
      validation.error || 'Invalid satoshi identifier'
    );
  }

  return Number(satoshiStr);
}

/**
 * Validates a satoshi number and throws an error if invalid.
 * Convenience wrapper around validateSatoshiNumber for code that expects exceptions.
 * 
 * @param satoshi - The satoshi identifier to validate
 * @throws {StructuredError} If the satoshi is invalid
 * 
 * @example
 * ```typescript
 * assertValidSatoshi('123456'); // OK
 * assertValidSatoshi(''); // throws StructuredError
 * ```
 */
export function assertValidSatoshi(satoshi: string | number): void {
  const result = validateSatoshiNumber(satoshi);
  if (!result.valid) {
    throw new StructuredError('INVALID_SATOSHI', result.error || 'Invalid satoshi identifier');
  }
}
