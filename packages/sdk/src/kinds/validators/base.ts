/**
 * Base validator interface and common validation utilities
 */

import type { 
  OriginalKind, 
  OriginalManifest, 
  ValidationResult, 
  ValidationError, 
  ValidationWarning,
  BaseManifest,
} from '../types';
import type { AssetResource } from '../../types/common';

/**
 * Interface for kind-specific validators
 */
export interface KindValidator<K extends OriginalKind = OriginalKind> {
  /** The kind this validator handles */
  readonly kind: K;
  
  /**
   * Validate a manifest for this kind
   * @param manifest - The manifest to validate
   * @returns Validation result with errors and warnings
   */
  validate(manifest: OriginalManifest<K>): ValidationResult;
}

/**
 * Common validation utilities
 */
export class ValidationUtils {
  /**
   * Check if a string is a valid semantic version
   */
  static isValidSemver(version: string): boolean {
    const semverRegex = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
    return semverRegex.test(version);
  }
  
  /**
   * Check if a string is a valid DID
   */
  static isValidDID(did: string): boolean {
    // DID format: did:method:identifier (identifier can contain : for path segments)
    // Examples: did:peer:123, did:webvh:example.com:user, did:btco:12345
    const didRegex = /^did:[a-z0-9]+:[a-zA-Z0-9._:%-]+$/;
    return didRegex.test(did);
  }
  
  /**
   * Check if a string is a valid SPDX license identifier
   */
  static isValidSPDXLicense(license: string): boolean {
    // Common SPDX identifiers (not exhaustive)
    const commonLicenses = [
      'MIT', 'Apache-2.0', 'GPL-3.0', 'GPL-2.0', 'BSD-2-Clause', 'BSD-3-Clause',
      'ISC', 'MPL-2.0', 'LGPL-3.0', 'AGPL-3.0', 'Unlicense', 'CC0-1.0',
      'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC-BY-NC-4.0', 'WTFPL', 'Zlib', 'BSL-1.0',
      'MIT-0', 'Apache-1.0', 'Apache-1.1', 'EPL-2.0', 'EUPL-1.2',
    ];
    return commonLicenses.includes(license) || /^[A-Z0-9][A-Z0-9._-]*$/i.test(license);
  }
  
  /**
   * Check if a string is a valid MIME type
   */
  static isValidMimeType(mimeType: string): boolean {
    const mimeRegex = /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}$/;
    return mimeRegex.test(mimeType);
  }
  
  /**
   * Check if a string is a valid URL
   */
  static isValidURL(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Check if a string is a valid ISO 639-1 language code
   */
  static isValidLanguageCode(code: string): boolean {
    // ISO 639-1 is 2 lowercase letters
    return /^[a-z]{2}$/.test(code);
  }
  
  /**
   * Check if a resource ID exists in the resources array
   */
  static resourceExists(resourceId: string, resources: AssetResource[]): boolean {
    return resources.some(r => r.id === resourceId);
  }
  
  /**
   * Get a resource by ID
   */
  static getResource(resourceId: string, resources: AssetResource[]): AssetResource | undefined {
    return resources.find(r => r.id === resourceId);
  }
  
  /**
   * Create a validation error
   */
  static error(code: string, message: string, path?: string, value?: unknown): ValidationError {
    return { code, message, path, value };
  }
  
  /**
   * Create a validation warning
   */
  static warning(code: string, message: string, path?: string, suggestion?: string): ValidationWarning {
    return { code, message, path, suggestion };
  }
  
  /**
   * Create a successful validation result
   */
  static success(warnings: ValidationWarning[] = []): ValidationResult {
    return { isValid: true, errors: [], warnings };
  }
  
  /**
   * Create a failed validation result
   */
  static failure(errors: ValidationError[], warnings: ValidationWarning[] = []): ValidationResult {
    return { isValid: false, errors, warnings };
  }
  
  /**
   * Merge multiple validation results
   */
  static merge(...results: ValidationResult[]): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    
    for (const result of results) {
      errors.push(...result.errors);
      warnings.push(...result.warnings);
    }
    
    return {
      isValid: errors.length === 0,
      errors,
      warnings,
    };
  }
}

/**
 * Base validator class with common validation logic
 */
export abstract class BaseKindValidator<K extends OriginalKind> implements KindValidator<K> {
  abstract readonly kind: K;
  
  /**
   * Validate a manifest
   * Combines base validation with kind-specific validation
   */
  validate(manifest: OriginalManifest<K>): ValidationResult {
    const baseResult = this.validateBase(manifest);
    const kindResult = this.validateKind(manifest);
    
    return ValidationUtils.merge(baseResult, kindResult);
  }
  
