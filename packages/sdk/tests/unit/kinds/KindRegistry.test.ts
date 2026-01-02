/**
 * Tests for KindRegistry
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import { 
  OriginalKind,
  KindRegistry,
  type AppManifest,
  type ModuleManifest,
  type ValidationResult,
  BaseKindValidator,
  ValidationUtils,
  type OriginalManifest,
} from '../../../src/kinds';

// Helper to create a minimal valid resource
const createResource = (id: string, type = 'code', contentType = 'application/javascript') => ({
  id,
  type,
  contentType,
  hash: 'abcdef1234567890',
});

describe('KindRegistry', () => {
  describe('getInstance', () => {
    it('should return a singleton instance', () => {
      const instance1 = KindRegistry.getInstance();
      const instance2 = KindRegistry.getInstance();
      
      expect(instance1).toBe(instance2);
    });
    
    it('should have all default validators registered', () => {
      const registry = KindRegistry.getInstance();
      
      expect(registry.hasKind(OriginalKind.App)).toBe(true);
      expect(registry.hasKind(OriginalKind.Agent)).toBe(true);
      expect(registry.hasKind(OriginalKind.Module)).toBe(true);
      expect(registry.hasKind(OriginalKind.Dataset)).toBe(true);
      expect(registry.hasKind(OriginalKind.Media)).toBe(true);
      expect(registry.hasKind(OriginalKind.Document)).toBe(true);
    });
  });
  
  describe('getRegisteredKinds', () => {
    it('should return all registered kinds', () => {
      const registry = KindRegistry.getInstance();
      const kinds = registry.getRegisteredKinds();
      
      expect(kinds.length).toBe(6);
      expect(kinds).toContain(OriginalKind.App);
      expect(kinds).toContain(OriginalKind.Agent);
      expect(kinds).toContain(OriginalKind.Module);
      expect(kinds).toContain(OriginalKind.Dataset);
      expect(kinds).toContain(OriginalKind.Media);
      expect(kinds).toContain(OriginalKind.Document);
    });
  });
  
  describe('validate', () => {
    it('should validate a valid App manifest', () => {
      const registry = KindRegistry.getInstance();
      const manifest: AppManifest = {
        kind: OriginalKind.App,
        name: 'test-app',
        version: '1.0.0',
        resources: [createResource('index.js')],
        metadata: {
          runtime: 'node',
          entrypoint: 'index.js',
        }
      };
      
      const result = registry.validate(manifest);
      expect(result.isValid).toBe(true);
    });
    
    it('should fail for missing kind', () => {
      const registry = KindRegistry.getInstance();
      const manifest = {
        name: 'test-app',
        version: '1.0.0',
        resources: [createResource('index.js')],
      } as any;
      
      const result = registry.validate(manifest);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.code === 'MISSING_KIND')).toBe(true);
    });
    
    it('should fail for unknown kind', () => {
      const registry = KindRegistry.getInstance();
      const manifest = {
        kind: 'originals:kind:unknown' as any,
        name: 'test',
        version: '1.0.0',
        resources: [createResource('file.js')],
        metadata: {},
      } as any;
      
      const result = registry.validate(manifest);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.code === 'UNKNOWN_KIND')).toBe(true);
    });
    
    it('should treat warnings as errors in strict mode', () => {
      const registry = KindRegistry.getInstance();
      const manifest: AppManifest = {
        kind: OriginalKind.App,
        name: 'test-app',
        version: '1.0.0',
        resources: [createResource('index.js')],
        metadata: {
          runtime: 'node',
          entrypoint: 'index.js',
          // No runtimeVersion - will generate warning
        }
      };
      
      // Without strict mode - should pass
      const normalResult = registry.validate(manifest);
      expect(normalResult.isValid).toBe(true);
      expect(normalResult.warnings.length).toBeGreaterThan(0);
      
      // With strict mode - should fail
      const strictResult = registry.validate(manifest, { strictMode: true });
      expect(strictResult.isValid).toBe(false);
    });
  });
  
  describe('validateOrThrow', () => {
    it('should not throw for valid manifest', () => {
      const registry = KindRegistry.getInstance();
      const manifest: ModuleManifest = {
        kind: OriginalKind.Module,
        name: 'test-module',
        version: '1.0.0',
        resources: [createResource('index.js')],
        metadata: {
          format: 'esm',
          main: 'index.js',
        }
      };
      
      expect(() => registry.validateOrThrow(manifest)).not.toThrow();
    });
    
    it('should throw for invalid manifest', () => {
      const registry = KindRegistry.getInstance();
      const manifest = {
        kind: OriginalKind.Module,
        name: '',  // invalid empty name
        version: '1.0.0',
        resources: [createResource('index.js')],
        metadata: {
          format: 'esm',
          main: 'index.js',
        }
      } as ModuleManifest;
      
      expect(() => registry.validateOrThrow(manifest)).toThrow('Manifest validation failed');
    });
    
    it('should skip validation when skipValidation is true', () => {
      const registry = KindRegistry.getInstance();
      const invalidManifest = {
        kind: OriginalKind.Module,
        name: '',  // invalid
        version: 'invalid',  // invalid
        resources: [],  // invalid
        metadata: {} as any
      } as ModuleManifest;
      
      expect(() => registry.validateOrThrow(invalidManifest, { skipValidation: true })).not.toThrow();
    });
  });
  
  describe('registerValidator', () => {
    it('should allow registering custom validators', () => {
      const registry = KindRegistry.getInstance();
      
      // Create a custom validator
      class CustomAppValidator extends BaseKindValidator<OriginalKind.App> {
        readonly kind = OriginalKind.App;
        
        protected validateKind(manifest: OriginalManifest<OriginalKind.App>): ValidationResult {
          // Custom validation that always adds a warning
          return ValidationUtils.success([
            ValidationUtils.warning('CUSTOM_WARNING', 'Custom validator was used')
          ]);
        }
      }
      
      // Register the custom validator
      registry.registerValidator(OriginalKind.App, new CustomAppValidator());
      
      // Validate a manifest
      const manifest: AppManifest = {
        kind: OriginalKind.App,
        name: 'test-app',
        version: '1.0.0',
        resources: [createResource('index.js')],
        metadata: {
          runtime: 'node',
          entrypoint: 'index.js',
        }
      };
      
      const result = registry.validate(manifest);
      expect(result.warnings.some(w => w.code === 'CUSTOM_WARNING')).toBe(true);
    });
  });
  
  describe('static helpers', () => {
    describe('isValidKind', () => {
      it('should return true for valid kinds', () => {
        expect(KindRegistry.isValidKind(OriginalKind.App)).toBe(true);
        expect(KindRegistry.isValidKind(OriginalKind.Module)).toBe(true);
        expect(KindRegistry.isValidKind('originals:kind:app')).toBe(true);
      });
      
      it('should return false for invalid kinds', () => {
        expect(KindRegistry.isValidKind('invalid')).toBe(false);
        expect(KindRegistry.isValidKind('originals:kind:unknown')).toBe(false);
        expect(KindRegistry.isValidKind(null)).toBe(false);
        expect(KindRegistry.isValidKind(undefined)).toBe(false);
        expect(KindRegistry.isValidKind(123)).toBe(false);
      });
    });
    
    describe('parseKind', () => {
      it('should parse full kind URIs', () => {
        expect(KindRegistry.parseKind('originals:kind:app')).toBe(OriginalKind.App);
        expect(KindRegistry.parseKind('originals:kind:module')).toBe(OriginalKind.Module);
      });
      
      it('should parse short names', () => {
        expect(KindRegistry.parseKind('app')).toBe(OriginalKind.App);
        expect(KindRegistry.parseKind('module')).toBe(OriginalKind.Module);
        expect(KindRegistry.parseKind('dataset')).toBe(OriginalKind.Dataset);
        expect(KindRegistry.parseKind('agent')).toBe(OriginalKind.Agent);
        expect(KindRegistry.parseKind('media')).toBe(OriginalKind.Media);
        expect(KindRegistry.parseKind('document')).toBe(OriginalKind.Document);
      });
      
      it('should be case-insensitive for short names', () => {
        expect(KindRegistry.parseKind('APP')).toBe(OriginalKind.App);
        expect(KindRegistry.parseKind('Module')).toBe(OriginalKind.Module);
        expect(KindRegistry.parseKind('DATASET')).toBe(OriginalKind.Dataset);
      });
      
      it('should return null for unknown kinds', () => {
        expect(KindRegistry.parseKind('unknown')).toBe(null);
        expect(KindRegistry.parseKind('')).toBe(null);
      });
    });
    
    describe('getShortName', () => {
      it('should extract short name from kind URI', () => {
        expect(KindRegistry.getShortName(OriginalKind.App)).toBe('app');
        expect(KindRegistry.getShortName(OriginalKind.Module)).toBe('module');
        expect(KindRegistry.getShortName(OriginalKind.Dataset)).toBe('dataset');
      });
    });
    
    describe('getDisplayName', () => {
      it('should return capitalized display name', () => {
        expect(KindRegistry.getDisplayName(OriginalKind.App)).toBe('App');
        expect(KindRegistry.getDisplayName(OriginalKind.Module)).toBe('Module');
        expect(KindRegistry.getDisplayName(OriginalKind.Dataset)).toBe('Dataset');
      });
    });
    
    describe('createTemplate', () => {
      it('should create App template', () => {
        const template = KindRegistry.createTemplate(OriginalKind.App, 'my-app', '1.0.0');
        
        expect(template.kind).toBe(OriginalKind.App);
        expect(template.name).toBe('my-app');
        expect(template.version).toBe('1.0.0');
        expect((template.metadata as any)?.runtime).toBe('node');
        expect((template.metadata as any)?.entrypoint).toBe('index.js');
      });
      
      it('should create Module template', () => {
        const template = KindRegistry.createTemplate(OriginalKind.Module, 'my-module');
        
        expect(template.kind).toBe(OriginalKind.Module);
        expect((template.metadata as any)?.format).toBe('esm');
        expect((template.metadata as any)?.main).toBe('index.js');
      });
      
      it('should create Dataset template', () => {
        const template = KindRegistry.createTemplate(OriginalKind.Dataset, 'my-dataset');
        
        expect(template.kind).toBe(OriginalKind.Dataset);
        expect((template.metadata as any)?.format).toBe('json');
      });
      
      it('should create Agent template', () => {
        const template = KindRegistry.createTemplate(OriginalKind.Agent, 'my-agent');
        
        expect(template.kind).toBe(OriginalKind.Agent);
        expect((template.metadata as any)?.capabilities).toEqual([]);
      });
      
      it('should create Media template', () => {
        const template = KindRegistry.createTemplate(OriginalKind.Media, 'my-media');
        
        expect(template.kind).toBe(OriginalKind.Media);
        expect((template.metadata as any)?.mediaType).toBe('image');
      });
      
      it('should create Document template', () => {
        const template = KindRegistry.createTemplate(OriginalKind.Document, 'my-doc');
        
        expect(template.kind).toBe(OriginalKind.Document);
        expect((template.metadata as any)?.format).toBe('markdown');
      });
      
      it('should use default version if not provided', () => {
        const template = KindRegistry.createTemplate(OriginalKind.App, 'my-app');
        expect(template.version).toBe('1.0.0');
      });
    });
  });
});

