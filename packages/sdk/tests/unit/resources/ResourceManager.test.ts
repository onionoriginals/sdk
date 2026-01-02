/**
 * Tests for ResourceManager - CRUD operations for immutable, versioned resources.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { ResourceManager } from '../../../src/resources/ResourceManager';
import type { Resource, ResourceValidationResult } from '../../../src/resources/types';
import { MIME_TYPE_MAP } from '../../../src/resources/types';

describe('ResourceManager', () => {
  let manager: ResourceManager;

  beforeEach(() => {
    manager = new ResourceManager();
  });

  describe('createResource', () => {
    it('should create a text resource from string content', () => {
      const content = 'Hello, World!';
      const resource = manager.createResource(content, {
        type: 'text',
        contentType: 'text/plain',
      });

      expect(resource).toBeDefined();
      expect(resource.id).toBeDefined();
      expect(resource.type).toBe('text');
      expect(resource.contentType).toBe('text/plain');
      expect(resource.hash).toBeDefined();
      expect(resource.hash).toHaveLength(64); // SHA-256 hex is 64 chars
      expect(resource.size).toBe(Buffer.from(content).length);
      expect(resource.version).toBe(1);
      expect(resource.previousVersionHash).toBeUndefined();
      expect(resource.createdAt).toBeDefined();
      expect(resource.content).toBe(content);
    });

    it('should create a binary resource from Buffer', () => {
      const content = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header bytes
      const resource = manager.createResource(content, {
        type: 'image',
        contentType: 'image/png',
      });

      expect(resource).toBeDefined();
      expect(resource.type).toBe('image');
      expect(resource.contentType).toBe('image/png');
      expect(resource.size).toBe(4);
      expect(resource.contentBase64).toBe(content.toString('base64'));
      expect(resource.content).toBeUndefined();
    });

    it('should use provided resource ID if given', () => {
      const customId = 'my-custom-id';
      const resource = manager.createResource('content', {
        id: customId,
        type: 'text',
        contentType: 'text/plain',
      });

      expect(resource.id).toBe(customId);
    });

    it('should store optional fields correctly', () => {
      const resource = manager.createResource('content', {
        type: 'text',
        contentType: 'text/plain',
        url: 'https://example.com/resource',
        description: 'A test resource',
      });

      expect(resource.url).toBe('https://example.com/resource');
      expect(resource.description).toBe('A test resource');
    });

    it('should throw error for null content', () => {
      expect(() => {
        manager.createResource(null as unknown as string, {
          type: 'text',
          contentType: 'text/plain',
        });
      }).toThrow('Content is required');
    });

    it('should throw error for missing options', () => {
      expect(() => {
        manager.createResource('content', null as unknown as any);
      }).toThrow('Options are required');
    });

    it('should throw error for missing type', () => {
      expect(() => {
        manager.createResource('content', {
          contentType: 'text/plain',
        } as any);
      }).toThrow('Resource type is required');
    });

    it('should throw error for missing contentType', () => {
      expect(() => {
        manager.createResource('content', {
          type: 'text',
        } as any);
      }).toThrow('Content type is required');
    });

    it('should throw error for invalid MIME type format', () => {
      expect(() => {
        manager.createResource('content', {
          type: 'text',
          contentType: 'invalid-mime',
        });
      }).toThrow('Invalid MIME type format');
    });

    it('should throw error when content exceeds size limit', () => {
      const largeContent = Buffer.alloc(11 * 1024 * 1024); // 11MB, exceeds 10MB default
      expect(() => {
        manager.createResource(largeContent, {
          type: 'binary',
          contentType: 'application/octet-stream',
        });
      }).toThrow(/exceeds maximum allowed size/);
    });

    it('should respect custom max size', () => {
      const content = Buffer.alloc(1000);
      expect(() => {
        manager.createResource(content, {
          type: 'binary',
          contentType: 'application/octet-stream',
          maxSize: 500,
        });
      }).toThrow(/exceeds maximum allowed size/);
    });
  });

  describe('updateResource', () => {
    it('should create a new version with incremented version number', () => {
      const v1 = manager.createResource('Version 1', {
        type: 'text',
        contentType: 'text/plain',
      });

      const v2 = manager.updateResource(v1, 'Version 2');

      expect(v2.version).toBe(2);
      expect(v2.previousVersionHash).toBe(v1.hash);
      expect(v2.hash).not.toBe(v1.hash);
      expect(v2.id).toBe(v1.id);
    });

    it('should accept resource ID string instead of resource object', () => {
      const v1 = manager.createResource('Version 1', {
        type: 'text',
        contentType: 'text/plain',
      });

      const v2 = manager.updateResource(v1.id, 'Version 2');

      expect(v2.version).toBe(2);
      expect(v2.id).toBe(v1.id);
    });

    it('should allow changing content type on update', () => {
      const v1 = manager.createResource('{"data": 1}', {
        type: 'data',
        contentType: 'text/plain',
      });

      const v2 = manager.updateResource(v1, '{"data": 2}', {
        contentType: 'application/json',
      });

      expect(v2.contentType).toBe('application/json');
    });

    it('should throw error if content is unchanged', () => {
      const v1 = manager.createResource('Same content', {
        type: 'text',
        contentType: 'text/plain',
      });

      expect(() => {
        manager.updateResource(v1, 'Same content');
      }).toThrow('Content unchanged');
    });

    it('should throw error for non-existent resource', () => {
      expect(() => {
        manager.updateResource('non-existent-id', 'new content');
      }).toThrow('Resource not found');
    });

    it('should throw error for invalid new content type', () => {
      const v1 = manager.createResource('content', {
        type: 'text',
        contentType: 'text/plain',
      });

      expect(() => {
        manager.updateResource(v1, 'new content', {
          contentType: 'invalid-mime',
        });
      }).toThrow('Invalid MIME type format');
    });

    it('should support multiple sequential updates', () => {
      const v1 = manager.createResource('v1', {
        type: 'text',
        contentType: 'text/plain',
      });
      const v2 = manager.updateResource(v1, 'v2');
      const v3 = manager.updateResource(v2, 'v3');
      const v4 = manager.updateResource(v3, 'v4');

      expect(v4.version).toBe(4);
      expect(v4.previousVersionHash).toBe(v3.hash);
    });
  });

  describe('getResourceHistory', () => {
    it('should return all versions in order', () => {
      const v1 = manager.createResource('v1', {
        type: 'text',
        contentType: 'text/plain',
      });
      manager.updateResource(v1, 'v2');
      manager.updateResource(v1.id, 'v3');

      const history = manager.getResourceHistory(v1.id);

      expect(history).toHaveLength(3);
      expect(history[0].version).toBe(1);
      expect(history[1].version).toBe(2);
      expect(history[2].version).toBe(3);
    });

    it('should return empty array for non-existent resource', () => {
      const history = manager.getResourceHistory('non-existent');
      expect(history).toHaveLength(0);
    });

    it('should return a copy (not allow mutation)', () => {
      const v1 = manager.createResource('content', {
        type: 'text',
        contentType: 'text/plain',
      });

      const history = manager.getResourceHistory(v1.id);
      history.push({} as Resource); // Try to mutate

      const history2 = manager.getResourceHistory(v1.id);
      expect(history2).toHaveLength(1); // Should still be 1
    });
  });

  describe('getResourceVersionHistory', () => {
    it('should return detailed version history', () => {
      const v1 = manager.createResource('v1', {
        type: 'text',
        contentType: 'text/plain',
      });
      manager.updateResource(v1, 'v2');

      const history = manager.getResourceVersionHistory(v1.id);

      expect(history).not.toBeNull();
      expect(history!.resourceId).toBe(v1.id);
      expect(history!.versions).toHaveLength(2);
      expect(history!.currentVersion.version).toBe(2);
      expect(history!.versionCount).toBe(2);
    });

    it('should return null for non-existent resource', () => {
      const history = manager.getResourceVersionHistory('non-existent');
      expect(history).toBeNull();
    });
  });

  describe('getResourceVersion', () => {
    it('should return specific version', () => {
      const v1 = manager.createResource('v1', {
        type: 'text',
        contentType: 'text/plain',
      });
      const v2 = manager.updateResource(v1, 'v2');

      const retrieved = manager.getResourceVersion(v1.id, 1);
      expect(retrieved?.hash).toBe(v1.hash);

      const retrieved2 = manager.getResourceVersion(v1.id, 2);
      expect(retrieved2?.hash).toBe(v2.hash);
    });

    it('should return null for invalid version number', () => {
      const v1 = manager.createResource('v1', {
        type: 'text',
        contentType: 'text/plain',
      });

      expect(manager.getResourceVersion(v1.id, 0)).toBeNull();
      expect(manager.getResourceVersion(v1.id, 5)).toBeNull();
    });
  });

  describe('getCurrentVersion', () => {
    it('should return latest version', () => {
      const v1 = manager.createResource('v1', {
        type: 'text',
        contentType: 'text/plain',
      });
      const v2 = manager.updateResource(v1, 'v2');
      manager.updateResource(v1.id, 'v3');

      const current = manager.getCurrentVersion(v1.id);
      expect(current?.version).toBe(3);
    });

    it('should return null for non-existent resource', () => {
      expect(manager.getCurrentVersion('non-existent')).toBeNull();
    });
  });

  describe('getResourceByHash', () => {
    it('should find resource by content hash', () => {
      const v1 = manager.createResource('v1', {
        type: 'text',
        contentType: 'text/plain',
      });
      const v2 = manager.updateResource(v1, 'v2');

      const found = manager.getResourceByHash(v1.hash);
      expect(found?.version).toBe(1);

      const found2 = manager.getResourceByHash(v2.hash);
      expect(found2?.version).toBe(2);
    });

    it('should return null for unknown hash', () => {
      manager.createResource('content', {
        type: 'text',
        contentType: 'text/plain',
      });

      const found = manager.getResourceByHash('0'.repeat(64));
      expect(found).toBeNull();
    });
  });

  describe('validateResource', () => {
    it('should validate a correct resource', () => {
      const resource = manager.createResource('content', {
        type: 'text',
        contentType: 'text/plain',
      });

      const result = manager.validateResource(resource);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing ID', () => {
      const resource = { type: 'text', contentType: 'text/plain', hash: '0'.repeat(64) } as Resource;
      const result = manager.validateResource(resource);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('ID'))).toBe(true);
    });

    it('should detect invalid hash format', () => {
      const resource = manager.createResource('content', {
        type: 'text',
        contentType: 'text/plain',
      });
      (resource as any).hash = 'invalid-hash';

      const result = manager.validateResource(resource);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('hash'))).toBe(true);
    });

    it('should detect content hash mismatch', () => {
      const resource = manager.createResource('content', {
        type: 'text',
        contentType: 'text/plain',
      });
      resource.content = 'different content';

      const result = manager.validateResource(resource);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('hash mismatch'))).toBe(true);
    });

    it('should warn about version 1 with previousVersionHash', () => {
      const resource = manager.createResource('content', {
        type: 'text',
        contentType: 'text/plain',
      });
      (resource as any).previousVersionHash = 'a'.repeat(64);

      const result = manager.validateResource(resource);

      expect(result.warnings.some(w => w.includes('previousVersionHash'))).toBe(true);
    });

    it('should error on version > 1 without previousVersionHash', () => {
      const resource = manager.createResource('content', {
        type: 'text',
        contentType: 'text/plain',
      });
      (resource as any).version = 2;
      delete (resource as any).previousVersionHash;

      const result = manager.validateResource(resource);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('previousVersionHash'))).toBe(true);
    });

    it('should handle null resource', () => {
      const result = manager.validateResource(null as unknown as Resource);
      expect(result.valid).toBe(false);
    });
  });

  describe('verifyVersionChain', () => {
    it('should verify valid version chain', () => {
      const v1 = manager.createResource('v1', {
        type: 'text',
        contentType: 'text/plain',
      });
      manager.updateResource(v1, 'v2');
      manager.updateResource(v1.id, 'v3');

      const result = manager.verifyVersionChain(v1.id);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect broken chain', () => {
      const v1 = manager.createResource('v1', {
        type: 'text',
        contentType: 'text/plain',
      });
      const v2 = manager.updateResource(v1, 'v2');
      
      // Manually corrupt the chain
      (v2 as any).previousVersionHash = 'wrong-hash';

      const result = manager.verifyVersionChain(v1.id);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('mismatch'))).toBe(true);
    });

    it('should return error for non-existent resource', () => {
      const result = manager.verifyVersionChain('non-existent');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Resource not found');
    });
  });

  describe('hashContent', () => {
    it('should produce consistent hashes for same content', () => {
      const content = 'Hello, World!';
      const hash1 = manager.hashContent(content);
      const hash2 = manager.hashContent(content);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different content', () => {
      const hash1 = manager.hashContent('content1');
      const hash2 = manager.hashContent('content2');

      expect(hash1).not.toBe(hash2);
    });

    it('should handle Buffer input', () => {
      const content = Buffer.from('test');
      const hash = manager.hashContent(content);

      expect(hash).toHaveLength(64);
    });

    it('should produce same hash for string and equivalent Buffer', () => {
      const stringContent = 'test';
      const bufferContent = Buffer.from(stringContent);

      const hash1 = manager.hashContent(stringContent);
      const hash2 = manager.hashContent(bufferContent);

      expect(hash1).toBe(hash2);
    });
  });

  describe('deleteResource', () => {
    it('should delete resource and all versions', () => {
      const v1 = manager.createResource('v1', {
        type: 'text',
        contentType: 'text/plain',
      });
      manager.updateResource(v1, 'v2');

      const deleted = manager.deleteResource(v1.id);

      expect(deleted).toBe(true);
      expect(manager.getResourceHistory(v1.id)).toHaveLength(0);
    });

    it('should return false for non-existent resource', () => {
      const deleted = manager.deleteResource('non-existent');
      expect(deleted).toBe(false);
    });
  });

  describe('listResourceIds', () => {
    it('should list all resource IDs', () => {
      const r1 = manager.createResource('content1', {
        type: 'text',
        contentType: 'text/plain',
      });
      const r2 = manager.createResource('content2', {
        type: 'text',
        contentType: 'text/plain',
      });

      const ids = manager.listResourceIds();

      expect(ids).toContain(r1.id);
      expect(ids).toContain(r2.id);
      expect(ids).toHaveLength(2);
    });
  });

  describe('getResourceCount and getTotalVersionCount', () => {
    it('should count resources and versions correctly', () => {
      const r1 = manager.createResource('content1', {
        type: 'text',
        contentType: 'text/plain',
      });
      manager.updateResource(r1, 'content1-v2');
      manager.updateResource(r1.id, 'content1-v3');

      manager.createResource('content2', {
        type: 'text',
        contentType: 'text/plain',
      });

      expect(manager.getResourceCount()).toBe(2);
      expect(manager.getTotalVersionCount()).toBe(4); // 3 + 1
    });
  });

  describe('importResource', () => {
    it('should import an existing resource', () => {
      const resource: Resource = {
        id: 'imported-resource',
        type: 'text',
        contentType: 'text/plain',
        hash: manager.hashContent('test content'),
        size: 12,
        version: 1,
        content: 'test content',
        createdAt: new Date().toISOString(),
      };

      const imported = manager.importResource(resource);

      expect(imported.id).toBe('imported-resource');
      expect(manager.getCurrentVersion('imported-resource')).toBeDefined();
    });

    it('should not duplicate existing version', () => {
      const resource = manager.createResource('content', {
        id: 'test-id',
        type: 'text',
        contentType: 'text/plain',
      });

      // Try to import same resource again
      manager.importResource(resource);

      expect(manager.getResourceHistory('test-id')).toHaveLength(1);
    });

    it('should maintain version order when importing', () => {
      const v1: Resource = {
        id: 'test',
        type: 'text',
        contentType: 'text/plain',
        hash: manager.hashContent('v1'),
        size: 2,
        version: 1,
        createdAt: new Date().toISOString(),
      };
      const v2: Resource = {
        id: 'test',
        type: 'text',
        contentType: 'text/plain',
        hash: manager.hashContent('v2'),
        size: 2,
        version: 2,
        previousVersionHash: v1.hash,
        createdAt: new Date().toISOString(),
      };

      // Import out of order
      manager.importResource(v2);
      manager.importResource(v1);

      const history = manager.getResourceHistory('test');
      expect(history[0].version).toBe(1);
      expect(history[1].version).toBe(2);
    });
  });

  describe('exportResources', () => {
    it('should export all resources', () => {
      const r1 = manager.createResource('content1', {
        type: 'text',
        contentType: 'text/plain',
      });
      manager.updateResource(r1, 'content1-v2');
      manager.createResource('content2', {
        type: 'text',
        contentType: 'text/plain',
      });

      const exported = manager.exportResources();

      expect(exported).toHaveLength(3);
    });
  });

  describe('clear', () => {
    it('should remove all resources', () => {
      manager.createResource('content1', {
        type: 'text',
        contentType: 'text/plain',
      });
      manager.createResource('content2', {
        type: 'text',
        contentType: 'text/plain',
      });

      manager.clear();

      expect(manager.getResourceCount()).toBe(0);
    });
  });

  describe('inferResourceType', () => {
    it('should infer type from common MIME types', () => {
      expect(ResourceManager.inferResourceType('image/png')).toBe('image');
      expect(ResourceManager.inferResourceType('text/plain')).toBe('text');
      expect(ResourceManager.inferResourceType('application/json')).toBe('data');
      expect(ResourceManager.inferResourceType('application/javascript')).toBe('code');
      expect(ResourceManager.inferResourceType('audio/mpeg')).toBe('audio');
      expect(ResourceManager.inferResourceType('video/mp4')).toBe('video');
      expect(ResourceManager.inferResourceType('application/pdf')).toBe('document');
    });

    it('should fallback to prefix-based inference', () => {
      expect(ResourceManager.inferResourceType('image/x-custom')).toBe('image');
      expect(ResourceManager.inferResourceType('audio/x-custom')).toBe('audio');
      expect(ResourceManager.inferResourceType('video/x-custom')).toBe('video');
    });

    it('should return other for unknown types', () => {
      expect(ResourceManager.inferResourceType('application/x-custom')).toBe('other');
    });
  });

  describe('configuration', () => {
    it('should respect allowedContentTypes config', () => {
      const restrictedManager = new ResourceManager({
        allowedContentTypes: ['text/plain', 'application/json'],
      });

      // Should work
      const resource = restrictedManager.createResource('content', {
        type: 'text',
        contentType: 'text/plain',
      });
      expect(resource).toBeDefined();

      // Should fail
      expect(() => {
        restrictedManager.createResource('content', {
          type: 'image',
          contentType: 'image/png',
        });
      }).toThrow('Content type not allowed');
    });

    it('should respect storeContent config', () => {
      const noStoreManager = new ResourceManager({
        storeContent: false,
      });

      const resource = noStoreManager.createResource('content', {
        type: 'text',
        contentType: 'text/plain',
      });

      expect(resource.content).toBeUndefined();
      expect(resource.contentBase64).toBeUndefined();
    });

    it('should respect custom defaultMaxSize', () => {
      const smallManager = new ResourceManager({
        defaultMaxSize: 100,
      });

      const largeContent = 'x'.repeat(200);
      expect(() => {
        smallManager.createResource(largeContent, {
          type: 'text',
          contentType: 'text/plain',
        });
      }).toThrow(/exceeds maximum allowed size/);
    });
  });

  describe('MIME_TYPE_MAP', () => {
    it('should have mappings for common types', () => {
      expect(MIME_TYPE_MAP['image/png']).toBe('image');
      expect(MIME_TYPE_MAP['text/plain']).toBe('text');
      expect(MIME_TYPE_MAP['application/json']).toBe('data');
      expect(MIME_TYPE_MAP['application/javascript']).toBe('code');
    });
  });
});

