/**
 * Resources module for the Originals SDK.
 * 
 * This module provides resource management with immutable versioning,
 * content hashing, and validation.
 * 
 * @module resources
 */

export { ResourceManager } from './ResourceManager.js';
export type {
  Resource,
  ResourceOptions,
  ResourceUpdateOptions,
  ResourceVersionHistory,
  ResourceManagerConfig,
  ResourceValidationResult,
  ResourceType,
} from './types.js';
export { MIME_TYPE_MAP, DEFAULT_RESOURCE_CONFIG } from './types.js';

