/**
 * Tests for Kind validators
 */

import { describe, expect, it } from 'bun:test';
import { 
  OriginalKind,
  type OriginalManifest,
  type AppManifest,
  type ModuleManifest,
  type DatasetManifest,
  type AgentManifest,
  type MediaManifest,
  type DocumentManifest,
  AppValidator,
  ModuleValidator,
  DatasetValidator,
  AgentValidator,
  MediaValidator,
  DocumentValidator,
  ValidationUtils,
} from '../../../src/kinds';

// Helper to create a minimal valid resource
const createResource = (id: string, type = 'code', contentType = 'application/javascript') => ({
  id,
  type,
  contentType,
  hash: 'abcdef1234567890',
});

describe('ValidationUtils', () => {
  describe('isValidSemver', () => {
    it('should accept valid semver versions', () => {
      expect(ValidationUtils.isValidSemver('1.0.0')).toBe(true);
      expect(ValidationUtils.isValidSemver('0.0.1')).toBe(true);
      expect(ValidationUtils.isValidSemver('10.20.30')).toBe(true);
      expect(ValidationUtils.isValidSemver('1.0.0-alpha')).toBe(true);
      expect(ValidationUtils.isValidSemver('1.0.0-beta.1')).toBe(true);
      expect(ValidationUtils.isValidSemver('1.0.0+build.123')).toBe(true);
    });
    
    it('should reject invalid semver versions', () => {
      expect(ValidationUtils.isValidSemver('1.0')).toBe(false);
      expect(ValidationUtils.isValidSemver('1')).toBe(false);
      expect(ValidationUtils.isValidSemver('v1.0.0')).toBe(false);
      expect(ValidationUtils.isValidSemver('1.0.0.0')).toBe(false);
      expect(ValidationUtils.isValidSemver('invalid')).toBe(false);
    });
  });
  
  describe('isValidDID', () => {
    it('should accept valid DIDs', () => {
      expect(ValidationUtils.isValidDID('did:peer:123abc')).toBe(true);
      expect(ValidationUtils.isValidDID('did:webvh:example.com:user')).toBe(true);
      expect(ValidationUtils.isValidDID('did:btco:12345')).toBe(true);
    });
    
    it('should reject invalid DIDs', () => {
      expect(ValidationUtils.isValidDID('not-a-did')).toBe(false);
      expect(ValidationUtils.isValidDID('did:')).toBe(false);
      expect(ValidationUtils.isValidDID('did:method:')).toBe(false);
    });
  });
  
  describe('isValidMimeType', () => {
    it('should accept valid MIME types', () => {
      expect(ValidationUtils.isValidMimeType('application/json')).toBe(true);
      expect(ValidationUtils.isValidMimeType('text/plain')).toBe(true);
      expect(ValidationUtils.isValidMimeType('image/png')).toBe(true);
      expect(ValidationUtils.isValidMimeType('application/octet-stream')).toBe(true);
    });
    
    it('should reject invalid MIME types', () => {
      expect(ValidationUtils.isValidMimeType('json')).toBe(false);
      expect(ValidationUtils.isValidMimeType('application')).toBe(false);
      expect(ValidationUtils.isValidMimeType('/json')).toBe(false);
    });
  });
  
  describe('merge', () => {
    it('should merge validation results', () => {
      const result1 = ValidationUtils.failure([ValidationUtils.error('E1', 'Error 1')]);
      const result2 = ValidationUtils.success([ValidationUtils.warning('W1', 'Warning 1')]);
      
      const merged = ValidationUtils.merge(result1, result2);
      
      expect(merged.isValid).toBe(false);
      expect(merged.errors.length).toBe(1);
      expect(merged.warnings.length).toBe(1);
    });
  });
});