  /**
   * Validate base manifest fields common to all kinds
   */
  protected validateBase(manifest: BaseManifest & { kind: K }): ValidationResult {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    
    // Validate kind
    if (!manifest.kind) {
      errors.push(ValidationUtils.error('MISSING_KIND', 'Manifest must specify a kind', 'kind'));
    }
    
    // Validate name
    if (!manifest.name || typeof manifest.name !== 'string') {
      errors.push(ValidationUtils.error('MISSING_NAME', 'Manifest must have a name', 'name'));
    } else if (manifest.name.length < 1 || manifest.name.length > 200) {
      errors.push(ValidationUtils.error('INVALID_NAME_LENGTH', 'Name must be between 1 and 200 characters', 'name', manifest.name));
    }
    
    // Validate version
    if (!manifest.version || typeof manifest.version !== 'string') {
      errors.push(ValidationUtils.error('MISSING_VERSION', 'Manifest must have a version', 'version'));
    } else if (!ValidationUtils.isValidSemver(manifest.version)) {
      errors.push(ValidationUtils.error('INVALID_VERSION', 'Version must be a valid semantic version (e.g., 1.0.0)', 'version', manifest.version));
    }
    
    // Validate resources
    if (!manifest.resources || !Array.isArray(manifest.resources)) {
      errors.push(ValidationUtils.error('MISSING_RESOURCES', 'Manifest must have resources array', 'resources'));
    } else if (manifest.resources.length === 0) {
      errors.push(ValidationUtils.error('EMPTY_RESOURCES', 'Manifest must have at least one resource', 'resources'));
    } else {
      // Validate each resource
      for (let i = 0; i < manifest.resources.length; i++) {
        const resource = manifest.resources[i];
        const resourcePath = `resources[${i}]`;
        
        if (!resource.id || typeof resource.id !== 'string') {
          errors.push(ValidationUtils.error('INVALID_RESOURCE_ID', `Resource at index ${i} must have an id`, `${resourcePath}.id`));
        }
        if (!resource.type || typeof resource.type !== 'string') {
          errors.push(ValidationUtils.error('INVALID_RESOURCE_TYPE', `Resource at index ${i} must have a type`, `${resourcePath}.type`));
        }
        if (!resource.contentType || !ValidationUtils.isValidMimeType(resource.contentType)) {
          errors.push(ValidationUtils.error('INVALID_CONTENT_TYPE', `Resource at index ${i} must have a valid MIME contentType`, `${resourcePath}.contentType`, resource.contentType));
        }
        if (!resource.hash || typeof resource.hash !== 'string' || !/^[0-9a-fA-F]+$/.test(resource.hash)) {
          errors.push(ValidationUtils.error('INVALID_RESOURCE_HASH', `Resource at index ${i} must have a valid hex hash`, `${resourcePath}.hash`));
        }
      }
      
      // Check for duplicate resource IDs
      const resourceIds = manifest.resources.map(r => r.id);
      const duplicates = resourceIds.filter((id, index) => resourceIds.indexOf(id) !== index);
      if (duplicates.length > 0) {
        errors.push(ValidationUtils.error('DUPLICATE_RESOURCE_IDS', `Duplicate resource IDs found: ${[...new Set(duplicates)].join(', ')}`, 'resources'));
      }
    }
    
    // Validate dependencies if present
    if (manifest.dependencies) {
      if (!Array.isArray(manifest.dependencies)) {
        errors.push(ValidationUtils.error('INVALID_DEPENDENCIES', 'Dependencies must be an array', 'dependencies'));
      } else {
        for (let i = 0; i < manifest.dependencies.length; i++) {
          const dep = manifest.dependencies[i];
          const depPath = `dependencies[${i}]`;
          
          if (!dep.did || !ValidationUtils.isValidDID(dep.did)) {
            errors.push(ValidationUtils.error('INVALID_DEPENDENCY_DID', `Dependency at index ${i} must have a valid DID`, `${depPath}.did`, dep.did));
          }
        }
      }
    }
    
    // Validate optional fields
    if (manifest.license && !ValidationUtils.isValidSPDXLicense(manifest.license)) {
      warnings.push(ValidationUtils.warning('UNKNOWN_LICENSE', `License "${manifest.license}" is not a recognized SPDX identifier`, 'license', 'Use a valid SPDX license identifier like MIT, Apache-2.0, etc.'));
    }
    
    if (manifest.homepage && !ValidationUtils.isValidURL(manifest.homepage)) {
      errors.push(ValidationUtils.error('INVALID_HOMEPAGE', 'Homepage must be a valid URL', 'homepage', manifest.homepage));
    }
    
    if (manifest.repository && !ValidationUtils.isValidURL(manifest.repository)) {
      errors.push(ValidationUtils.error('INVALID_REPOSITORY', 'Repository must be a valid URL', 'repository', manifest.repository));
    }
    
    // Suggest adding description if missing
    if (!manifest.description) {
      warnings.push(ValidationUtils.warning('MISSING_DESCRIPTION', 'Consider adding a description for better discoverability', 'description', 'Add a brief description of this Original'));
    }
    
    return errors.length > 0 
      ? ValidationUtils.failure(errors, warnings)
      : ValidationUtils.success(warnings);
  }
  
  /**
   * Kind-specific validation to be implemented by subclasses
   */
  protected abstract validateKind(manifest: OriginalManifest<K>): ValidationResult;
}

