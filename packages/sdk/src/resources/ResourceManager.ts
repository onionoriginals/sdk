/**
 * ResourceManager - CRUD operations for immutable, versioned resources.
 * 
 * Resources in the Originals SDK are content-addressed and immutable. Each "update"
 * creates a new version with a new content hash, linked to the previous version
 * via previousVersionHash. This creates a verifiable provenance chain.
 * 
 * @example
 * ```typescript
 * const manager = new ResourceManager();
 * 
 * // Create a new resource
 * const resource = manager.createResource('Hello, World!', {
 *   type: 'text',
 *   contentType: 'text/plain'
 * });
 * 
 * // Update creates a new version
 * const updatedResource = manager.updateResource(resource, 'Hello, Updated World!', {
 *   changes: 'Updated greeting'
 * });
 * 
 * // Get version history
 * const history = manager.getResourceHistory(resource.id);
 * ```
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { v4 as uuidv4 } from 'uuid';
import type {
  Resource,
  ResourceOptions,
  ResourceUpdateOptions,
  ResourceVersionHistory,
  ResourceManagerConfig,
  ResourceValidationResult,
  ResourceType,
} from './types.js';
import { MIME_TYPE_MAP, DEFAULT_RESOURCE_CONFIG } from './types.js';

/**
 * Regular expression for validating MIME types according to RFC 6838.
 * Format: type/subtype where type and subtype are restricted character sets.
 */
const MIME_TYPE_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}$/;

/**
 * ResourceManager provides CRUD operations for immutable, content-addressed resources
 * with versioning support and validation.
 */
export class ResourceManager {
  private resources: Map<string, Resource[]>;
  private config: Required<ResourceManagerConfig>;

  /**
   * Create a new ResourceManager instance.
   * 
   * @param config - Optional configuration for the manager
   */
  constructor(config?: ResourceManagerConfig) {
    this.resources = new Map();
    this.config = { ...DEFAULT_RESOURCE_CONFIG, ...config };
  }

  /**
   * Create a new resource from content.
   * 
   * @param content - The resource content (string for text, Buffer for binary)
   * @param options - Creation options including type and contentType
   * @returns The created Resource
   * @throws Error if content or options are invalid
   * 
   * @example
   * ```typescript
   * // Create a text resource
   * const textResource = manager.createResource('# README\nHello', {
   *   type: 'text',
   *   contentType: 'text/markdown'
   * });
   * 
   * // Create a binary resource (image)
   * const imageBuffer = fs.readFileSync('image.png');
   * const imageResource = manager.createResource(imageBuffer, {
   *   type: 'image',
   *   contentType: 'image/png'
   * });
   * ```
   */
  createResource(content: Buffer | string, options: ResourceOptions): Resource {
    // Validate inputs
    if (content === null || content === undefined) {
      throw new Error('Content is required');
    }
    if (!options) {
      throw new Error('Options are required');
    }
    if (!options.type) {
      throw new Error('Resource type is required');
    }
    if (!options.contentType) {
      throw new Error('Content type is required');
    }

    // Validate MIME type format
    if (!this.isValidMimeType(options.contentType)) {
      throw new Error(`Invalid MIME type format: ${options.contentType}`);
    }

    // Check allowed content types
    if (this.config.allowedContentTypes.length > 0 && 
        !this.config.allowedContentTypes.includes(options.contentType)) {
      throw new Error(`Content type not allowed: ${options.contentType}. Allowed types: ${this.config.allowedContentTypes.join(', ')}`);
    }

    // Convert content to buffer for consistent handling
    const contentBuffer = this.toBuffer(content);
    
    // Validate size
    const maxSize = options.maxSize || this.config.defaultMaxSize;
    if (contentBuffer.length > maxSize) {
      throw new Error(`Resource size (${contentBuffer.length} bytes) exceeds maximum allowed size (${maxSize} bytes)`);
    }

    // Generate hash
    const hash = this.hashContent(contentBuffer);

    // Generate or use provided ID
    const id = options.id || uuidv4();

    // Create resource object
    const resource: Resource = {
      id,
      type: options.type,
      contentType: options.contentType,
      hash,
      size: contentBuffer.length,
      version: 1,
      createdAt: new Date().toISOString(),
      url: options.url,
      description: options.description,
    };

    // Store content if configured to do so
    if (this.config.storeContent) {
      if (this.isBinaryContent(content)) {
        resource.contentBase64 = contentBuffer.toString('base64');
      } else {
        resource.content = typeof content === 'string' ? content : contentBuffer.toString('utf-8');
      }
    }

    // Store in version history
    this.resources.set(id, [resource]);

    return resource;
  }

