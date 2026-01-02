/**
 * Integration tests for createTypedOriginal
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import { OriginalsSDK } from '../../src/core/OriginalsSDK';
import { 
  OriginalKind,
  type AppManifest,
  type ModuleManifest,
  type DatasetManifest,
  KindRegistry,
} from '../../src/kinds';
import { hashResource } from '../../src/utils/validation';

describe('LifecycleManager.createTypedOriginal', () => {
  let sdk: OriginalsSDK;
  
  beforeEach(() => {
    sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      enableLogging: false,
    });
  });
  
  // Helper to create a resource with valid hash
  const createResource = (id: string, content: string, type: string, contentType: string) => {
    const hash = hashResource(Buffer.from(content));
    return {
      id,
      type,
      contentType,
      content,
      hash,
    };
  };
  
  describe('App Original creation', () => {
    it('should create a valid App Original', async () => {
      const manifest: AppManifest = {
        kind: OriginalKind.App,
        name: 'test-cli-app',
        version: '1.0.0',
        description: 'A test CLI application',
        resources: [
          createResource('index.js', 'console.log("Hello");', 'code', 'application/javascript'),
        ],
        metadata: {
          runtime: 'node',
          entrypoint: 'index.js',
          platforms: ['linux', 'darwin'],
        }
      };
      
      const asset = await sdk.lifecycle.createTypedOriginal(OriginalKind.App, manifest);
      
      expect(asset).toBeDefined();
      expect(asset.id).toMatch(/^did:peer:/);
      expect(asset.currentLayer).toBe('did:peer');
      expect(asset.resources.length).toBe(1);
      expect(asset.resources[0].id).toBe('index.js');
    });
    
    it('should store manifest on the asset', async () => {
      const manifest: AppManifest = {
        kind: OriginalKind.App,
        name: 'manifest-test',
        version: '2.0.0',
        resources: [
          createResource('app.js', 'export default {}', 'code', 'application/javascript'),
        ],
        metadata: {
          runtime: 'bun',
          entrypoint: 'app.js',
        }
      };
      
      const asset = await sdk.lifecycle.createTypedOriginal(OriginalKind.App, manifest);
      
      // Retrieve manifest using getManifest
      const storedManifest = sdk.lifecycle.getManifest<OriginalKind.App>(asset);
      
      expect(storedManifest).toBeDefined();
      expect(storedManifest?.name).toBe('manifest-test');
      expect(storedManifest?.version).toBe('2.0.0');
      expect(storedManifest?.metadata.runtime).toBe('bun');
    });
    
    it('should reject invalid App manifest', async () => {
      const invalidManifest = {
        kind: OriginalKind.App,
        name: 'invalid-app',
        version: '1.0.0',
        resources: [
          createResource('index.js', 'code', 'code', 'application/javascript'),
        ],
        metadata: {
          // Missing runtime and entrypoint
        } as any
      } as AppManifest;
      
      await expect(
        sdk.lifecycle.createTypedOriginal(OriginalKind.App, invalidManifest)
      ).rejects.toThrow(/validation failed/i);
    });
    
    it('should reject mismatched kind', async () => {
      const manifest: AppManifest = {
        kind: OriginalKind.App,
        name: 'test-app',
        version: '1.0.0',
        resources: [
          createResource('index.js', 'code', 'code', 'application/javascript'),
        ],
        metadata: {
          runtime: 'node',
          entrypoint: 'index.js',
        }
      };
      
      // Try to create with wrong kind
      await expect(
        sdk.lifecycle.createTypedOriginal(OriginalKind.Module, manifest as any)
      ).rejects.toThrow(/does not match/);
    });
  });
  
  describe('Module Original creation', () => {
    it('should create a valid Module Original', async () => {
      const manifest: ModuleManifest = {
        kind: OriginalKind.Module,
        name: '@myorg/utils',
        version: '1.0.0',
        description: 'Utility functions',
        resources: [
          createResource('index.mjs', 'export function add(a, b) { return a + b; }', 'code', 'application/javascript'),
          createResource('index.d.ts', 'export function add(a: number, b: number): number;', 'code', 'application/typescript'),
        ],
        metadata: {
          format: 'esm',
          main: 'index.mjs',
          types: 'index.d.ts',
          exports: {
            '.': {
              import: './index.mjs',
              types: './index.d.ts',
            }
          }
        }
      };
      
      const asset = await sdk.lifecycle.createTypedOriginal(OriginalKind.Module, manifest);
      
      expect(asset).toBeDefined();
      expect(asset.resources.length).toBe(2);
    });
    
    it('should reject module with invalid format', async () => {
      const manifest = {
        kind: OriginalKind.Module,
        name: 'bad-module',
        version: '1.0.0',
        resources: [
          createResource('index.js', 'module.exports = {}', 'code', 'application/javascript'),
        ],
        metadata: {
          format: 'invalid-format' as any,
          main: 'index.js',
        }
      } as ModuleManifest;
      
      await expect(
        sdk.lifecycle.createTypedOriginal(OriginalKind.Module, manifest)
      ).rejects.toThrow(/validation failed/i);
    });
  });
  
  describe('Dataset Original creation', () => {
    it('should create a valid Dataset Original', async () => {
      const manifest: DatasetManifest = {
        kind: OriginalKind.Dataset,
        name: 'user-analytics',
        version: '1.0.0',
        resources: [
          createResource('data.json', '{"users": []}', 'data', 'application/json'),
        ],
        metadata: {
          format: 'json',
          schema: {
            type: 'object',
            properties: {
              users: { type: 'array' }
            }
          },
          recordCount: 0,
          privacy: 'internal',
        }
      };
      
      const asset = await sdk.lifecycle.createTypedOriginal(OriginalKind.Dataset, manifest);
      
      expect(asset).toBeDefined();
      expect(asset.resources.length).toBe(1);
    });
  });
  
  describe('Options handling', () => {
    it('should skip validation when skipValidation is true', async () => {
      // This manifest is technically invalid (missing entrypoint)
      const invalidManifest = {
        kind: OriginalKind.App,
        name: 'skip-validation-test',
        version: '1.0.0',
        resources: [
          createResource('index.js', 'code', 'code', 'application/javascript'),
        ],
        metadata: {
          runtime: 'node',
          // Missing entrypoint - would normally fail validation
        } as any
      } as AppManifest;
      
      // Should not throw when skipping validation
      const asset = await sdk.lifecycle.createTypedOriginal(
        OriginalKind.App,
        invalidManifest,
        { skipValidation: true }
      );
      
      expect(asset).toBeDefined();
    });
    
    it('should fail in strict mode when there are warnings', async () => {
      const manifest: AppManifest = {
        kind: OriginalKind.App,
        name: 'strict-mode-test',
        version: '1.0.0',
        // No description - generates warning
        resources: [
          createResource('index.js', 'code', 'code', 'application/javascript'),
        ],
        metadata: {
          runtime: 'node',
          entrypoint: 'index.js',
          // No runtimeVersion - generates warning
        }
      };
      
      // Without strict mode - should pass
      const asset = await sdk.lifecycle.createTypedOriginal(
        OriginalKind.App,
        manifest,
        { strictMode: false }
      );
      expect(asset).toBeDefined();
      
      // With strict mode - should fail due to warnings
      await expect(
        sdk.lifecycle.createTypedOriginal(OriginalKind.App, manifest, { strictMode: true })
      ).rejects.toThrow(/validation failed/i);
    });
  });
  
  describe('Cost estimation', () => {
    it('should estimate cost for typed Original to did:btco', async () => {
      const manifest: ModuleManifest = {
        kind: OriginalKind.Module,
        name: 'cost-test-module',
        version: '1.0.0',
        resources: [
          createResource('index.js', 'export const x = 1;', 'code', 'application/javascript'),
        ],
        metadata: {
          format: 'esm',
          main: 'index.js',
        }
      };
      
      const estimate = await sdk.lifecycle.estimateTypedOriginalCost(
        manifest,
        'did:btco'
      );
      
      expect(estimate).toBeDefined();
      expect(estimate.totalSats).toBeGreaterThan(0);
      expect(estimate.dataSize).toBeGreaterThan(0);
      expect(estimate.targetLayer).toBe('did:btco');
      expect(estimate.breakdown).toBeDefined();
      expect(estimate.breakdown.networkFee).toBeGreaterThan(0);
    });
    
    it('should return zero cost for did:webvh', async () => {
      const manifest: ModuleManifest = {
        kind: OriginalKind.Module,
        name: 'webvh-cost-test',
        version: '1.0.0',
        resources: [
          createResource('index.js', 'export const x = 1;', 'code', 'application/javascript'),
        ],
        metadata: {
          format: 'esm',
          main: 'index.js',
        }
      };
      
      const estimate = await sdk.lifecycle.estimateTypedOriginalCost(
        manifest,
        'did:webvh'
      );
      
      expect(estimate.totalSats).toBe(0);
      expect(estimate.targetLayer).toBe('did:webvh');
    });
  });
  
  describe('Integration with provenance', () => {
    it('should have proper provenance after creation', async () => {
      const manifest: AppManifest = {
        kind: OriginalKind.App,
        name: 'provenance-test',
        version: '1.0.0',
        resources: [
          createResource('index.js', 'console.log("test");', 'code', 'application/javascript'),
        ],
        metadata: {
          runtime: 'node',
          entrypoint: 'index.js',
        }
      };
      
      const asset = await sdk.lifecycle.createTypedOriginal(OriginalKind.App, manifest);
      const provenance = asset.getProvenance();
      
      expect(provenance.createdAt).toBeDefined();
      expect(provenance.creator).toBe(asset.id);
      expect(provenance.migrations).toEqual([]);
      expect(provenance.transfers).toEqual([]);
    });
  });
});

describe('KindRegistry integration', () => {
  it('should use KindRegistry for validation in createTypedOriginal', async () => {
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
    });
    
    const registry = KindRegistry.getInstance();
    
    // Validate directly with registry
    const manifest: AppManifest = {
      kind: OriginalKind.App,
      name: 'registry-test',
      version: '1.0.0',
      resources: [{
        id: 'index.js',
        type: 'code',
        contentType: 'application/javascript',
        hash: hashResource(Buffer.from('code')),
        content: 'code',
      }],
      metadata: {
        runtime: 'node',
        entrypoint: 'index.js',
      }
    };
    
    const registryResult = registry.validate(manifest);
    
    // If registry validation passes, createTypedOriginal should also work
    if (registryResult.isValid) {
      const asset = await sdk.lifecycle.createTypedOriginal(OriginalKind.App, manifest);
      expect(asset).toBeDefined();
    }
  });
});

