/**
 * Module Kind Validator
 * 
 * Validates manifests for reusable code modules with exports and dependencies.
 */

import { OriginalKind, type OriginalManifest, type ValidationResult, type ModuleMetadata } from '../types';
import { BaseKindValidator, ValidationUtils } from './base';

/**
 * Valid module formats
 */
const VALID_FORMATS = ['esm', 'commonjs', 'umd', 'amd', 'iife'];

/**
 * Validator for Module Originals
 */
export class ModuleValidator extends BaseKindValidator<OriginalKind.Module> {
  readonly kind = OriginalKind.Module;
  
  protected validateKind(manifest: OriginalManifest<OriginalKind.Module>): ValidationResult {
    const errors: ValidationResult['errors'] = [];
    const warnings: ValidationResult['warnings'] = [];
    const metadata = manifest.metadata as ModuleMetadata;
    
    // Validate metadata exists
    if (!metadata || typeof metadata !== 'object') {
      return ValidationUtils.failure([
        ValidationUtils.error('MISSING_METADATA', 'Module manifest must have metadata', 'metadata'),
      ]);
    }
    
    // Validate format (required)
    if (!metadata.format) {
      errors.push(ValidationUtils.error(
        'MISSING_FORMAT',
        'Module must specify a format',
        'metadata.format',
      ));
    } else if (!VALID_FORMATS.includes(metadata.format)) {
      errors.push(ValidationUtils.error(
        'INVALID_FORMAT',
        `Invalid module format: "${metadata.format}". Must be one of: ${VALID_FORMATS.join(', ')}`,
        'metadata.format',
        metadata.format,
      ));
    }
    
    // Validate main (required)
    if (!metadata.main || typeof metadata.main !== 'string') {
      errors.push(ValidationUtils.error(
        'MISSING_MAIN',
        'Module must specify a main entrypoint',
        'metadata.main',
      ));
    } else {
      // Check if main references an existing resource
      if (!ValidationUtils.resourceExists(metadata.main, manifest.resources)) {
        warnings.push(ValidationUtils.warning(
          'MAIN_NOT_RESOURCE',
          `Main entrypoint "${metadata.main}" does not match a resource ID`,
          'metadata.main',
          'Ensure the main entrypoint is a valid resource ID',
        ));
      }
    }
    
    // Validate types if specified
    if (metadata.types) {
      if (typeof metadata.types !== 'string') {
        errors.push(ValidationUtils.error(
          'INVALID_TYPES',
          'Types must be a string (resource ID)',
          'metadata.types',
        ));
      } else if (!ValidationUtils.resourceExists(metadata.types, manifest.resources)) {
        warnings.push(ValidationUtils.warning(
          'TYPES_NOT_RESOURCE',
          `Types file "${metadata.types}" does not match a resource ID`,
          'metadata.types',
        ));
      }
    } else {
      warnings.push(ValidationUtils.warning(
        'MISSING_TYPES',
        'Consider adding TypeScript type definitions',
        'metadata.types',
        'Add a .d.ts file for better TypeScript support',
      ));
    }
    
    // Validate exports if specified
    if (metadata.exports) {
      if (typeof metadata.exports !== 'object' || Array.isArray(metadata.exports)) {
        errors.push(ValidationUtils.error(
          'INVALID_EXPORTS',
          'Exports must be an object',
          'metadata.exports',
        ));
      } else {
        for (const [key, value] of Object.entries(metadata.exports)) {
          if (typeof value === 'string') {
            // Simple string export is valid
            continue;
          } else if (typeof value === 'object' && value !== null) {
            // Conditional exports object
            const exportObj = value as { import?: string; require?: string; types?: string };
            if (!exportObj.import && !exportObj.require) {
              warnings.push(ValidationUtils.warning(
                'INCOMPLETE_EXPORT',
                `Export "${key}" should have at least 'import' or 'require' field`,
                `metadata.exports.${key}`,
              ));
            }
          } else {
            errors.push(ValidationUtils.error(
              'INVALID_EXPORT',
              `Export "${key}" must be a string or object`,
              `metadata.exports.${key}`,
            ));
          }
        }
        
        // Check for "." export (main export)
        if (!('.' in metadata.exports)) {
          warnings.push(ValidationUtils.warning(
            'MISSING_MAIN_EXPORT',
            'Consider adding a "." export for the main module entry',
            'metadata.exports',
          ));
        }
      }
    }
    
    // Validate peer dependencies if specified
    if (metadata.peerDependencies) {
      if (typeof metadata.peerDependencies !== 'object' || Array.isArray(metadata.peerDependencies)) {
        errors.push(ValidationUtils.error(
          'INVALID_PEER_DEPS',
          'Peer dependencies must be an object',
          'metadata.peerDependencies',
        ));
      } else {
        for (const [name, version] of Object.entries(metadata.peerDependencies)) {
          if (typeof version !== 'string') {
            errors.push(ValidationUtils.error(
              'INVALID_PEER_DEP_VERSION',
              `Peer dependency "${name}" must have a string version`,
              `metadata.peerDependencies.${name}`,
            ));
          }
        }
      }
    }
    
    // Validate browser field if specified
    if (metadata.browser) {
      if (typeof metadata.browser !== 'string') {
        errors.push(ValidationUtils.error(
          'INVALID_BROWSER',
          'Browser field must be a string (resource ID)',
          'metadata.browser',
        ));
      } else if (!ValidationUtils.resourceExists(metadata.browser, manifest.resources)) {
        warnings.push(ValidationUtils.warning(
          'BROWSER_NOT_RESOURCE',
          `Browser entrypoint "${metadata.browser}" does not match a resource ID`,
          'metadata.browser',
        ));
      }
    }
    
    // Validate sideEffects if specified
    if (metadata.sideEffects !== undefined) {
      if (typeof metadata.sideEffects !== 'boolean' && !Array.isArray(metadata.sideEffects)) {
        errors.push(ValidationUtils.error(
          'INVALID_SIDE_EFFECTS',
          'sideEffects must be a boolean or array of strings',
          'metadata.sideEffects',
        ));
      } else if (Array.isArray(metadata.sideEffects)) {
        for (let i = 0; i < metadata.sideEffects.length; i++) {
          if (typeof metadata.sideEffects[i] !== 'string') {
            errors.push(ValidationUtils.error(
              'INVALID_SIDE_EFFECT_ENTRY',
              `sideEffects entry at index ${i} must be a string`,
              `metadata.sideEffects[${i}]`,
            ));
          }
        }
      }
    }
    
    // Validate TypeScript config if specified
    if (metadata.typescript) {
      if (typeof metadata.typescript !== 'object') {
        errors.push(ValidationUtils.error(
          'INVALID_TYPESCRIPT',
          'TypeScript config must be an object',
          'metadata.typescript',
        ));
      }
    }
    
    // Check that at least one code resource exists
    const codeResources = manifest.resources.filter(r => 
      r.contentType.includes('javascript') || 
      r.contentType.includes('typescript') ||
      r.contentType.includes('json') ||
      r.type === 'code'
    );
    if (codeResources.length === 0) {
      warnings.push(ValidationUtils.warning(
        'NO_CODE_RESOURCES',
        'No code resources found. Ensure resources have appropriate content types',
        'resources',
      ));
    }
    
    return errors.length > 0
      ? ValidationUtils.failure(errors, warnings)
      : ValidationUtils.success(warnings);
  }
}

