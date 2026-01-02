/**
 * Media Kind Validator
 * 
 * Validates manifests for media content (image, audio, video) with format metadata.
 */

import { OriginalKind, type OriginalManifest, type ValidationResult, type MediaMetadata } from '../types';
import { BaseKindValidator, ValidationUtils } from './base';

/**
 * Valid media types
 */
const VALID_MEDIA_TYPES = ['image', 'audio', 'video', '3d', 'animation'];

/**
 * Common MIME types by media type
 */
const COMMON_MIME_TYPES: Record<string, string[]> = {
  image: [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'image/avif', 'image/bmp', 'image/tiff', 'image/heic', 'image/heif',
  ],
  audio: [
    'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/flac',
    'audio/aac', 'audio/webm', 'audio/midi', 'audio/x-wav',
  ],
  video: [
    'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-msvideo',
    'video/x-matroska', 'video/mpeg',
  ],
  '3d': [
    'model/gltf+json', 'model/gltf-binary', 'model/obj', 'model/stl',
    'application/octet-stream',
  ],
  animation: [
    'image/gif', 'video/mp4', 'video/webm', 'application/json', // Lottie
  ],
};

/**
 * Validator for Media Originals
 */
export class MediaValidator extends BaseKindValidator<OriginalKind.Media> {
  readonly kind = OriginalKind.Media;
  
