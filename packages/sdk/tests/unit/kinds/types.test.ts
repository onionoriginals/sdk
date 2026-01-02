/**
 * Tests for Kind types and interfaces
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
} from '../../../src/kinds';

describe('OriginalKind enum', () => {
  it('should have all expected kinds', () => {
    expect(OriginalKind.App).toBe('originals:kind:app');
    expect(OriginalKind.Agent).toBe('originals:kind:agent');
    expect(OriginalKind.Module).toBe('originals:kind:module');
    expect(OriginalKind.Dataset).toBe('originals:kind:dataset');
    expect(OriginalKind.Media).toBe('originals:kind:media');
    expect(OriginalKind.Document).toBe('originals:kind:document');
  });
  
  it('should have exactly 6 kinds', () => {
    const kindCount = Object.values(OriginalKind).length;
    expect(kindCount).toBe(6);
  });
  
  it('should follow originals:kind: prefix pattern', () => {
    for (const kind of Object.values(OriginalKind)) {
      expect(kind.startsWith('originals:kind:')).toBe(true);
    }
  });
});

describe('AppManifest type', () => {
  it('should allow valid app manifest', () => {
    const manifest: AppManifest = {
      kind: OriginalKind.App,
      name: 'MyApp',
      version: '1.0.0',
      resources: [{
        id: 'index.js',
        type: 'code',
        contentType: 'application/javascript',
        hash: 'abc123',
      }],
      metadata: {
        runtime: 'node',
        entrypoint: 'index.js',
      }
    };
    
    expect(manifest.kind).toBe(OriginalKind.App);
    expect(manifest.metadata.runtime).toBe('node');
    expect(manifest.metadata.entrypoint).toBe('index.js');
  });
  
  it('should allow all optional metadata fields', () => {
    const manifest: AppManifest = {
      kind: OriginalKind.App,
      name: 'FullApp',
      version: '2.0.0',
      description: 'A full-featured app',
      resources: [{
        id: 'main.js',
        type: 'code',
        contentType: 'application/javascript',
        hash: 'def456',
      }],
      dependencies: [{
        did: 'did:peer:123',
        version: '^1.0.0',
        name: 'dep-lib',
      }],
      tags: ['utility', 'cli'],
      author: {
        name: 'Test Author',
        did: 'did:peer:author',
      },
      license: 'MIT',
      metadata: {
        runtime: 'bun',
        entrypoint: 'main.js',
        runtimeVersion: '1.0.0',
        permissions: ['network', 'filesystem'],
        platforms: ['linux', 'darwin'],
        env: {
          PORT: { description: 'Server port', default: '3000' },
        },
        commands: {
          start: { description: 'Start the server' },
        },
      }
    };
    
    expect(manifest.metadata.platforms).toContain('linux');
    expect(manifest.metadata.permissions).toContain('network');
  });
});

describe('ModuleManifest type', () => {
  it('should allow valid module manifest', () => {
    const manifest: ModuleManifest = {
      kind: OriginalKind.Module,
      name: 'my-module',
      version: '1.0.0',
      resources: [{
        id: 'index.js',
        type: 'code',
        contentType: 'application/javascript',
        hash: 'abc123',
      }],
      metadata: {
        format: 'esm',
        main: 'index.js',
      }
    };
    
    expect(manifest.metadata.format).toBe('esm');
  });
  
  it('should allow conditional exports', () => {
    const manifest: ModuleManifest = {
      kind: OriginalKind.Module,
      name: 'dual-module',
      version: '1.0.0',
      resources: [{
        id: 'index.mjs',
        type: 'code',
        contentType: 'application/javascript',
        hash: 'abc',
      }],
      metadata: {
        format: 'esm',
        main: 'index.mjs',
        exports: {
          '.': {
            import: './index.mjs',
            require: './index.cjs',
            types: './index.d.ts',
          }
        }
      }
    };
    
    expect(manifest.metadata.exports?.['.']).toBeDefined();
  });
});

describe('DatasetManifest type', () => {
  it('should allow valid dataset manifest', () => {
    const manifest: DatasetManifest = {
      kind: OriginalKind.Dataset,
      name: 'training-data',
      version: '1.0.0',
      resources: [{
        id: 'data.csv',
        type: 'data',
        contentType: 'text/csv',
        hash: 'data123',
      }],
      metadata: {
        format: 'csv',
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            value: { type: 'number' },
          }
        }
      }
    };
    
    expect(manifest.metadata.format).toBe('csv');
    expect(typeof manifest.metadata.schema).toBe('object');
  });
  
  it('should allow columns definition', () => {
    const manifest: DatasetManifest = {
      kind: OriginalKind.Dataset,
      name: 'columnar-data',
      version: '1.0.0',
      resources: [{
        id: 'data.parquet',
        type: 'data',
        contentType: 'application/octet-stream',
        hash: 'parq123',
      }],
      metadata: {
        format: 'parquet',
        schema: {},
        recordCount: 1000000,
        columns: [
          { name: 'id', type: 'string', description: 'Unique identifier' },
          { name: 'value', type: 'float64', nullable: true },
        ],
        privacy: 'public',
        updateFrequency: 'daily',
      }
    };
    
    expect(manifest.metadata.columns?.length).toBe(2);
    expect(manifest.metadata.privacy).toBe('public');
  });
});

describe('AgentManifest type', () => {
  it('should allow valid agent manifest', () => {
    const manifest: AgentManifest = {
      kind: OriginalKind.Agent,
      name: 'my-agent',
      version: '1.0.0',
      resources: [{
        id: 'agent.json',
        type: 'config',
        contentType: 'application/json',
        hash: 'agent123',
      }],
      metadata: {
        capabilities: ['text-generation', 'code-completion'],
      }
    };
    
    expect(manifest.metadata.capabilities).toContain('text-generation');
  });
  
  it('should allow full model configuration', () => {
    const manifest: AgentManifest = {
      kind: OriginalKind.Agent,
      name: 'ai-assistant',
      version: '1.0.0',
      resources: [{
        id: 'config.json',
        type: 'config',
        contentType: 'application/json',
        hash: 'cfg123',
      }],
      metadata: {
        capabilities: ['chat', 'summarization'],
        model: {
          provider: 'anthropic',
          name: 'claude-3',
          version: 'sonnet',
          parameters: { temperature: 0.7 },
        },
        inputTypes: ['text', 'image'],
        outputTypes: ['text'],
        memory: {
          type: 'session',
          maxSize: 100000,
        },
        tools: [
          { name: 'search', description: 'Search the web' },
        ],
        rateLimit: {
          requestsPerMinute: 60,
          tokensPerMinute: 100000,
        },
      }
    };
    
    expect(manifest.metadata.model?.provider).toBe('anthropic');
    expect(manifest.metadata.memory?.type).toBe('session');
  });
});

describe('MediaManifest type', () => {
  it('should allow valid media manifest for images', () => {
    const manifest: MediaManifest = {
      kind: OriginalKind.Media,
      name: 'profile-image',
      version: '1.0.0',
      resources: [{
        id: 'image.png',
        type: 'image',
        contentType: 'image/png',
        hash: 'img123',
      }],
      metadata: {
        mediaType: 'image',
        mimeType: 'image/png',
        dimensions: {
          width: 1920,
          height: 1080,
          aspectRatio: '16:9',
        },
      }
    };
    
    expect(manifest.metadata.mediaType).toBe('image');
    expect(manifest.metadata.dimensions?.width).toBe(1920);
  });
  
  it('should allow video with full metadata', () => {
    const manifest: MediaManifest = {
      kind: OriginalKind.Media,
      name: 'tutorial-video',
      version: '1.0.0',
      resources: [{
        id: 'video.mp4',
        type: 'video',
        contentType: 'video/mp4',
        hash: 'vid123',
      }],
      metadata: {
        mediaType: 'video',
        mimeType: 'video/mp4',
        dimensions: {
          width: 1920,
          height: 1080,
        },
        duration: 300,
        frameRate: 30,
        audioChannels: 2,
        codec: 'h264',
        bitrate: 5000,
        thumbnail: 'thumb.jpg',
        altText: 'Tutorial on using the SDK',
      }
    };
    
    expect(manifest.metadata.duration).toBe(300);
    expect(manifest.metadata.frameRate).toBe(30);
  });
});

describe('DocumentManifest type', () => {
  it('should allow valid document manifest', () => {
    const manifest: DocumentManifest = {
      kind: OriginalKind.Document,
      name: 'readme',
      version: '1.0.0',
      resources: [{
        id: 'README.md',
        type: 'document',
        contentType: 'text/markdown',
        hash: 'doc123',
      }],
      metadata: {
        format: 'markdown',
        content: 'README.md',
      }
    };
    
    expect(manifest.metadata.format).toBe('markdown');
  });
  
  it('should allow full document metadata', () => {
    const manifest: DocumentManifest = {
      kind: OriginalKind.Document,
      name: 'whitepaper',
      version: '1.0.0',
      resources: [{
        id: 'paper.pdf',
        type: 'document',
        contentType: 'application/pdf',
        hash: 'pdf123',
      }],
      metadata: {
        format: 'pdf',
        content: 'paper.pdf',
        language: 'en',
        pageCount: 42,
        wordCount: 15000,
        readingTime: 60,
        keywords: ['blockchain', 'digital assets'],
        abstract: 'This paper describes...',
        toc: [
          { title: 'Introduction', level: 1, anchor: 'intro' },
          { title: 'Background', level: 1, anchor: 'bg' },
        ],
        references: [
          { id: 'ref1', title: 'Bitcoin Whitepaper', year: 2008 },
        ],
        status: 'published',
        revision: 3,
      }
    };
    
    expect(manifest.metadata.pageCount).toBe(42);
    expect(manifest.metadata.status).toBe('published');
  });
});

describe('Generic OriginalManifest', () => {
  it('should work with any kind', () => {
    function processManifest<K extends OriginalKind>(manifest: OriginalManifest<K>): string {
      return `Processing ${manifest.name} v${manifest.version} (${manifest.kind})`;
    }
    
    const appManifest: AppManifest = {
      kind: OriginalKind.App,
      name: 'test-app',
      version: '1.0.0',
      resources: [],
      metadata: { runtime: 'node', entrypoint: 'index.js' }
    };
    
    const result = processManifest(appManifest);
    expect(result).toContain('test-app');
    expect(result).toContain('1.0.0');
    expect(result).toContain('originals:kind:app');
  });
});

