/**
 * Resource types for the Originals SDK ResourceManager.
 * 
 * Resources in the Originals protocol are immutable, content-addressed entities
 * that can be versioned through a linked hash chain.
 */

import { AssetResource } from '../types/common';

/**
 * Supported resource types for categorization
 */
export type ResourceType = 
  | 'image'
  | 'text'
  | 'code'
  | 'data'
  | 'audio'
  | 'video'
  | 'document'
  | 'binary'
  | 'other';

/**
 * Options for creating a new resource
 */
export interface ResourceOptions {
  /** Logical resource ID (optional - will be generated if not provided) */
  id?: string;
  
  /** Resource type category */
  type: ResourceType;
  
  /** MIME content type (e.g., 'text/plain', 'image/png') */
  contentType: string;
  
  /** Optional URL if resource is externally hosted */
  url?: string;
  
  /** Optional description of the resource */
  description?: string;
  
  /** Maximum allowed size in bytes (optional, uses default if not specified) */
  maxSize?: number;
}

/**
 * Options for updating an existing resource
 */
export interface ResourceUpdateOptions {
  /** New content type (optional - inherits from previous version if not specified) */
  contentType?: string;
  
  /** Description of changes made in this version */
  changes?: string;
}

/**
 * Result of resource validation
 */
export interface ResourceValidationResult {
  /** Whether the resource is valid */
  valid: boolean;
  
  /** Array of error messages if validation failed */
  errors: string[];
  
  /** Array of warning messages (non-fatal issues) */
  warnings: string[];
}

/**
 * A resource with its content and metadata
 */
export interface Resource extends AssetResource {
  /** The actual content (for in-memory resources) */
  content?: string;
  
  /** Binary content as base64-encoded string */
  contentBase64?: string;
  
  /** Description of the resource */
  description?: string;
}

/**
 * Complete history of a resource including all versions
 */
export interface ResourceVersionHistory {
  /** Logical resource ID (stable across all versions) */
  resourceId: string;
  
  /** All versions in chronological order (oldest first) */
  versions: Resource[];
  
  /** The current (latest) version */
  currentVersion: Resource;
  
  /** Total number of versions */
  versionCount: number;
}

/**
 * Configuration for the ResourceManager
 */
export interface ResourceManagerConfig {
  /** Default maximum resource size in bytes (default: 10MB) */
  defaultMaxSize?: number;
  
  /** Whether to store content in memory (default: true) */
  storeContent?: boolean;
  
  /** Allowed MIME types (if empty, all types allowed) */
  allowedContentTypes?: string[];
  
  /** Whether to enable strict MIME type validation (default: true) */
  strictMimeValidation?: boolean;
}

/**
 * Common MIME types and their resource type mappings
 */
export const MIME_TYPE_MAP: Record<string, ResourceType> = {
  // Images
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/svg+xml': 'image',
  'image/bmp': 'image',
  'image/tiff': 'image',
  
  // Text
  'text/plain': 'text',
  'text/html': 'text',
  'text/css': 'text',
  'text/csv': 'text',
  'text/markdown': 'text',
  
  // Code
  'text/javascript': 'code',
  'application/javascript': 'code',
  'text/typescript': 'code',
  'application/typescript': 'code',
  'text/x-python': 'code',
  'application/x-python-code': 'code',
  'text/x-rust': 'code',
  'text/x-go': 'code',
  'text/x-java': 'code',
  'text/x-c': 'code',
  'text/x-cpp': 'code',
  
  // Data formats
  'application/json': 'data',
  'application/xml': 'data',
  'text/xml': 'data',
  'application/yaml': 'data',
  'text/yaml': 'data',
  'application/toml': 'data',
  
  // Documents
  'application/pdf': 'document',
  'application/msword': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.ms-excel': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
  'application/vnd.ms-powerpoint': 'document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'document',
  
  // Audio
  'audio/mpeg': 'audio',
  'audio/mp3': 'audio',
  'audio/wav': 'audio',
  'audio/ogg': 'audio',
  'audio/webm': 'audio',
  'audio/flac': 'audio',
  
  // Video
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/ogg': 'video',
  'video/quicktime': 'video',
  'video/x-msvideo': 'video',
  
  // Binary
  'application/octet-stream': 'binary',
  'application/zip': 'binary',
  'application/gzip': 'binary',
  'application/x-tar': 'binary',
  'application/wasm': 'binary',
};

/**
 * Default configuration values
 */
export const DEFAULT_RESOURCE_CONFIG: Required<ResourceManagerConfig> = {
  defaultMaxSize: 10 * 1024 * 1024, // 10MB
  storeContent: true,
  allowedContentTypes: [],
  strictMimeValidation: true,
};

