/**
 * HttpWitness - HTTP-based witness service for CEL event logs
 * 
 * Implements the WitnessService interface for HTTP-based witness endpoints.
 * Used primarily for the did:webvh layer to obtain third-party attestations
 * from remote witness services.
 * 
 * @see https://w3c-ccg.github.io/cel-spec/
 */

import type { WitnessProof } from '../types';
import type { WitnessService } from './WitnessService';

/**
 * Configuration options for HttpWitness
 */
export interface HttpWitnessOptions {
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Custom headers to include in requests */
  headers?: Record<string, string>;
  /** Custom fetch implementation (for testing or alternative HTTP clients) */
  fetch?: typeof globalThis.fetch;
}

/**
 * Error thrown when the HTTP witness service is unavailable or returns an error
 */
export class HttpWitnessError extends Error {
  /** HTTP status code if available */
  readonly statusCode?: number;
  /** Response body if available */
  readonly responseBody?: string;
  /** The witness URL that failed */
  readonly witnessUrl: string;
  
  constructor(
    message: string,
    witnessUrl: string,
    statusCode?: number,
    responseBody?: string
  ) {
    super(message);
    this.name = 'HttpWitnessError';
    this.witnessUrl = witnessUrl;
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

/**
 * HTTP-based witness service implementation
 * 
 * Posts digestMultibase to a witness endpoint and parses the WitnessProof response.
 * 
 * @example
 * ```typescript
 * const witness = new HttpWitness('https://witness.example.com/api/attest');
 * const proof = await witness.witness('uEiD...');
 * console.log(proof.witnessedAt); // ISO timestamp of attestation
 * ```
 */
export class HttpWitness implements WitnessService {
  private readonly witnessUrl: string;
  private readonly timeout: number;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: typeof globalThis.fetch;
  
  /**
   * Creates a new HttpWitness instance
   * 
   * @param witnessUrl - The URL of the witness endpoint to POST to
   * @param options - Optional configuration options
   */
  constructor(witnessUrl: string, options: HttpWitnessOptions = {}) {
    if (!witnessUrl || typeof witnessUrl !== 'string') {
      throw new Error('witnessUrl must be a non-empty string');
    }
    
    // Validate URL format
    try {
      new URL(witnessUrl);
    } catch {
      throw new Error(`Invalid witness URL: ${witnessUrl}`);
    }
    
    this.witnessUrl = witnessUrl;
    this.timeout = options.timeout ?? 30000;
    this.headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...options.headers,
    };
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }
  
  /**
   * Witnesses a digest by posting to the HTTP endpoint
   * 
   * @param digestMultibase - The Multibase-encoded digest to witness
   * @returns A WitnessProof containing the attestation and witnessedAt timestamp
   * @throws HttpWitnessError if the witness service is unavailable or returns an error
   */
  async witness(digestMultibase: string): Promise<WitnessProof> {
    if (!digestMultibase || typeof digestMultibase !== 'string') {
      throw new Error('digestMultibase must be a non-empty string');
    }
    
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    
    try {
      const response = await this.fetchFn(this.witnessUrl, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ digest: digestMultibase }),
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      // Handle non-OK responses
      if (!response.ok) {
        let responseBody: string | undefined;
        try {
          responseBody = await response.text();
        } catch {
          // Ignore body read errors
        }
        
        throw new HttpWitnessError(
          `Witness service returned ${response.status} ${response.statusText}`,
          this.witnessUrl,
          response.status,
          responseBody
        );
      }
      
      // Parse response
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new HttpWitnessError(
          'Witness service returned invalid JSON response',
          this.witnessUrl,
          response.status
        );
      }
      
      // Validate WitnessProof structure
      const proof = this.validateWitnessProof(data);
      return proof;
      
    } catch (error) {
      clearTimeout(timeoutId);
      
      // Re-throw HttpWitnessError as-is
      if (error instanceof HttpWitnessError) {
        throw error;
      }
      
      // Handle abort/timeout
      if (error instanceof Error && error.name === 'AbortError') {
        throw new HttpWitnessError(
          `Witness service request timed out after ${this.timeout}ms`,
          this.witnessUrl
        );
      }
      
      // Handle network errors
      if (error instanceof TypeError) {
        throw new HttpWitnessError(
          `Witness service unavailable: ${error.message}`,
          this.witnessUrl
        );
      }
      
      // Re-throw other errors
      throw new HttpWitnessError(
        `Witness request failed: ${error instanceof Error ? error.message : String(error)}`,
        this.witnessUrl
      );
    }
  }
  
  /**
   * Validates that the response data is a valid WitnessProof
   * 
   * @param data - The parsed JSON response
   * @returns A validated WitnessProof
   * @throws HttpWitnessError if the response is not a valid WitnessProof
   */
  private validateWitnessProof(data: unknown): WitnessProof {
    if (!data || typeof data !== 'object') {
      throw new HttpWitnessError(
        'Witness service returned invalid proof: expected object',
        this.witnessUrl
      );
    }
    
    const proof = data as Record<string, unknown>;
    
    // Check required DataIntegrityProof fields
    const requiredFields = ['type', 'cryptosuite', 'created', 'verificationMethod', 'proofPurpose', 'proofValue'];
    for (const field of requiredFields) {
      if (typeof proof[field] !== 'string') {
        throw new HttpWitnessError(
          `Witness service returned invalid proof: missing or invalid '${field}' field`,
          this.witnessUrl
        );
      }
    }
    
    // Check WitnessProof-specific field
    if (typeof proof.witnessedAt !== 'string') {
      throw new HttpWitnessError(
        "Witness service returned invalid proof: missing or invalid 'witnessedAt' field",
        this.witnessUrl
      );
    }
    
    return {
      type: proof.type as string,
      cryptosuite: proof.cryptosuite as string,
      created: proof.created as string,
      verificationMethod: proof.verificationMethod as string,
      proofPurpose: proof.proofPurpose as string,
      proofValue: proof.proofValue as string,
      witnessedAt: proof.witnessedAt as string,
    };
  }
  
  /**
   * Gets the witness URL this instance is configured to use
   */
  get url(): string {
    return this.witnessUrl;
  }
}