describe('AppValidator', () => {
  const validator = new AppValidator();
  
  it('should validate a minimal valid app manifest', () => {
    const manifest: AppManifest = {
      kind: OriginalKind.App,
      name: 'my-app',
      version: '1.0.0',
      resources: [createResource('index.js')],
      metadata: {
        runtime: 'node',
        entrypoint: 'index.js',
      }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(true);
    expect(result.errors.length).toBe(0);
  });
  
  it('should fail when runtime is missing', () => {
    const manifest = {
      kind: OriginalKind.App,
      name: 'my-app',
      version: '1.0.0',
      resources: [createResource('index.js')],
      metadata: {
        entrypoint: 'index.js',
      } as any
    } as AppManifest;
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'MISSING_RUNTIME')).toBe(true);
  });
  
  it('should fail when entrypoint is missing', () => {
    const manifest = {
      kind: OriginalKind.App,
      name: 'my-app',
      version: '1.0.0',
      resources: [createResource('index.js')],
      metadata: {
        runtime: 'node',
      } as any
    } as AppManifest;
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'MISSING_ENTRYPOINT')).toBe(true);
  });
  
  it('should warn for unknown runtime', () => {
    const manifest: AppManifest = {
      kind: OriginalKind.App,
      name: 'my-app',
      version: '1.0.0',
      resources: [createResource('index.js')],
      metadata: {
        runtime: 'exotic-runtime',
        entrypoint: 'index.js',
      }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(true);
    expect(result.warnings.some(w => w.code === 'UNKNOWN_RUNTIME')).toBe(true);
  });
  
  it('should validate platforms array', () => {
    const manifest: AppManifest = {
      kind: OriginalKind.App,
      name: 'my-app',
      version: '1.0.0',
      resources: [createResource('index.js')],
      metadata: {
        runtime: 'node',
        entrypoint: 'index.js',
        platforms: ['linux', 'darwin', 'invalid' as any],
      }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'INVALID_PLATFORM')).toBe(true);
  });
});

describe('ModuleValidator', () => {
  const validator = new ModuleValidator();
  
  it('should validate a minimal valid module manifest', () => {
    const manifest: ModuleManifest = {
      kind: OriginalKind.Module,
      name: 'my-module',
      version: '1.0.0',
      resources: [createResource('index.js')],
      metadata: {
        format: 'esm',
        main: 'index.js',
      }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(true);
  });
  
  it('should fail for invalid module format', () => {
    const manifest = {
      kind: OriginalKind.Module,
      name: 'my-module',
      version: '1.0.0',
      resources: [createResource('index.js')],
      metadata: {
        format: 'invalid' as any,
        main: 'index.js',
      }
    } as ModuleManifest;
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'INVALID_FORMAT')).toBe(true);
  });
  
  it('should fail when main is missing', () => {
    const manifest = {
      kind: OriginalKind.Module,
      name: 'my-module',
      version: '1.0.0',
      resources: [createResource('index.js')],
      metadata: {
        format: 'esm',
      } as any
    } as ModuleManifest;
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'MISSING_MAIN')).toBe(true);
  });
  
  it('should warn when types are missing', () => {
    const manifest: ModuleManifest = {
      kind: OriginalKind.Module,
      name: 'my-module',
      version: '1.0.0',
      resources: [createResource('index.js')],
      metadata: {
        format: 'esm',
        main: 'index.js',
      }
    };
    
    const result = validator.validate(manifest);
    expect(result.warnings.some(w => w.code === 'MISSING_TYPES')).toBe(true);
  });
});

describe('DatasetValidator', () => {
  const validator = new DatasetValidator();
  
  it('should validate a minimal valid dataset manifest', () => {
    const manifest: DatasetManifest = {
      kind: OriginalKind.Dataset,
      name: 'my-dataset',
      version: '1.0.0',
      resources: [createResource('data.json', 'data', 'application/json')],
      metadata: {
        format: 'json',
        schema: { type: 'object' },
      }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(true);
  });
  
  it('should fail when schema is missing', () => {
    const manifest = {
      kind: OriginalKind.Dataset,
      name: 'my-dataset',
      version: '1.0.0',
      resources: [createResource('data.json', 'data', 'application/json')],
      metadata: {
        format: 'json',
      } as any
    } as DatasetManifest;
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'MISSING_SCHEMA')).toBe(true);
  });
  
  it('should validate columns uniqueness', () => {
    const manifest: DatasetManifest = {
      kind: OriginalKind.Dataset,
      name: 'my-dataset',
      version: '1.0.0',
      resources: [createResource('data.csv', 'data', 'text/csv')],
      metadata: {
        format: 'csv',
        schema: {},
        columns: [
          { name: 'id', type: 'string' },
          { name: 'id', type: 'string' }, // duplicate
        ]
      }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'DUPLICATE_COLUMN')).toBe(true);
  });
  
  it('should validate privacy enum', () => {
    const manifest: DatasetManifest = {
      kind: OriginalKind.Dataset,
      name: 'my-dataset',
      version: '1.0.0',
      resources: [createResource('data.json', 'data', 'application/json')],
      metadata: {
        format: 'json',
        schema: {},
        privacy: 'invalid' as any,
      }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'INVALID_PRIVACY')).toBe(true);
  });
});

