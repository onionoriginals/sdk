import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import express from 'express';
import { registerRoutes } from '../routes';
import { storage } from '../storage';
import { originalsSdk } from '../originals';
import FormData from 'form-data';
import { Readable } from 'stream';
import type { Server } from 'http';

// Helper to create test auth token and user
async function createTestUser() {
  const testUserId = `did:webvh:localhost%3A5000:testuser-${Date.now()}`;
  
  // Create test user with DID
  const user = await storage.createUserWithDid(
    `privy-test-${Date.now()}`,
    testUserId,
    {
      didDocument: {
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: testUserId,
      },
      didLog: [],
      didSlug: `testuser-${Date.now()}`,
      authWalletId: 'test-wallet-auth',
      assertionWalletId: 'test-wallet-assertion',
      updateWalletId: 'test-wallet-update',
      authKeyPublic: 'test-auth-key',
      assertionKeyPublic: 'test-assertion-key',
      updateKeyPublic: 'test-update-key',
      didCreatedAt: new Date(),
    }
  );
  
  return user;
}

// Helper to create mock auth token
function createMockAuthHeader(userId: string): string {
  // In real tests, you'd create a valid JWT token
  // For now, we'll mock the Privy client verification
  return `Bearer mock-token-${userId}`;
}

// Helper to make authenticated requests against the test server
async function makeAuthRequest(
  serverUrl: string,
  method: string,
  path: string,
  userId: string,
  body?: any,
  formData?: FormData
): Promise<any> {
  const authHeader = createMockAuthHeader(userId);
  
  const headers: Record<string, string> = {
    'Authorization': authHeader,
  };
  
  if (formData) {
    headers['Content-Type'] = `multipart/form-data; boundary=${(formData as any)._boundary}`;
  } else if (body) {
    headers['Content-Type'] = 'application/json';
  }
  
  const url = `${serverUrl}${path}`;
  const options: RequestInit = {
    method,
    headers,
    body: formData ? Readable.from(formData.getBuffer()) : (body ? JSON.stringify(body) : undefined),
  };
  
  return fetch(url, options);
}

// Mock Privy module before importing routes
const mockVerifyAuthToken = mock(async (token: string) => {
  const userId = token.replace('Bearer ', '').replace('mock-token-', '');
  return { user_id: `privy-${userId}` };
});

mock.module('@privy-io/node', () => ({
  PrivyClient: class MockPrivyClient {
    utils() {
      return {
        auth: () => ({
          verifyAuthToken: mockVerifyAuthToken,
        }),
      };
    }
    users() {
      return {
        _get: async (userId: string) => ({
          id: userId,
          linked_accounts: [],
        }),
      };
    }
    wallets() {
      return {
        create: async () => ({ id: 'test-wallet' }),
      };
    }
  },
}));

