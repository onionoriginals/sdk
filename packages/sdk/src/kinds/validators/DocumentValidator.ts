/**
 * Document Kind Validator
 * 
 * Validates manifests for text documents with formatting and sections.
 */

import { OriginalKind, type OriginalManifest, type ValidationResult, type DocumentMetadata } from '../types';
import { BaseKindValidator, ValidationUtils } from './base';

/**
 * Valid document formats
 */
const VALID_FORMATS = ['markdown', 'html', 'pdf', 'docx', 'txt', 'asciidoc', 'rst', 'latex'];

/**
 * Valid document statuses
 */
const VALID_STATUSES = ['draft', 'review', 'published', 'archived'];

/**
 * Validator for Document Originals
 */
export class DocumentValidator extends BaseKindValidator<OriginalKind.Document> {
  readonly kind = OriginalKind.Document;
  
  protected validateKind(manifest: OriginalManifest<OriginalKind.Document>): ValidationResult {
    const errors: ValidationResult['errors'] = [];
    const warnings: ValidationResult['warnings'] = [];
    const metadata = manifest.metadata as DocumentMetadata;
    
    // Validate metadata exists
    if (!metadata || typeof metadata !== 'object') {
      return ValidationUtils.failure([
        ValidationUtils.error('MISSING_METADATA', 'Document manifest must have metadata', 'metadata'),
      ]);
    }
    
    // Validate format (required)
    if (!metadata.format) {
      errors.push(ValidationUtils.error(
        'MISSING_FORMAT',
        'Document must specify a format',
        'metadata.format',
      ));
    } else if (!VALID_FORMATS.includes(metadata.format)) {
      errors.push(ValidationUtils.error(
        'INVALID_FORMAT',
        `Invalid document format: "${metadata.format}". Must be one of: ${VALID_FORMATS.join(', ')}`,
        'metadata.format',
        metadata.format,
      ));
    }
    
    // Validate content (required)
    if (!metadata.content || typeof metadata.content !== 'string') {
      errors.push(ValidationUtils.error(
        'MISSING_CONTENT',
        'Document must specify a content resource',
        'metadata.content',
      ));
    } else {
      // Check if content references an existing resource
      if (!ValidationUtils.resourceExists(metadata.content, manifest.resources)) {
        warnings.push(ValidationUtils.warning(
          'CONTENT_NOT_RESOURCE',
          `Content "${metadata.content}" does not match a resource ID`,
          'metadata.content',
          'Ensure the content field references a valid resource ID',
        ));
      }
    }
    
    // Validate language if specified
    if (metadata.language) {
      if (typeof metadata.language !== 'string') {
        errors.push(ValidationUtils.error(
          'INVALID_LANGUAGE',
          'Language must be a string',
          'metadata.language',
        ));
      } else if (!ValidationUtils.isValidLanguageCode(metadata.language)) {
        warnings.push(ValidationUtils.warning(
          'INVALID_LANGUAGE_CODE',
          `Language "${metadata.language}" is not a valid ISO 639-1 code`,
          'metadata.language',
          'Use a 2-letter language code like "en", "es", "fr"',
        ));
      }
    }
    
    // Validate toc if specified
    if (metadata.toc) {
      if (!Array.isArray(metadata.toc)) {
        errors.push(ValidationUtils.error(
          'INVALID_TOC',
          'Table of contents must be an array',
          'metadata.toc',
        ));
      } else {
        for (let i = 0; i < metadata.toc.length; i++) {
          const entry = metadata.toc[i];
          const entryPath = `metadata.toc[${i}]`;
          
          if (!entry || typeof entry !== 'object') {
            errors.push(ValidationUtils.error(
              'INVALID_TOC_ENTRY',
              `TOC entry at index ${i} must be an object`,
              entryPath,
            ));
            continue;
          }
          
          if (!entry.title || typeof entry.title !== 'string') {
            errors.push(ValidationUtils.error(
              'MISSING_TOC_TITLE',
              `TOC entry at index ${i} must have a title`,
              `${entryPath}.title`,
            ));
          }
          
          if (typeof entry.level !== 'number' || entry.level < 1 || !Number.isInteger(entry.level)) {
            errors.push(ValidationUtils.error(
              'INVALID_TOC_LEVEL',
              `TOC entry at index ${i} must have a valid level (positive integer)`,
              `${entryPath}.level`,
            ));
          }
        }
      }
    }
    
    // Validate pageCount if specified
    if (metadata.pageCount !== undefined) {
      if (typeof metadata.pageCount !== 'number' || metadata.pageCount <= 0 || !Number.isInteger(metadata.pageCount)) {
        errors.push(ValidationUtils.error(
          'INVALID_PAGE_COUNT',
          'Page count must be a positive integer',
          'metadata.pageCount',
        ));
      }
    }
    
    // Validate wordCount if specified
    if (metadata.wordCount !== undefined) {
      if (typeof metadata.wordCount !== 'number' || metadata.wordCount < 0 || !Number.isInteger(metadata.wordCount)) {
        errors.push(ValidationUtils.error(
          'INVALID_WORD_COUNT',
          'Word count must be a non-negative integer',
          'metadata.wordCount',
        ));
      }
    }
    
    // Validate readingTime if specified
    if (metadata.readingTime !== undefined) {
      if (typeof metadata.readingTime !== 'number' || metadata.readingTime <= 0) {
        errors.push(ValidationUtils.error(
          'INVALID_READING_TIME',
          'Reading time must be a positive number (minutes)',
          'metadata.readingTime',
        ));
      }
    }
    
    // Validate keywords if specified
    if (metadata.keywords) {
      if (!Array.isArray(metadata.keywords)) {
        errors.push(ValidationUtils.error(
          'INVALID_KEYWORDS',
          'Keywords must be an array of strings',
          'metadata.keywords',
        ));
      } else {
        for (let i = 0; i < metadata.keywords.length; i++) {
          if (typeof metadata.keywords[i] !== 'string') {
            errors.push(ValidationUtils.error(
              'INVALID_KEYWORD',
              `Keyword at index ${i} must be a string`,
              `metadata.keywords[${i}]`,
            ));
          }
        }
      }
    }
    
    // Validate references if specified
    if (metadata.references) {
      if (!Array.isArray(metadata.references)) {
        errors.push(ValidationUtils.error(
          'INVALID_REFERENCES',
          'References must be an array',
          'metadata.references',
        ));
      } else {
        const refIds = new Set<string>();
        
        for (let i = 0; i < metadata.references.length; i++) {
          const ref = metadata.references[i];
          const refPath = `metadata.references[${i}]`;
          
          if (!ref || typeof ref !== 'object') {
            errors.push(ValidationUtils.error(
              'INVALID_REFERENCE',
              `Reference at index ${i} must be an object`,
              refPath,
            ));
            continue;
          }
          
          if (!ref.id || typeof ref.id !== 'string') {
            errors.push(ValidationUtils.error(
              'MISSING_REFERENCE_ID',
              `Reference at index ${i} must have an id`,
              `${refPath}.id`,
            ));
          } else {
            if (refIds.has(ref.id)) {
              errors.push(ValidationUtils.error(
                'DUPLICATE_REFERENCE_ID',
                `Duplicate reference id: "${ref.id}"`,
                `${refPath}.id`,
              ));
            }
            refIds.add(ref.id);
          }
          
          if (!ref.title || typeof ref.title !== 'string') {
            errors.push(ValidationUtils.error(
              'MISSING_REFERENCE_TITLE',
              `Reference at index ${i} must have a title`,
              `${refPath}.title`,
            ));
          }
          
          // Validate URL if present
          if (ref.url && !ValidationUtils.isValidURL(ref.url)) {
            warnings.push(ValidationUtils.warning(
              'INVALID_REFERENCE_URL',
              `Reference "${ref.id}" has an invalid URL`,
              `${refPath}.url`,
            ));
          }
        }
      }
    }
    
    // Validate status if specified
    if (metadata.status) {
      if (!VALID_STATUSES.includes(metadata.status)) {
        errors.push(ValidationUtils.error(
          'INVALID_STATUS',
          `Invalid document status: "${metadata.status}". Must be one of: ${VALID_STATUSES.join(', ')}`,
          'metadata.status',
          metadata.status,
        ));
      }
    }
    
    // Validate revision if specified
    if (metadata.revision !== undefined) {
      if (typeof metadata.revision !== 'number' || metadata.revision < 1 || !Number.isInteger(metadata.revision)) {
        errors.push(ValidationUtils.error(
          'INVALID_REVISION',
          'Revision must be a positive integer',
          'metadata.revision',
        ));
      }
    }
    
    // Suggest adding language
    if (!metadata.language) {
      warnings.push(ValidationUtils.warning(
        'MISSING_LANGUAGE',
        'Consider specifying the document language',
        'metadata.language',
        'Add a language code like "en" for English',
      ));
    }
    
    // Suggest adding abstract
    if (!metadata.abstract) {
      warnings.push(ValidationUtils.warning(
        'MISSING_ABSTRACT',
        'Consider adding an abstract or summary',
        'metadata.abstract',
      ));
    }
    
    // Check that at least one document resource exists
    const docResources = manifest.resources.filter(r => 
      r.type === 'document' ||
      r.type === 'text' ||
      r.contentType.includes('text/') ||
      r.contentType.includes('markdown') ||
      r.contentType.includes('html') ||
      r.contentType.includes('pdf')
    );
    if (docResources.length === 0) {
      warnings.push(ValidationUtils.warning(
        'NO_DOCUMENT_RESOURCES',
        'No document resources found. Ensure resources have appropriate types',
        'resources',
      ));
    }
    
    return errors.length > 0
      ? ValidationUtils.failure(errors, warnings)
      : ValidationUtils.success(warnings);
  }
}