describe('AgentValidator', () => {
  const validator = new AgentValidator();
  
  it('should validate a minimal valid agent manifest', () => {
    const manifest: AgentManifest = {
      kind: OriginalKind.Agent,
      name: 'my-agent',
      version: '1.0.0',
      resources: [createResource('config.json', 'config', 'application/json')],
      metadata: {
        capabilities: ['text-generation'],
      }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(true);
  });
  
  it('should fail when capabilities is empty', () => {
    const manifest: AgentManifest = {
      kind: OriginalKind.Agent,
      name: 'my-agent',
      version: '1.0.0',
      resources: [createResource('config.json', 'config', 'application/json')],
      metadata: {
        capabilities: [],
      }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'EMPTY_CAPABILITIES')).toBe(true);
  });
  
  it('should validate memory type', () => {
    const manifest: AgentManifest = {
      kind: OriginalKind.Agent,
      name: 'my-agent',
      version: '1.0.0',
      resources: [createResource('config.json', 'config', 'application/json')],
      metadata: {
        capabilities: ['chat'],
        memory: {
          type: 'invalid' as any,
        }
      }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'INVALID_MEMORY_TYPE')).toBe(true);
  });
  
  it('should validate tools structure', () => {
    const manifest: AgentManifest = {
      kind: OriginalKind.Agent,
      name: 'my-agent',
      version: '1.0.0',
      resources: [createResource('config.json', 'config', 'application/json')],
      metadata: {
        capabilities: ['function-calling'],
        tools: [
          { name: 'search', description: 'Search the web' },
          { name: '', description: 'Invalid tool' }, // missing name
        ]
      }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'MISSING_TOOL_NAME')).toBe(true);
  });
});

describe('MediaValidator', () => {
  const validator = new MediaValidator();
  
  it('should validate a minimal valid image manifest', () => {
    const manifest: MediaManifest = {
      kind: OriginalKind.Media,
      name: 'my-image',
      version: '1.0.0',
      resources: [createResource('image.png', 'image', 'image/png')],
      metadata: {
        mediaType: 'image',
        mimeType: 'image/png',
      }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(true);
  });
  
  it('should fail for invalid media type', () => {
    const manifest: MediaManifest = {
      kind: OriginalKind.Media,
      name: 'my-media',
      version: '1.0.0',
      resources: [createResource('file.bin', 'data', 'application/octet-stream')],
      metadata: {
        mediaType: 'invalid' as any,
        mimeType: 'application/octet-stream',
      }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'INVALID_MEDIA_TYPE')).toBe(true);
  });
  
  it('should validate dimensions for images', () => {
    const manifest: MediaManifest = {
      kind: OriginalKind.Media,
      name: 'my-image',
      version: '1.0.0',
      resources: [createResource('image.png', 'image', 'image/png')],
      metadata: {
        mediaType: 'image',
        mimeType: 'image/png',
        dimensions: {
          width: -100, // invalid
          height: 100,
        }
      }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'INVALID_WIDTH')).toBe(true);
  });
  
  it('should warn for missing alt text on images', () => {
    const manifest: MediaManifest = {
      kind: OriginalKind.Media,
      name: 'my-image',
      version: '1.0.0',
      resources: [createResource('image.png', 'image', 'image/png')],
      metadata: {
        mediaType: 'image',
        mimeType: 'image/png',
      }
    };
    
    const result = validator.validate(manifest);
    expect(result.warnings.some(w => w.code === 'MISSING_ALT_TEXT')).toBe(true);
  });
});