  /**
   * Update a resource by creating a new version.
   * The original resource remains unchanged (immutable versioning).
   * 
   * @param resource - The resource to update (or its ID)
   * @param newContent - The new content
   * @param options - Optional update options including change description
   * @returns The new version of the resource
   * @throws Error if resource not found or content unchanged
   * 
   * @example
   * ```typescript
   * const v2 = manager.updateResource(originalResource, 'Updated content', {
   *   changes: 'Fixed typo in documentation'
   * });
   * 
   * console.log(v2.version); // 2
   * console.log(v2.previousVersionHash); // hash of v1
   * ```
   */
  updateResource(
    resource: Resource | string,
    newContent: Buffer | string,
    options?: ResourceUpdateOptions
  ): Resource {
    const resourceId = typeof resource === 'string' ? resource : resource.id;
    
    // Get version history
    const versions = this.resources.get(resourceId);
    if (!versions || versions.length === 0) {
      throw new Error(`Resource not found: ${resourceId}`);
    }

    // Get current (latest) version
    const currentVersion = versions[versions.length - 1];

    // Convert content to buffer
    const contentBuffer = this.toBuffer(newContent);

    // Generate hash for new content
    const newHash = this.hashContent(contentBuffer);

    // Check if content has actually changed
    if (newHash === currentVersion.hash) {
      throw new Error('Content unchanged - new version would be identical to current version');
    }

    // Validate size
    if (contentBuffer.length > this.config.defaultMaxSize) {
      throw new Error(`Resource size (${contentBuffer.length} bytes) exceeds maximum allowed size (${this.config.defaultMaxSize} bytes)`);
    }

    // Determine content type (use provided or inherit from previous)
    const contentType = options?.contentType || currentVersion.contentType;
    
    // Validate new content type if changed
    if (options?.contentType && !this.isValidMimeType(options.contentType)) {
      throw new Error(`Invalid MIME type format: ${options.contentType}`);
    }

    // Create new version
    const newVersion: Resource = {
      id: resourceId,
      type: currentVersion.type,
      contentType,
      hash: newHash,
      size: contentBuffer.length,
      version: (currentVersion.version || 1) + 1,
      previousVersionHash: currentVersion.hash,
      createdAt: new Date().toISOString(),
      url: currentVersion.url,
      description: currentVersion.description,
    };

    // Store content if configured
    if (this.config.storeContent) {
      if (this.isBinaryContent(newContent)) {
        newVersion.contentBase64 = contentBuffer.toString('base64');
      } else {
        newVersion.content = typeof newContent === 'string' ? newContent : contentBuffer.toString('utf-8');
      }
    }

    // Add to version history
    versions.push(newVersion);

    return newVersion;
  }

  /**
   * Get the complete version history for a resource.
   * 
   * @param resourceId - The logical resource ID
   * @returns Array of all versions (oldest to newest), or empty array if not found
   * 
   * @example
   * ```typescript
   * const history = manager.getResourceHistory('my-resource-id');
   * console.log(`Found ${history.length} versions`);
   * history.forEach((v, i) => console.log(`v${i + 1}: ${v.hash}`));
   * ```
   */
  getResourceHistory(resourceId: string): Resource[] {
    const versions = this.resources.get(resourceId);
    if (!versions) {
      return [];
    }
    return [...versions]; // Return copy to prevent external mutation
  }

  /**
   * Get detailed version history with metadata.
   * 
   * @param resourceId - The logical resource ID
   * @returns ResourceVersionHistory object or null if not found
   */
  getResourceVersionHistory(resourceId: string): ResourceVersionHistory | null {
    const versions = this.resources.get(resourceId);
    if (!versions || versions.length === 0) {
      return null;
    }

    return {
      resourceId,
      versions: [...versions],
      currentVersion: versions[versions.length - 1],
      versionCount: versions.length,
    };
  }

  /**
   * Get a specific version of a resource.
   * 
   * @param resourceId - The logical resource ID
   * @param version - Version number (1-indexed)
   * @returns The resource at that version, or null if not found
   */
  getResourceVersion(resourceId: string, version: number): Resource | null {
    const versions = this.resources.get(resourceId);
    if (!versions || version < 1 || version > versions.length) {
      return null;
    }
    return versions[version - 1];
  }

