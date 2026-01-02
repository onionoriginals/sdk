/**
 * Dataset Kind Validator
 * 
 * Validates manifests for structured data collections with schema definitions.
 */

import { OriginalKind, type OriginalManifest, type ValidationResult, type DatasetMetadata } from '../types';
import { BaseKindValidator, ValidationUtils } from './base';

/**
 * Common data formats
 */
const KNOWN_FORMATS = [
  'csv', 'json', 'jsonl', 'ndjson', 'parquet', 'avro', 'orc',
  'xml', 'yaml', 'toml', 'tsv', 'excel', 'sqlite', 'arrow',
];

/**
 * Valid privacy classifications
 */
const VALID_PRIVACY = ['public', 'internal', 'confidential', 'restricted'];

/**
 * Valid update frequencies
 */
const VALID_UPDATE_FREQUENCIES = ['realtime', 'hourly', 'daily', 'weekly', 'monthly', 'static'];

/**
 * Validator for Dataset Originals
 */
export class DatasetValidator extends BaseKindValidator<OriginalKind.Dataset> {
  readonly kind = OriginalKind.Dataset;
  
  protected validateKind(manifest: OriginalManifest<OriginalKind.Dataset>): ValidationResult {
    const errors: ValidationResult['errors'] = [];
    const warnings: ValidationResult['warnings'] = [];
    const metadata = manifest.metadata as DatasetMetadata;
    
    // Validate metadata exists
    if (!metadata || typeof metadata !== 'object') {
      return ValidationUtils.failure([
        ValidationUtils.error('MISSING_METADATA', 'Dataset manifest must have metadata', 'metadata'),
      ]);
    }
    
    // Validate schema (required)
    if (!metadata.schema) {
      errors.push(ValidationUtils.error(
        'MISSING_SCHEMA',
        'Dataset must have a schema definition',
        'metadata.schema',
      ));
    } else if (typeof metadata.schema !== 'object' && typeof metadata.schema !== 'string') {
      errors.push(ValidationUtils.error(
        'INVALID_SCHEMA',
        'Schema must be an object (JSON Schema) or string (URL)',
        'metadata.schema',
      ));
    } else if (typeof metadata.schema === 'string') {
      // If it's a URL, validate it
      if (!ValidationUtils.isValidURL(metadata.schema)) {
        errors.push(ValidationUtils.error(
          'INVALID_SCHEMA_URL',
          'Schema URL is not a valid URL',
          'metadata.schema',
          metadata.schema,
        ));
      }
    }
    
    // Validate format (required)
    if (!metadata.format || typeof metadata.format !== 'string') {
      errors.push(ValidationUtils.error(
        'MISSING_FORMAT',
        'Dataset must specify a data format',
        'metadata.format',
      ));
    } else {
      const normalizedFormat = metadata.format.toLowerCase();
      if (!KNOWN_FORMATS.includes(normalizedFormat)) {
        warnings.push(ValidationUtils.warning(
          'UNKNOWN_FORMAT',
          `Data format "${metadata.format}" is not a commonly recognized format`,
          'metadata.format',
          `Consider using one of: ${KNOWN_FORMATS.join(', ')}`,
        ));
      }
    }
    
    // Validate recordCount if specified
    if (metadata.recordCount !== undefined) {
      if (typeof metadata.recordCount !== 'number' || metadata.recordCount < 0 || !Number.isInteger(metadata.recordCount)) {
        errors.push(ValidationUtils.error(
          'INVALID_RECORD_COUNT',
          'Record count must be a non-negative integer',
          'metadata.recordCount',
          metadata.recordCount,
        ));
      }
    } else {
      warnings.push(ValidationUtils.warning(
        'MISSING_RECORD_COUNT',
        'Consider specifying recordCount for better discoverability',
        'metadata.recordCount',
      ));
    }
    
    // Validate columns if specified
    if (metadata.columns) {
      if (!Array.isArray(metadata.columns)) {
        errors.push(ValidationUtils.error(
          'INVALID_COLUMNS',
          'Columns must be an array',
          'metadata.columns',
        ));
      } else {
        const columnNames = new Set<string>();
        
        for (let i = 0; i < metadata.columns.length; i++) {
          const column = metadata.columns[i];
          const columnPath = `metadata.columns[${i}]`;
          
          if (!column || typeof column !== 'object') {
            errors.push(ValidationUtils.error(
              'INVALID_COLUMN',
              `Column at index ${i} must be an object`,
              columnPath,
            ));
            continue;
          }
          
          if (!column.name || typeof column.name !== 'string') {
            errors.push(ValidationUtils.error(
              'MISSING_COLUMN_NAME',
              `Column at index ${i} must have a name`,
              `${columnPath}.name`,
            ));
          } else {
            if (columnNames.has(column.name)) {
              errors.push(ValidationUtils.error(
                'DUPLICATE_COLUMN',
                `Duplicate column name: "${column.name}"`,
                `${columnPath}.name`,
              ));
            }
            columnNames.add(column.name);
          }
          
          if (!column.type || typeof column.type !== 'string') {
            errors.push(ValidationUtils.error(
              'MISSING_COLUMN_TYPE',
              `Column "${column.name || i}" must have a type`,
              `${columnPath}.type`,
            ));
          }
        }
      }
    }
    
    // Validate source if specified
    if (metadata.source) {
      if (typeof metadata.source !== 'object') {
        errors.push(ValidationUtils.error(
          'INVALID_SOURCE',
          'Source must be an object',
          'metadata.source',
        ));
      }
    }
    
    // Validate statistics if specified
    if (metadata.statistics) {
      if (typeof metadata.statistics !== 'object') {
        errors.push(ValidationUtils.error(
          'INVALID_STATISTICS',
          'Statistics must be an object',
          'metadata.statistics',
        ));
      } else {
        if (metadata.statistics.sizeBytes !== undefined &&
            (typeof metadata.statistics.sizeBytes !== 'number' || metadata.statistics.sizeBytes < 0)) {
          errors.push(ValidationUtils.error(
            'INVALID_SIZE_BYTES',
            'sizeBytes must be a non-negative number',
            'metadata.statistics.sizeBytes',
          ));
        }
      }
    }
    
    // Validate privacy if specified
    if (metadata.privacy) {
      if (!VALID_PRIVACY.includes(metadata.privacy)) {
        errors.push(ValidationUtils.error(
          'INVALID_PRIVACY',
          `Privacy must be one of: ${VALID_PRIVACY.join(', ')}`,
          'metadata.privacy',
          metadata.privacy,
        ));
      }
    } else {
      warnings.push(ValidationUtils.warning(
        'MISSING_PRIVACY',
        'Consider specifying a privacy classification for the dataset',
        'metadata.privacy',
      ));
    }
    
    // Validate updateFrequency if specified
    if (metadata.updateFrequency) {
      if (!VALID_UPDATE_FREQUENCIES.includes(metadata.updateFrequency)) {
        errors.push(ValidationUtils.error(
          'INVALID_UPDATE_FREQUENCY',
          `Update frequency must be one of: ${VALID_UPDATE_FREQUENCIES.join(', ')}`,
          'metadata.updateFrequency',
          metadata.updateFrequency,
        ));
      }
    }
    
    // Check that at least one data resource exists
    const dataResources = manifest.resources.filter(r => 
      r.type === 'data' ||
      r.contentType.includes('csv') ||
      r.contentType.includes('json') ||
      r.contentType.includes('parquet') ||
      r.contentType.includes('octet-stream')
    );
    if (dataResources.length === 0) {
      warnings.push(ValidationUtils.warning(
        'NO_DATA_RESOURCES',
        'No data resources found. Ensure resources have appropriate types',
        'resources',
      ));
    }
    
    return errors.length > 0
      ? ValidationUtils.failure(errors, warnings)
      : ValidationUtils.success(warnings);
  }
}