describe('POST /api/assets/create-with-did', () => {
  let app: express.Application;
  let server: Server;
  let serverUrl: string;
  let testUser: any;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    // Setup Express app
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    
    // Mock global fetch for mediaUrl tests
    globalThis.fetch = mock(async (url: string, options?: any) => {
      // Mock fetches for URL-based asset creation
      if (url === 'https://example.com/image.png') {
        return {
          ok: true,
          status: 200,
          headers: {
            get: (name: string) => {
              if (name === 'content-type') return 'image/png';
              if (name === 'content-length') return '1024';
              return null;
            },
          },
          body: {
            getReader: () => {
              let sent = false;
              return {
                read: async () => {
                  if (sent) return { done: true, value: undefined };
                  sent = true;
                  return { done: false, value: new Uint8Array(Buffer.from('fake-image-data')) };
                },
                releaseLock: () => {},
                cancel: () => {},
              };
            },
          },
        } as any;
      }
      
      // For localhost/private IP tests, return error (shouldn't be called due to validation)
      if (url.includes('localhost') || url.includes('192.168') || url.includes('10.')) {
        throw new Error('Fetch to unsafe URL should be blocked by validation');
      }
      
      // Default: unmocked fetch
      return originalFetch(url, options);
    }) as any;
    
    // Register routes
    server = await registerRoutes(app);
    
    // Start server on random port
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 5000;
        serverUrl = `http://localhost:${port}`;
        resolve();
      });
    });
    
    // Create test user
    testUser = await createTestUser();
  });

  afterEach(async () => {
    // Restore fetch
    globalThis.fetch = originalFetch;
    
    // Stop server
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  it('should create asset with file upload', async () => {
    const formData = new FormData();
    formData.append('title', 'Test Asset');
    formData.append('description', 'Test description');
    formData.append('category', 'art');
    formData.append('mediaFile', Buffer.from('fake-image-data'), {
      filename: 'test.png',
      contentType: 'image/png',
    });

    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      '/api/assets/create-with-did',
      testUser.id,
      undefined,
      formData
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    
    expect(body.asset).toBeDefined();
    expect(body.asset.didPeer).toMatch(/^did:peer:/);
    expect(body.asset.currentLayer).toBe('did:peer');
    expect(body.asset.didDocument).toBeDefined();
    expect(body.asset.credentials).toBeDefined();
    expect(body.asset.provenance).toBeDefined();
    expect(body.originalsAsset).toBeDefined();
  });

  it('should create asset with media URL', async () => {
    const assetData = {
      title: 'URL Asset',
      description: 'From URL',
      category: 'art',
      mediaUrl: 'https://example.com/image.png',
    };

    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      '/api/assets/create-with-did',
      testUser.id,
      assetData
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    
    expect(body.asset.didPeer).toMatch(/^did:peer:/);
    expect(body.asset.currentLayer).toBe('did:peer');
  });

  it('should reject request without media', async () => {
    const assetData = {
      title: 'No Media Asset',
      description: 'Missing media',
      category: 'art',
    };

    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      '/api/assets/create-with-did',
      testUser.id,
      assetData
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('media');
  });

  it('should reject request without title', async () => {
    const assetData = {
      description: 'No title',
      category: 'art',
      mediaUrl: 'https://example.com/image.png',
    };

    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      '/api/assets/create-with-did',
      testUser.id,
      assetData
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Title');
  });

  it('should reject invalid file type', async () => {
    const formData = new FormData();
    formData.append('title', 'Bad File');
    formData.append('category', 'art');
    formData.append('mediaFile', Buffer.from('text content'), {
      filename: 'test.txt',
      contentType: 'text/plain',
    });

    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      '/api/assets/create-with-did',
      testUser.id,
      undefined,
      formData
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('file type');
  });

  it('should reject file too large', async () => {
    const largeBuffer = Buffer.alloc(11 * 1024 * 1024); // 11MB
    
    const formData = new FormData();
    formData.append('title', 'Large File');
    formData.append('category', 'art');
    formData.append('mediaFile', largeBuffer, {
      filename: 'large.png',
      contentType: 'image/png',
    });

    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      '/api/assets/create-with-did',
      testUser.id,
      undefined,
      formData
    );

    expect(response.status).toBe(413);
  });

  it('should reject unauthenticated request', async () => {
    const assetData = {
      title: 'Test',
      category: 'art',
      mediaUrl: 'https://example.com/image.png',
    };

    // Make request without auth header
    const response = await fetch('http://localhost:5000/api/assets/create-with-did', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(assetData),
    });

    expect(response.status).toBe(401);
  });

  it('should store correct layer tracking fields', async () => {
    const formData = new FormData();
    formData.append('title', 'Layer Test');
    formData.append('category', 'art');
    formData.append('mediaFile', Buffer.from('data'), {
      filename: 'test.png',
      contentType: 'image/png',
    });

    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      '/api/assets/create-with-did',
      testUser.id,
      undefined,
      formData
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    
    const assetId = body.asset.id;
    const stored = await storage.getAsset(assetId);

    expect(stored?.currentLayer).toBe('did:peer');
    expect(stored?.didPeer).toBeTruthy();
    expect(stored?.didWebvh).toBeNull();
    expect(stored?.didBtco).toBeNull();
    expect(stored?.didDocument).toBeDefined();
    expect(stored?.provenance).toBeDefined();
  });

  it('should generate valid provenance chain', async () => {
    const formData = new FormData();
    formData.append('title', 'Provenance Test');
    formData.append('category', 'art');
    formData.append('mediaFile', Buffer.from('data'), {
      filename: 'test.png',
      contentType: 'image/png',
    });

    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      '/api/assets/create-with-did',
      testUser.id,
      undefined,
      formData
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    
    const provenance = body.asset.provenance;
    expect(provenance).toBeDefined();
    expect(provenance.creator).toBeDefined();
    expect(provenance.createdAt).toBeDefined();
    expect(provenance.migrations).toBeDefined();
    expect(Array.isArray(provenance.migrations)).toBe(true);
  });

  it('should handle SDK errors gracefully', async () => {
    // Mock SDK to throw error
    const originalCreateAsset = originalsSdk.lifecycle.createAsset;
    try {
      originalsSdk.lifecycle.createAsset = mock(async () => {
        throw new Error('SDK Error');
      });

      const formData = new FormData();
      formData.append('title', 'Error Test');
      formData.append('category', 'art');
      formData.append('mediaFile', Buffer.from('data'), {
        filename: 'test.png',
        contentType: 'image/png',
      });

      const response = await makeAuthRequest(
        app,
        'POST',
        '/api/assets/create-with-did',
        testUser.id,
        undefined,
        formData
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toContain('SDK');
    } finally {
      // Restore original function
      originalsSdk.lifecycle.createAsset = originalCreateAsset;
    }
  });

  it('should parse tags correctly', async () => {
    const assetData = {
      title: 'Tagged Asset',
      description: 'With tags',
      category: 'art',
      tags: JSON.stringify(['tag1', 'tag2', 'tag3']),
      mediaUrl: 'https://example.com/image.png',
    };

    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      '/api/assets/create-with-did',
      testUser.id,
      assetData
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    
    expect(body.asset.tags).toBeDefined();
    expect(Array.isArray(body.asset.tags)).toBe(true);
    expect(body.asset.tags).toContain('tag1');
    expect(body.asset.tags).toContain('tag2');
    expect(body.asset.tags).toContain('tag3');
  });

  it('should validate URL safety (reject localhost)', async () => {
    const assetData = {
      title: 'Unsafe URL',
      category: 'art',
      mediaUrl: 'http://localhost:3000/image.png',
    };

    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      '/api/assets/create-with-did',
      testUser.id,
      assetData
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('URL');
  });

  it('should validate URL safety (reject private IPs)', async () => {
    const assetData = {
      title: 'Private IP',
      category: 'art',
      mediaUrl: 'http://192.168.1.1/image.png',
    };

    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      '/api/assets/create-with-did',
      testUser.id,
      assetData
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('URL');
  });

  it('should handle metadata correctly', async () => {
    const metadata = {
      customField1: 'value1',
      customField2: 42,
      nested: {
        field: 'nestedValue',
      },
    };

    const assetData = {
      title: 'Metadata Test',
      category: 'art',
      metadata: JSON.stringify(metadata),
      mediaUrl: 'https://example.com/image.png',
    };

    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      '/api/assets/create-with-did',
      testUser.id,
      assetData
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    
    expect(body.asset.metadata).toBeDefined();
    expect(body.asset.metadata.customField1).toBe('value1');
    expect(body.asset.metadata.customField2).toBe(42);
  });
});