  /**
   * Get the current (latest) version of a resource.
   * 
   * @param resourceId - The logical resource ID
   * @returns The current version, or null if not found
   */
  getCurrentVersion(resourceId: string): Resource | null {
    const versions = this.resources.get(resourceId);
    if (!versions || versions.length === 0) {
      return null;
    }
    return versions[versions.length - 1];
  }

  /**
   * Get a resource by its content hash.
   * 
   * @param hash - The content hash to search for
   * @returns The resource with that hash, or null if not found
   */
  getResourceByHash(hash: string): Resource | null {
    for (const versions of this.resources.values()) {
      const found = versions.find(r => r.hash === hash);
      if (found) {
        return found;
      }
    }
    return null;
  }

  /**
   * Validate a resource object.
   * 
   * @param resource - The resource to validate
   * @returns ValidationResult with valid flag and any errors/warnings
   * 
   * @example
   * ```typescript
   * const result = manager.validateResource(resource);
   * if (!result.valid) {
   *   console.error('Validation errors:', result.errors);
   * }
   * if (result.warnings.length > 0) {
   *   console.warn('Warnings:', result.warnings);
   * }
   * ```
   */
  validateResource(resource: Resource): ResourceValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Required field validation
    if (!resource) {
      return { valid: false, errors: ['Resource is null or undefined'], warnings: [] };
    }

    if (!resource.id || typeof resource.id !== 'string') {
      errors.push('Missing or invalid resource ID');
    }

    if (!resource.type || typeof resource.type !== 'string') {
      errors.push('Missing or invalid resource type');
    }

    if (!resource.contentType || typeof resource.contentType !== 'string') {
      errors.push('Missing or invalid content type');
    } else if (this.config.strictMimeValidation && !this.isValidMimeType(resource.contentType)) {
      errors.push(`Invalid MIME type format: ${resource.contentType}`);
    }

    if (!resource.hash || typeof resource.hash !== 'string') {
      errors.push('Missing or invalid hash');
    } else if (!/^[0-9a-fA-F]{64}$/.test(resource.hash)) {
      errors.push('Invalid hash format (must be 64 character hex string)');
    }

    // Version chain validation
    if (resource.version !== undefined) {
      if (typeof resource.version !== 'number' || resource.version < 1) {
        errors.push('Invalid version number (must be positive integer)');
      }
      
      // v1 should not have previousVersionHash
      if (resource.version === 1 && resource.previousVersionHash) {
        warnings.push('First version should not have previousVersionHash');
      }
      
      // v2+ should have previousVersionHash
      if (resource.version > 1 && !resource.previousVersionHash) {
        errors.push('Versions greater than 1 must have previousVersionHash');
      }
    }

    // Size validation
    if (resource.size !== undefined) {
      if (typeof resource.size !== 'number' || resource.size < 0) {
        errors.push('Invalid size (must be non-negative number)');
      }
      
      if (resource.size > this.config.defaultMaxSize) {
        warnings.push(`Resource size (${resource.size} bytes) exceeds default maximum (${this.config.defaultMaxSize} bytes)`);
      }
    }

    // Timestamp validation
    if (resource.createdAt) {
      const date = new Date(resource.createdAt);
      if (isNaN(date.getTime())) {
        errors.push('Invalid createdAt timestamp');
      }
    }

    // Content hash verification (if content is present)
    if (resource.content || resource.contentBase64) {
      const content = resource.content 
        ? Buffer.from(resource.content, 'utf-8')
        : Buffer.from(resource.contentBase64 || '', 'base64');
      const computedHash = this.hashContent(content);
      
      if (computedHash !== resource.hash) {
        errors.push(`Content hash mismatch: expected ${resource.hash}, computed ${computedHash}`);
      }
    }

