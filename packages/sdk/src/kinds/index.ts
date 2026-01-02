/**
 * Originals Kind System
 * 
 * Provides typed "Kinds" for Originals - a classification system that
 * enables kind-specific validation, metadata schemas, and behaviors.
 * 
 * @example
 * ```typescript
 * import { OriginalKind, KindRegistry } from '@originals/sdk';
 * 
 * // Create an App Original manifest
 * const appManifest = {
 *   kind: OriginalKind.App,
 *   name: 'MyApp',
 *   version: '1.0.0',
 *   resources: [entrypointResource],
 *   metadata: {
 *     runtime: 'node',
 *     entrypoint: 'index.js',
 *   },
 * };
 * 
 * // Validate the manifest
 * const registry = KindRegistry.getInstance();
 * const result = registry.validate(appManifest);
 * if (!result.isValid) {
 *   console.error('Validation errors:', result.errors);
 * }
 * ```
 */

// Type exports
export {
  OriginalKind,
  type DependencyRef,
  type BaseManifest,
  type AppMetadata,
  type AgentMetadata,
  type ModuleMetadata,
  type DatasetMetadata,
  type MediaMetadata,
  type DocumentMetadata,
  type KindMetadataMap,
  type KindMetadata,
  type OriginalManifest,
  type AppManifest,
  type AgentManifest,
  type ModuleManifest,
  type DatasetManifest,
  type MediaManifest,
  type DocumentManifest,
  type AnyManifest,
  type ValidationResult,
  type ValidationError,
  type ValidationWarning,
  type CreateTypedOriginalOptions,
} from './types';

// Registry export
export { KindRegistry } from './KindRegistry';

// Validator exports (for extension/customization)
export {
  type KindValidator,
  BaseKindValidator,
  ValidationUtils,
  AppValidator,
  AgentValidator,
  ModuleValidator,
  DatasetValidator,
  MediaValidator,
  DocumentValidator,
} from './validators';