  protected validateKind(manifest: OriginalManifest<OriginalKind.Media>): ValidationResult {
    const errors: ValidationResult['errors'] = [];
    const warnings: ValidationResult['warnings'] = [];
    const metadata = manifest.metadata as MediaMetadata;
    
    // Validate metadata exists
    if (!metadata || typeof metadata !== 'object') {
      return ValidationUtils.failure([
        ValidationUtils.error('MISSING_METADATA', 'Media manifest must have metadata', 'metadata'),
      ]);
    }
    
    // Validate mediaType (required)
    if (!metadata.mediaType) {
      errors.push(ValidationUtils.error(
        'MISSING_MEDIA_TYPE',
        'Media must specify a mediaType',
        'metadata.mediaType',
      ));
    } else if (!VALID_MEDIA_TYPES.includes(metadata.mediaType)) {
      errors.push(ValidationUtils.error(
        'INVALID_MEDIA_TYPE',
        `Invalid mediaType: "${metadata.mediaType}". Must be one of: ${VALID_MEDIA_TYPES.join(', ')}`,
        'metadata.mediaType',
        metadata.mediaType,
      ));
    }
    
    // Validate mimeType (required)
    if (!metadata.mimeType || typeof metadata.mimeType !== 'string') {
      errors.push(ValidationUtils.error(
        'MISSING_MIME_TYPE',
        'Media must specify a mimeType',
        'metadata.mimeType',
      ));
    } else if (!ValidationUtils.isValidMimeType(metadata.mimeType)) {
      errors.push(ValidationUtils.error(
        'INVALID_MIME_TYPE',
        `Invalid mimeType format: "${metadata.mimeType}"`,
        'metadata.mimeType',
        metadata.mimeType,
      ));
    } else if (metadata.mediaType) {
      // Check if MIME type matches the declared media type
      const expectedMimeTypes = COMMON_MIME_TYPES[metadata.mediaType];
      if (expectedMimeTypes && !expectedMimeTypes.includes(metadata.mimeType)) {
        warnings.push(ValidationUtils.warning(
          'MIME_TYPE_MISMATCH',
          `mimeType "${metadata.mimeType}" is not typically associated with mediaType "${metadata.mediaType}"`,
          'metadata.mimeType',
        ));
      }
    }
    
    // Validate dimensions for images and video
    if (metadata.mediaType === 'image' || metadata.mediaType === 'video') {
      if (metadata.dimensions) {
        if (typeof metadata.dimensions !== 'object') {
          errors.push(ValidationUtils.error(
            'INVALID_DIMENSIONS',
            'Dimensions must be an object',
            'metadata.dimensions',
          ));
        } else {
          if (typeof metadata.dimensions.width !== 'number' || metadata.dimensions.width <= 0) {
            errors.push(ValidationUtils.error(
              'INVALID_WIDTH',
              'Width must be a positive number',
              'metadata.dimensions.width',
            ));
          }
          if (typeof metadata.dimensions.height !== 'number' || metadata.dimensions.height <= 0) {
            errors.push(ValidationUtils.error(
              'INVALID_HEIGHT',
              'Height must be a positive number',
              'metadata.dimensions.height',
            ));
          }
        }
      } else {
        warnings.push(ValidationUtils.warning(
          'MISSING_DIMENSIONS',
          `Consider specifying dimensions for ${metadata.mediaType} content`,
          'metadata.dimensions',
        ));
      }
    }
    
    // Validate duration for audio and video
    if (metadata.mediaType === 'audio' || metadata.mediaType === 'video') {
      if (metadata.duration !== undefined) {
        if (typeof metadata.duration !== 'number' || metadata.duration < 0) {
          errors.push(ValidationUtils.error(
            'INVALID_DURATION',
            'Duration must be a non-negative number (seconds)',
            'metadata.duration',
          ));
        }
      } else {
        warnings.push(ValidationUtils.warning(
          'MISSING_DURATION',
          `Consider specifying duration for ${metadata.mediaType} content`,
          'metadata.duration',
        ));
      }
    }
    
    // Validate frameRate for video
    if (metadata.mediaType === 'video' || metadata.mediaType === 'animation') {
      if (metadata.frameRate !== undefined) {
        if (typeof metadata.frameRate !== 'number' || metadata.frameRate <= 0) {
          errors.push(ValidationUtils.error(
            'INVALID_FRAME_RATE',
            'Frame rate must be a positive number',
            'metadata.frameRate',
          ));
        }
      }
    }
    
    // Validate audio-specific fields
    if (metadata.mediaType === 'audio' || metadata.mediaType === 'video') {
      if (metadata.audioChannels !== undefined) {
        if (typeof metadata.audioChannels !== 'number' || 
            metadata.audioChannels <= 0 || 
            !Number.isInteger(metadata.audioChannels)) {
          errors.push(ValidationUtils.error(
            'INVALID_AUDIO_CHANNELS',
            'Audio channels must be a positive integer',
            'metadata.audioChannels',
          ));
        }
      }
      
      if (metadata.sampleRate !== undefined) {
        if (typeof metadata.sampleRate !== 'number' || metadata.sampleRate <= 0) {
          errors.push(ValidationUtils.error(
            'INVALID_SAMPLE_RATE',
            'Sample rate must be a positive number',
            'metadata.sampleRate',
          ));
        }
      }
    }
    
    // Validate bitrate if specified
    if (metadata.bitrate !== undefined) {
      if (typeof metadata.bitrate !== 'number' || metadata.bitrate <= 0) {
        errors.push(ValidationUtils.error(
          'INVALID_BITRATE',
          'Bitrate must be a positive number (kbps)',
          'metadata.bitrate',
        ));
      }
    }
    
    // Validate thumbnail if specified
    if (metadata.thumbnail) {
      if (typeof metadata.thumbnail !== 'string') {
        errors.push(ValidationUtils.error(
          'INVALID_THUMBNAIL',
          'Thumbnail must be a string (resource ID)',
          'metadata.thumbnail',
        ));
      } else if (!ValidationUtils.resourceExists(metadata.thumbnail, manifest.resources)) {
        warnings.push(ValidationUtils.warning(
          'THUMBNAIL_NOT_RESOURCE',
          `Thumbnail "${metadata.thumbnail}" does not match a resource ID`,
          'metadata.thumbnail',
        ));
      }
    }
    
    // Validate preview if specified
    if (metadata.preview) {
      if (typeof metadata.preview !== 'string') {
        errors.push(ValidationUtils.error(
          'INVALID_PREVIEW',
          'Preview must be a string (resource ID)',
          'metadata.preview',
        ));
      } else if (!ValidationUtils.resourceExists(metadata.preview, manifest.resources)) {
        warnings.push(ValidationUtils.warning(
          'PREVIEW_NOT_RESOURCE',
          `Preview "${metadata.preview}" does not match a resource ID`,
          'metadata.preview',
        ));
      }
    }
    
    // Suggest adding alt text for accessibility
    if (!metadata.altText && metadata.mediaType === 'image') {
      warnings.push(ValidationUtils.warning(
        'MISSING_ALT_TEXT',
        'Consider adding altText for accessibility',
        'metadata.altText',
      ));
    }
    
    // Check that at least one media resource exists
    const mediaResources = manifest.resources.filter(r => 
      r.type === 'media' ||
      r.type === 'image' ||
      r.type === 'audio' ||
      r.type === 'video' ||
      r.contentType.startsWith('image/') ||
      r.contentType.startsWith('audio/') ||
      r.contentType.startsWith('video/') ||
      r.contentType.startsWith('model/')
    );
    if (mediaResources.length === 0) {
      warnings.push(ValidationUtils.warning(
        'NO_MEDIA_RESOURCES',
        'No media resources found. Ensure resources have appropriate types',
        'resources',
      ));
    }
    
    return errors.length > 0
      ? ValidationUtils.failure(errors, warnings)
      : ValidationUtils.success(warnings);
  }
}