    // Check allowed content types if configured
    if (this.config.allowedContentTypes.length > 0 && 
        resource.contentType && 
        !this.config.allowedContentTypes.includes(resource.contentType)) {
      errors.push(`Content type not allowed: ${resource.contentType}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Verify the integrity of a resource's version chain.
   * Ensures that previousVersionHash references form a valid chain.
   * 
   * @param resourceId - The logical resource ID to verify
   * @returns ResourceValidationResult indicating chain integrity
   */
  verifyVersionChain(resourceId: string): ResourceValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    const versions = this.resources.get(resourceId);
    if (!versions || versions.length === 0) {
      return { valid: false, errors: ['Resource not found'], warnings: [] };
    }

    for (let i = 0; i < versions.length; i++) {
      const version = versions[i];
      
      // Check version numbers are sequential
      if ((version.version || i + 1) !== i + 1) {
        errors.push(`Version number mismatch at index ${i}: expected ${i + 1}, got ${version.version}`);
      }

      // First version should not have previousVersionHash
      if (i === 0) {
        if (version.previousVersionHash) {
          warnings.push('First version has previousVersionHash (should not exist for v1)');
        }
      } else {
        // Subsequent versions must link to previous
        const prevVersion = versions[i - 1];
        if (!version.previousVersionHash) {
          errors.push(`Version ${i + 1} missing previousVersionHash`);
        } else if (version.previousVersionHash !== prevVersion.hash) {
          errors.push(`Version ${i + 1} previousVersionHash mismatch: expected ${prevVersion.hash}, got ${version.previousVersionHash}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Hash content using SHA-256.
   * 
   * @param content - Content to hash (string or Buffer)
   * @returns Hex-encoded SHA-256 hash
   * 
   * @example
   * ```typescript
   * const hash = manager.hashContent('Hello, World!');
   * console.log(hash); // 64-character hex string
   * ```
   */
  hashContent(content: Buffer | string): string {
    const buffer = this.toBuffer(content);
    const hash = sha256(buffer);
    return bytesToHex(hash);
  }

  /**
   * Delete a resource and all its versions.
   * 
   * @param resourceId - The resource ID to delete
   * @returns true if deleted, false if not found
   */
  deleteResource(resourceId: string): boolean {
    return this.resources.delete(resourceId);
  }

  /**
   * List all resource IDs managed by this instance.
   * 
   * @returns Array of resource IDs
   */
  listResourceIds(): string[] {
    return Array.from(this.resources.keys());
  }

  /**
   * Get the total number of resources (unique IDs) managed.
   * 
   * @returns Number of resources
   */
  getResourceCount(): number {
    return this.resources.size;
  }

  /**
   * Get the total number of versions across all resources.
   * 
   * @returns Total version count
   */
  getTotalVersionCount(): number {
    let count = 0;
    for (const versions of this.resources.values()) {
      count += versions.length;
    }
    return count;
  }

  /**
   * Import a resource from an existing AssetResource.
   * Useful for loading resources from storage or external sources.
   * 
   * @param assetResource - The AssetResource to import
   * @returns The imported Resource
   */
  importResource(assetResource: Resource): Resource {
    const resourceId = assetResource.id;
    
    // Get or create version array
    let versions = this.resources.get(resourceId);
    if (!versions) {
      versions = [];
      this.resources.set(resourceId, versions);
    }

    // Check if this version already exists (by hash)
    const existingVersion = versions.find(v => v.hash === assetResource.hash);
    if (existingVersion) {
      return existingVersion;
    }

    // Add to version array (maintain order by version number)
    const version = assetResource.version || 1;
    const insertIndex = versions.findIndex(v => (v.version || 1) > version);
    if (insertIndex === -1) {
      versions.push(assetResource);
    } else {
      versions.splice(insertIndex, 0, assetResource);
    }

    return assetResource;
  }

  /**
   * Export all resources as an array (for serialization).
   * 
   * @returns Array of all resources (all versions)
   */
  exportResources(): Resource[] {
    const allResources: Resource[] = [];
    for (const versions of this.resources.values()) {
      allResources.push(...versions);
    }
    return allResources;
  }

  /**
   * Clear all resources from this manager.
   */
  clear(): void {
    this.resources.clear();
  }

  /**
   * Infer resource type from MIME type.
   * 
   * @param contentType - The MIME content type
   * @returns Inferred ResourceType
   */
  static inferResourceType(contentType: string): ResourceType {
    // Check exact match first
    if (contentType in MIME_TYPE_MAP) {
      return MIME_TYPE_MAP[contentType];
    }

    // Check by prefix
    const prefix = contentType.split('/')[0];
    switch (prefix) {
      case 'image':
        return 'image';
      case 'audio':
        return 'audio';
      case 'video':
        return 'video';
      case 'text':
        return 'text';
      default:
        return 'other';
    }
  }

  /**
   * Check if a string is a valid MIME type format.
   */
  private isValidMimeType(mimeType: string): boolean {
    return MIME_TYPE_REGEX.test(mimeType);
  }

  /**
   * Convert content to Buffer.
   */
  private toBuffer(content: Buffer | string): Buffer {
    if (Buffer.isBuffer(content)) {
      return content;
    }
    return Buffer.from(content, 'utf-8');
  }

  /**
   * Check if content is binary (Buffer) rather than text.
   */
  private isBinaryContent(content: Buffer | string): boolean {
    return Buffer.isBuffer(content);
  }
}

