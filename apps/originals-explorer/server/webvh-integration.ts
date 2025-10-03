/**
 * WebVH Integration Service
 * 
 * This service provides utility methods for managing did:webvh identifiers
 * using the Originals SDK. It's a thin wrapper around the SDK's WebVHManager
 * with some convenience methods for file paths and configuration.
 */

import { originalsSdk } from './originals';
import type { CreateWebVHOptions, CreateWebVHResult } from '@originals/sdk';
import * as path from 'path';
import * as fs from 'fs';

export interface WebVHManagerConfig {
  publicDir?: string; // Directory to save DID logs (e.g., 'public')
  domain?: string; // Default domain for DIDs
}

/**
 * Service for creating and managing did:webvh identifiers using the SDK
 */
export class WebVHIntegrationService {
  private config: Required<WebVHManagerConfig>;

  constructor(config: WebVHManagerConfig = {}) {
    this.config = {
      publicDir: config.publicDir || path.join(process.cwd(), 'public'),
      domain: config.domain || process.env.DID_DOMAIN || process.env.VITE_APP_DOMAIN || 'localhost:5000',
    };

    // Ensure public directory exists
    this.ensurePublicDirectory();
  }

  /**
   * Ensure the public directory for DID files exists
   */
  private ensurePublicDirectory(): void {
    const wellKnownPath = path.join(this.config.publicDir, '.well-known', 'did');
    if (!fs.existsSync(wellKnownPath)) {
      fs.mkdirSync(wellKnownPath, { recursive: true });
    }
  }

  /**
   * Create a did:webvh identifier with SDK-managed keys
   * This provides full cryptographic signing and proof generation
   * 
   * @param userSlug - Unique identifier for the user (e.g., username or ID)
   * @param options - Additional creation options
   * @returns Complete DID creation result with document and log
   */
  async createDIDWithSDK(
    userSlug: string,
    options: Partial<CreateWebVHOptions> = {}
  ): Promise<CreateWebVHResult> {
    try {
      // Sanitize user slug for use in DID
      const sanitizedSlug = this.sanitizeSlug(userSlug);

      // Create the DID using the SDK's WebVHManager
      const result = await originalsSdk.webvh.createDIDWebVH({
        domain: this.config.domain,
        paths: [sanitizedSlug],
        portable: false,
        outputDir: path.join(this.config.publicDir, '.well-known'),
        ...options,
      });

      console.log(`Created DID:WebVH with SDK: ${result.did}`);
      console.log(`DID log saved to: ${result.logPath}`);

      return result;
    } catch (error) {
      console.error('Error creating DID with SDK:', error);
      throw new Error(
        `Failed to create DID with SDK: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Load a DID log from file system
   * @param logPath - Path to the did.jsonl file
   */
  async loadDIDLog(logPath: string): Promise<any[]> {
    try {
      return await originalsSdk.webvh.loadDIDLog(logPath);
    } catch (error) {
      console.error('Error loading DID log:', error);
      throw new Error(
        `Failed to load DID log: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Save a DID log to the appropriate location
   * @param did - The DID identifier
   * @param log - The DID log entries
   */
  async saveDIDLog(did: string, log: any[]): Promise<string> {
    try {
      const logPath = await originalsSdk.webvh.saveDIDLog(
        did,
        log,
        path.join(this.config.publicDir, '.well-known')
      );
      console.log(`Saved DID log to: ${logPath}`);
      return logPath;
    } catch (error) {
      console.error('Error saving DID log:', error);
      throw new Error(
        `Failed to save DID log: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Update a DID:WebVH document
   * @param did - The DID to update
   * @param currentLog - The current DID log
   * @param updates - Updates to apply
   * @param signer - The signer (keypair or external signer)
   */
  async updateDID(
    did: string,
    currentLog: any[],
    updates: any,
    signer: any
  ): Promise<{ didDocument: any; log: any[]; logPath?: string }> {
    return originalsSdk.webvh.updateDIDWebVH({
      did,
      currentLog,
      updates,
      signer,
      outputDir: path.join(this.config.publicDir, '.well-known'),
    });
  }

  /**
   * Sanitize a user slug for use in a DID
   * @param slug - Raw slug input
   * @returns Sanitized slug safe for DIDs
   */
  private sanitizeSlug(slug: string): string {
    // Remove 'did:privy:' prefix if present
    let sanitized = slug.replace(/^did:privy:/, '');
    
    // Convert to lowercase and replace non-alphanumeric with hyphens
    sanitized = sanitized.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    
    // Remove consecutive hyphens and trim
    return sanitized.replace(/-+/g, '-').replace(/^-|-$/g, '');
  }

  /**
   * Get the path to a DID log file based on the DID
   * @param did - The DID identifier
   * @returns Path to the did.jsonl file
   */
  getDIDLogPath(did: string): string {
    // Extract path components from DID
    // Format: did:webvh:domain:path1:path2
    const parts = did.split(':');
    if (parts.length < 3) {
      throw new Error('Invalid DID format');
    }

    const pathParts = parts.slice(3); // Skip 'did', 'webvh', and domain
    const domain = decodeURIComponent(parts[2])
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '_');

    return path.join(
      this.config.publicDir,
      '.well-known',
      'did',
      domain,
      ...pathParts,
      'did.jsonl'
    );
  }

  /**
   * Check if a DID log exists
   * @param did - The DID identifier
   * @returns True if the log file exists
   */
  didLogExists(did: string): boolean {
    try {
      const logPath = this.getDIDLogPath(did);
      return fs.existsSync(logPath);
    } catch (error) {
      return false;
    }
  }
}

// Export a singleton instance
export const webvhService = new WebVHIntegrationService();