describe('DocumentValidator', () => {
  const validator = new DocumentValidator();
  
  it('should validate a minimal valid document manifest', () => {
    const manifest: DocumentManifest = {
      kind: OriginalKind.Document,
      name: 'my-doc',
      version: '1.0.0',
      resources: [createResource('readme.md', 'document', 'text/markdown')],
      metadata: {
        format: 'markdown',
        content: 'readme.md',
      }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(true);
  });
  
  it('should fail for invalid format', () => {
    const manifest: DocumentManifest = {
      kind: OriginalKind.Document,
      name: 'my-doc',
      version: '1.0.0',
      resources: [createResource('doc.xyz', 'document', 'text/plain')],
      metadata: {
        format: 'invalid' as any,
        content: 'doc.xyz',
      }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'INVALID_FORMAT')).toBe(true);
  });
  
  it('should validate TOC structure', () => {
    const manifest: DocumentManifest = {
      kind: OriginalKind.Document,
      name: 'my-doc',
      version: '1.0.0',
      resources: [createResource('doc.md', 'document', 'text/markdown')],
      metadata: {
        format: 'markdown',
        content: 'doc.md',
        toc: [
          { title: 'Intro', level: 1 },
          { title: '', level: 0 }, // invalid
        ]
      }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'MISSING_TOC_TITLE')).toBe(true);
    expect(result.errors.some(e => e.code === 'INVALID_TOC_LEVEL')).toBe(true);
  });
  
  it('should validate references uniqueness', () => {
    const manifest: DocumentManifest = {
      kind: OriginalKind.Document,
      name: 'my-doc',
      version: '1.0.0',
      resources: [createResource('paper.pdf', 'document', 'application/pdf')],
      metadata: {
        format: 'pdf',
        content: 'paper.pdf',
        references: [
          { id: 'ref1', title: 'Reference 1' },
          { id: 'ref1', title: 'Duplicate ref' }, // duplicate
        ]
      }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'DUPLICATE_REFERENCE_ID')).toBe(true);
  });
  
  it('should validate document status', () => {
    const manifest: DocumentManifest = {
      kind: OriginalKind.Document,
      name: 'my-doc',
      version: '1.0.0',
      resources: [createResource('doc.md', 'document', 'text/markdown')],
      metadata: {
        format: 'markdown',
        content: 'doc.md',
        status: 'invalid' as any,
      }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'INVALID_STATUS')).toBe(true);
  });
});

describe('Base validation', () => {
  const validator = new AppValidator(); // Using App as representative
  
  it('should fail when name is missing', () => {
    const manifest = {
      kind: OriginalKind.App,
      version: '1.0.0',
      resources: [createResource('index.js')],
      metadata: { runtime: 'node', entrypoint: 'index.js' }
    } as any;
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'MISSING_NAME')).toBe(true);
  });
  
  it('should fail for invalid version', () => {
    const manifest = {
      kind: OriginalKind.App,
      name: 'my-app',
      version: 'not-semver',
      resources: [createResource('index.js')],
      metadata: { runtime: 'node', entrypoint: 'index.js' }
    } as AppManifest;
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'INVALID_VERSION')).toBe(true);
  });
  
  it('should fail when resources is empty', () => {
    const manifest: AppManifest = {
      kind: OriginalKind.App,
      name: 'my-app',
      version: '1.0.0',
      resources: [],
      metadata: { runtime: 'node', entrypoint: 'index.js' }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'EMPTY_RESOURCES')).toBe(true);
  });
  
  it('should fail for duplicate resource IDs', () => {
    const manifest: AppManifest = {
      kind: OriginalKind.App,
      name: 'my-app',
      version: '1.0.0',
      resources: [
        createResource('index.js'),
        createResource('index.js'), // duplicate
      ],
      metadata: { runtime: 'node', entrypoint: 'index.js' }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'DUPLICATE_RESOURCE_IDS')).toBe(true);
  });
  
  it('should validate dependency DIDs', () => {
    const manifest: AppManifest = {
      kind: OriginalKind.App,
      name: 'my-app',
      version: '1.0.0',
      resources: [createResource('index.js')],
      dependencies: [
        { did: 'not-a-did' },
      ],
      metadata: { runtime: 'node', entrypoint: 'index.js' }
    };
    
    const result = validator.validate(manifest);
    expect(result.isValid).toBe(false);
    expect(result.errors.some(e => e.code === 'INVALID_DEPENDENCY_DID')).toBe(true);
  });
});

