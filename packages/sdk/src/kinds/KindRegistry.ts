/**
 * Kind Registry
 * 
 * Central registry for Original kinds, providing validation and type management.
 */

import { 
  OriginalKind, 
  type OriginalManifest, 
  type ValidationResult, 
  type CreateTypedOriginalOptions,
} from './types';
import { 
  type KindValidator,
  ValidationUtils,
  AppValidator,
  AgentValidator,
  ModuleValidator,
  DatasetValidator,
  MediaValidator,
  DocumentValidator,
} from './validators';

/**
 * Registry for Original kinds
 * 
 * Provides centralized validation and type information for all kinds.
 */
export class KindRegistry {
  private static instance: KindRegistry;
  private validators: Map<OriginalKind, KindValidator<OriginalKind>>;
  
  private constructor() {
    this.validators = new Map();
    this.registerDefaultValidators();
  }
  
  /**
   * Get the singleton instance
   */
  static getInstance(): KindRegistry {
    if (!KindRegistry.instance) {
      KindRegistry.instance = new KindRegistry();
    }
    return KindRegistry.instance;
  }
  
  /**
   * Register default validators for all built-in kinds
   */
  private registerDefaultValidators(): void {
    this.validators.set(OriginalKind.App, new AppValidator());
    this.validators.set(OriginalKind.Agent, new AgentValidator());
    this.validators.set(OriginalKind.Module, new ModuleValidator());
    this.validators.set(OriginalKind.Dataset, new DatasetValidator());
    this.validators.set(OriginalKind.Media, new MediaValidator());
    this.validators.set(OriginalKind.Document, new DocumentValidator());
  }
  
  /**
   * Register a custom validator for a kind
   * Can be used to override built-in validators or add new kinds
   */
  registerValidator<K extends OriginalKind>(
    kind: K, 
    validator: KindValidator<K>
  ): void {
    this.validators.set(kind, validator as KindValidator<OriginalKind>);
  }
  
  /**
   * Get the validator for a kind
   */
  getValidator<K extends OriginalKind>(kind: K): KindValidator<K> | undefined {
    return this.validators.get(kind) as KindValidator<K> | undefined;
  }
  
  /**
   * Check if a kind is registered
   */
  hasKind(kind: OriginalKind): boolean {
    return this.validators.has(kind);
  }
  
  /**
   * Get all registered kinds
   */
  getRegisteredKinds(): OriginalKind[] {
    return Array.from(this.validators.keys());
  }
  
  /**
   * Validate a manifest
   * 
   * @param manifest - The manifest to validate
   * @param options - Validation options
   * @returns Validation result
   */
  validate<K extends OriginalKind>(
    manifest: OriginalManifest<K>,
    options?: CreateTypedOriginalOptions
  ): ValidationResult {
    // First check if kind is valid
    if (!manifest.kind) {
      return ValidationUtils.failure([
        ValidationUtils.error('MISSING_KIND', 'Manifest must specify a kind', 'kind'),
      ]);
    }
    
    // Check if kind is registered
    if (!this.hasKind(manifest.kind)) {
      return ValidationUtils.failure([
        ValidationUtils.error(
          'UNKNOWN_KIND',
          `Unknown kind: "${manifest.kind}". Registered kinds: ${this.getRegisteredKinds().join(', ')}`,
          'kind',
          manifest.kind,
        ),
      ]);
    }
    
    // Get validator and run validation
    const validator = this.getValidator(manifest.kind);
    if (!validator) {
      return ValidationUtils.failure([
        ValidationUtils.error('VALIDATOR_NOT_FOUND', `No validator found for kind: ${manifest.kind}`, 'kind'),
      ]);
    }
    
    const result = validator.validate(manifest);
    
    // In strict mode, treat warnings as errors
    if (options?.strictMode && result.warnings.length > 0) {
      const warningErrors = result.warnings.map(w => 
        ValidationUtils.error(
          `STRICT_${w.code}`,
          `[Warning treated as error] ${w.message}`,
          w.path,
        )
      );
      return ValidationUtils.failure([...result.errors, ...warningErrors], []);
    }
    
    return result;
  }
  
  /**
   * Validate a manifest and throw if invalid
   */
  validateOrThrow<K extends OriginalKind>(
    manifest: OriginalManifest<K>,
    options?: CreateTypedOriginalOptions
  ): void {
    if (options?.skipValidation) {
      return;
    }
    
    const result = this.validate(manifest, options);
    
    if (!result.isValid) {
      const errorMessages = result.errors.map(e => {
        const path = e.path ? ` at ${e.path}` : '';
        return `[${e.code}]${path}: ${e.message}`;
      });
      
      throw new Error(`Manifest validation failed:\n${errorMessages.join('\n')}`);
    }
  }
  
  /**
   * Check if a value is a valid OriginalKind
   */
  static isValidKind(value: unknown): value is OriginalKind {
    return typeof value === 'string' && Object.values(OriginalKind).includes(value as OriginalKind);
  }
  
  /**
   * Parse a kind string to OriginalKind
   * Accepts both full URIs (originals:kind:app) and short names (app)
   */
  static parseKind(value: string): OriginalKind | null {
    // Check if it's already a full kind URI
    if (KindRegistry.isValidKind(value)) {
      return value;
    }
    
    // Try to match short name
    const normalized = value.toLowerCase().trim();
    for (const kind of Object.values(OriginalKind)) {
      const shortName = kind.split(':').pop()?.toLowerCase();
      if (shortName === normalized) {
        return kind;
      }
    }
    
    return null;
  }
  
  /**
   * Get the short name of a kind (e.g., "app" from "originals:kind:app")
   */
  static getShortName(kind: OriginalKind): string {
    return kind.split(':').pop() || kind;
  }
  
  /**
   * Get human-readable display name for a kind
   */
  static getDisplayName(kind: OriginalKind): string {
    const shortName = KindRegistry.getShortName(kind);
    return shortName.charAt(0).toUpperCase() + shortName.slice(1);
  }
  
  /**
   * Create an empty manifest template for a kind
   * Useful for scaffolding new Originals
   */
  static createTemplate<K extends OriginalKind>(
    kind: K,
    name: string,
    version = '1.0.0'
  ): Partial<OriginalManifest<K>> {
    const base = {
      kind,
      name,
      version,
      resources: [],
    };
    
    // Add kind-specific metadata templates
    switch (kind) {
      case OriginalKind.App: {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const appMetadata = {
          runtime: 'node',
          entrypoint: 'index.js',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        return {
          ...base,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          metadata: appMetadata,
        };
      }

      case OriginalKind.Agent: {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const agentMetadata = {
          capabilities: [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        return {
          ...base,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          metadata: agentMetadata,
        };
      }

      case OriginalKind.Module: {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const moduleMetadata = {
          format: 'esm',
          main: 'index.js',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        return {
          ...base,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          metadata: moduleMetadata,
        };
      }

      case OriginalKind.Dataset: {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const datasetMetadata = {
          format: 'json',
          schema: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        return {
          ...base,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          metadata: datasetMetadata,
        };
      }

      case OriginalKind.Media: {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const mediaMetadata = {
          mediaType: 'image',
          mimeType: 'image/png',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        return {
          ...base,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          metadata: mediaMetadata,
        };
      }

      case OriginalKind.Document: {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const documentMetadata = {
          format: 'markdown',
          content: 'content',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
        return {
          ...base,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          metadata: documentMetadata,
        };
      }
        
      default:
        return base;
    }
  }
}

