/**
 * App Kind Validator
 * 
 * Validates manifests for executable applications with runtime and entrypoint.
 */

import { OriginalKind, type OriginalManifest, type ValidationResult, type AppMetadata } from '../types';
import { BaseKindValidator, ValidationUtils } from './base';

/**
 * Valid runtime environments
 */
const VALID_RUNTIMES = [
  'node', 'deno', 'bun', 'browser', 'electron',
  'react-native', 'python', 'ruby', 'go', 'rust',
  'java', 'dotnet', 'wasm',
];

/**
 * Valid platforms
 */
const VALID_PLATFORMS = ['linux', 'darwin', 'windows', 'web'];

/**
 * Validator for App Originals
 */
export class AppValidator extends BaseKindValidator<OriginalKind.App> {
  readonly kind = OriginalKind.App;
  
  protected validateKind(manifest: OriginalManifest<OriginalKind.App>): ValidationResult {
    const errors: ValidationResult['errors'] = [];
    const warnings: ValidationResult['warnings'] = [];
    const metadata = manifest.metadata as AppMetadata;
    
    // Validate metadata exists
    if (!metadata || typeof metadata !== 'object') {
      return ValidationUtils.failure([
        ValidationUtils.error('MISSING_METADATA', 'App manifest must have metadata', 'metadata'),
      ]);
    }
    
    // Validate runtime (required)
    if (!metadata.runtime || typeof metadata.runtime !== 'string') {
      errors.push(ValidationUtils.error(
        'MISSING_RUNTIME',
        'App must specify a runtime environment',
        'metadata.runtime',
      ));
    } else if (!VALID_RUNTIMES.includes(metadata.runtime.toLowerCase())) {
      warnings.push(ValidationUtils.warning(
        'UNKNOWN_RUNTIME',
        `Runtime "${metadata.runtime}" is not a commonly recognized runtime`,
        'metadata.runtime',
        `Consider using one of: ${VALID_RUNTIMES.join(', ')}`,
      ));
    }
    
    // Validate entrypoint (required)
    if (!metadata.entrypoint || typeof metadata.entrypoint !== 'string') {
      errors.push(ValidationUtils.error(
        'MISSING_ENTRYPOINT',
        'App must specify an entrypoint',
        'metadata.entrypoint',
      ));
    } else {
      // Check if entrypoint references an existing resource
      if (!ValidationUtils.resourceExists(metadata.entrypoint, manifest.resources)) {
        // It might be a path within a resource, so just warn
        warnings.push(ValidationUtils.warning(
          'ENTRYPOINT_NOT_RESOURCE',
          `Entrypoint "${metadata.entrypoint}" does not match a resource ID`,
          'metadata.entrypoint',
          'Ensure the entrypoint is a valid resource ID or path within a resource',
        ));
      }
    }
    
    // Validate platforms if specified
    if (metadata.platforms) {
      if (!Array.isArray(metadata.platforms)) {
        errors.push(ValidationUtils.error(
          'INVALID_PLATFORMS',
          'Platforms must be an array',
          'metadata.platforms',
        ));
      } else {
        for (const platform of metadata.platforms) {
          if (!VALID_PLATFORMS.includes(platform)) {
            errors.push(ValidationUtils.error(
              'INVALID_PLATFORM',
              `Invalid platform: "${platform}"`,
              'metadata.platforms',
              platform,
            ));
          }
        }
      }
    }
    
    // Validate permissions if specified
    if (metadata.permissions) {
      if (!Array.isArray(metadata.permissions)) {
        errors.push(ValidationUtils.error(
          'INVALID_PERMISSIONS',
          'Permissions must be an array of strings',
          'metadata.permissions',
        ));
      } else {
        for (let i = 0; i < metadata.permissions.length; i++) {
          if (typeof metadata.permissions[i] !== 'string') {
            errors.push(ValidationUtils.error(
              'INVALID_PERMISSION',
              `Permission at index ${i} must be a string`,
              `metadata.permissions[${i}]`,
            ));
          }
        }
      }
    }
    
    // Validate env if specified
    if (metadata.env) {
      if (typeof metadata.env !== 'object' || Array.isArray(metadata.env)) {
        errors.push(ValidationUtils.error(
          'INVALID_ENV',
          'Env must be an object',
          'metadata.env',
        ));
      } else {
        for (const [key, value] of Object.entries(metadata.env)) {
          if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
            warnings.push(ValidationUtils.warning(
              'ENV_VAR_NAMING',
              `Environment variable "${key}" should use SCREAMING_SNAKE_CASE`,
              `metadata.env.${key}`,
            ));
          }
          if (typeof value !== 'object' || value === null) {
            errors.push(ValidationUtils.error(
              'INVALID_ENV_VALUE',
              `Env variable "${key}" must have an object value`,
              `metadata.env.${key}`,
            ));
          }
        }
      }
    }
    
    // Validate icons if specified
    if (metadata.icons) {
      if (typeof metadata.icons !== 'object' || Array.isArray(metadata.icons)) {
        errors.push(ValidationUtils.error(
          'INVALID_ICONS',
          'Icons must be an object mapping sizes to resource IDs',
          'metadata.icons',
        ));
      } else {
        for (const [size, resourceId] of Object.entries(metadata.icons)) {
          if (!/^\d+x\d+$/.test(size) && !/^\d+$/.test(size)) {
            warnings.push(ValidationUtils.warning(
              'ICON_SIZE_FORMAT',
              `Icon size "${size}" should be in format "WxH" or just "N"`,
              `metadata.icons.${size}`,
            ));
          }
        }
      }
    }
    
    // Validate commands if specified
    if (metadata.commands) {
      if (typeof metadata.commands !== 'object' || Array.isArray(metadata.commands)) {
        errors.push(ValidationUtils.error(
          'INVALID_COMMANDS',
          'Commands must be an object',
          'metadata.commands',
        ));
      } else {
        for (const [name, cmd] of Object.entries(metadata.commands)) {
          if (!cmd || typeof cmd !== 'object') {
            errors.push(ValidationUtils.error(
              'INVALID_COMMAND',
              `Command "${name}" must be an object`,
              `metadata.commands.${name}`,
            ));
          } else if (!cmd.description || typeof cmd.description !== 'string') {
            warnings.push(ValidationUtils.warning(
              'MISSING_COMMAND_DESC',
              `Command "${name}" should have a description`,
              `metadata.commands.${name}.description`,
            ));
          }
        }
      }
    }
    
    // Suggest adding runtime version
    if (!metadata.runtimeVersion && !metadata.minRuntimeVersion) {
      warnings.push(ValidationUtils.warning(
        'MISSING_RUNTIME_VERSION',
        'Consider specifying runtimeVersion or minRuntimeVersion for compatibility',
        'metadata.runtimeVersion',
      ));
    }
    
    return errors.length > 0
      ? ValidationUtils.failure(errors, warnings)
      : ValidationUtils.success(warnings);
  }
}