describe('Asset Creation Integration', () => {
  it('should integrate with Originals SDK correctly', async () => {
    const testUser = await createTestUser();
    
    // Create asset using SDK directly
    const resources = [{
      id: 'test-resource',
      type: 'AssetMetadata',
      contentType: 'application/json',
      hash: 'a'.repeat(64),
      content: JSON.stringify({ title: 'SDK Test' }),
    }];

    const asset = await originalsSdk.lifecycle.createAsset(resources);

    expect(asset).toBeDefined();
    expect(asset.id).toMatch(/^did:peer:/);
    expect(asset.currentLayer).toBe('did:peer');
    expect(asset.resources).toHaveLength(1);
    expect(asset.getProvenance()).toBeDefined();
  });

  it('should handle multiple concurrent asset creations', async () => {
    const testUser = await createTestUser();
    
    // Create multiple assets concurrently
    const promises = Array.from({ length: 5 }, (_, i) => {
      const resources = [{
        id: `resource-${i}`,
        type: 'AssetMetadata',
        contentType: 'application/json',
        hash: `${'a'.repeat(63)}${i}`,
        content: JSON.stringify({ title: `Asset ${i}` }),
      }];
      
      return originalsSdk.lifecycle.createAsset(resources);
    });

    const assets = await Promise.all(promises);

    expect(assets).toHaveLength(5);
    assets.forEach((asset, i) => {
      expect(asset.id).toMatch(/^did:peer:/);
      expect(asset.resources[0].id).toBe(`resource-${i}`);
    });
  });
});
