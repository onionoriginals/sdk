import { describe, it, expect, beforeEach, afterEach, beforeAll, mock } from 'bun:test';
import express from 'express';
import FormData from 'form-data';
import { Readable } from 'stream';
import type { Server } from 'http';
import { createTestUser, createMockAuthToken, createTestFile } from '../../__tests__/helpers/test-helpers';

// Mock Privy module BEFORE importing routes
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
        rawSign: async () => ({
          signature: '0x' + 'a'.repeat(128), // 64-byte signature as hex
          encoding: 'hex',
        }),
      };
    }
  },
}));

// Dynamic imports after mocks are set up
let registerRoutes: typeof import('../routes').registerRoutes;
let storage: typeof import('../storage').storage;
let originalsSdk: typeof import('../originals').originalsSdk;

beforeAll(async () => {
  const routesModule = await import('../routes');
  const storageModule = await import('../storage');
  const originalsModule = await import('../originals');
  
  registerRoutes = routesModule.registerRoutes;
  storage = storageModule.storage;
  originalsSdk = originalsModule.originalsSdk;
});

// Helper to make authenticated requests against the test server
async function makeAuthRequest(
  serverUrl: string,
  method: string,
  path: string,
  userId: string,
  body?: any,
  formData?: FormData
): Promise<any> {
  const authHeader = `Bearer mock-token-${userId}`;
  
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

// Helper to get test auth cookie (for compatibility with existing patterns)
async function getTestAuthCookie(userSuffix?: string): Promise<string> {
  const testUser = await createTestUser(userSuffix);
  return createMockAuthToken(testUser.did);
}

describe('POST /api/assets/:id/publish-to-web', () => {
  let app: express.Application;
  let server: Server;
  let serverUrl: string;
  let testUser: any;
  let peerAssetId: string;

  beforeEach(async () => {
    // Setup Express app
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    
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
    
    // Create a did:peer asset first
    const formData = new FormData();
    formData.append('title', 'Test Peer Asset');
    formData.append('description', 'For publish testing');
    formData.append('category', 'art');
    formData.append('mediaFile', Buffer.from('test-image-data'), {
      filename: 'test.png',
      contentType: 'image/png',
    });

    const createResponse = await makeAuthRequest(
      serverUrl,
      'POST',
      '/api/assets/create-with-did',
      testUser.did,
      undefined,
      formData
    );

    const createBody = await createResponse.json();
    peerAssetId = createBody.asset.id;
  });

  afterEach(async () => {
    // Stop server
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });

  it('should publish asset from did:peer to did:webvh', async () => {
    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      `/api/assets/${peerAssetId}/publish-to-web`,
      testUser.did,
      {}
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    
    expect(body.asset.currentLayer).toBe('did:webvh');
    expect(body.asset.didWebvh).toMatch(/^did:webvh:/);
    expect(body.asset.didPeer).toBeTruthy(); // Original preserved
    expect(body.originalsAsset.previousDid).toBeDefined();
  });

  it('should update provenance with publish event', async () => {
    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      `/api/assets/${peerAssetId}/publish-to-web`,
      testUser.did,
      {}
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    
    const provenance = body.asset.provenance;
    const publishEvent = provenance.migrations?.find((e: any) => e.to === 'did:webvh');
    
    expect(publishEvent).toBeDefined();
    expect(publishEvent.from).toBe('did:peer');
    expect(publishEvent.to).toBe('did:webvh');
  });

  it('should make DID document publicly resolvable', async () => {
    const publishResponse = await makeAuthRequest(
      serverUrl,
      'POST',
      `/api/assets/${peerAssetId}/publish-to-web`,
      testUser.did,
      {}
    );

    expect(publishResponse.status).toBe(200);
    const publishBody = await publishResponse.json();
    
    const didWebvh = publishBody.asset.didWebvh;
    const slug = didWebvh.split(':').pop();
    
    // Verify DID resolution works (public endpoint, no auth needed)
    const resolveResponse = await fetch(`${serverUrl}/.well-known/did/${slug}`);
    
    expect(resolveResponse.status).toBe(200);
    const resolveBody = await resolveResponse.json();
    expect(resolveBody).toBeDefined();
    expect(resolveBody.id).toBe(didWebvh);
  });

  it('should reject if asset already published', async () => {
    // Publish once
    await makeAuthRequest(
      serverUrl,
      'POST',
      `/api/assets/${peerAssetId}/publish-to-web`,
      testUser.did,
      {}
    );
    
    // Try to publish again
    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      `/api/assets/${peerAssetId}/publish-to-web`,
      testUser.did,
      {}
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.toLowerCase()).toContain('already');
  });

  it('should reject if user does not own asset', async () => {
    const otherUser = await createTestUser('otheruser');
    
    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      `/api/assets/${peerAssetId}/publish-to-web`,
      otherUser.did,
      {}
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.toLowerCase()).toContain('authorized');
  });

  it('should reject if asset not found', async () => {
    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      '/api/assets/nonexistent-id/publish-to-web',
      testUser.did,
      {}
    );

    expect(response.status).toBe(404);
  });

  it('should reject unauthenticated request', async () => {
    const response = await fetch(`${serverUrl}/api/assets/${peerAssetId}/publish-to-web`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
  });

  it('should handle custom domain', async () => {
    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      `/api/assets/${peerAssetId}/publish-to-web`,
      testUser.did,
      { domain: 'custom.example.com' }
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    
    expect(body.asset.didWebvh).toContain('custom.example.com');
  });

  it('should preserve all original asset data', async () => {
    const original = await storage.getAsset(peerAssetId);
    
    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      `/api/assets/${peerAssetId}/publish-to-web`,
      testUser.did,
      {}
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    const published = body.asset;
    
    expect(published.title).toBe(original?.title);
    expect(published.description).toBe(original?.description);
    expect(published.mediaUrl).toBe(original?.mediaUrl);
    expect(published.metadata).toBeDefined();
  });

  it('should include resolver URL in response', async () => {
    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      `/api/assets/${peerAssetId}/publish-to-web`,
      testUser.did,
      {}
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    
    expect(body.resolverUrl).toBeDefined();
    expect(body.resolverUrl).toMatch(/\.well-known\/did/);
  });

  it('should handle SDK errors gracefully', async () => {
    // Mock SDK to throw error
    const originalPublishToWeb = originalsSdk.lifecycle.publishToWeb;
    try {
      originalsSdk.lifecycle.publishToWeb = mock(async () => {
        throw new Error('SDK publish failed');
      });

      const response = await makeAuthRequest(
        serverUrl,
        'POST',
        `/api/assets/${peerAssetId}/publish-to-web`,
        testUser.did,
        {}
      );

      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.error).toBeDefined();
    } finally {
      // Restore original function
      originalsSdk.lifecycle.publishToWeb = originalPublishToWeb;
    }
  });

  it('should update currentLayer correctly', async () => {
    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      `/api/assets/${peerAssetId}/publish-to-web`,
      testUser.did,
      {}
    );

    expect(response.status).toBe(200);
    
    // Verify in database
    const stored = await storage.getAsset(peerAssetId);
    expect(stored?.currentLayer).toBe('did:webvh');
    expect(stored?.didWebvh).toBeTruthy();
    expect(stored?.didPeer).toBeTruthy(); // Original preserved
  });

  it('should create valid webvh binding', async () => {
    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      `/api/assets/${peerAssetId}/publish-to-web`,
      testUser.did,
      {}
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    
    const didWebvh = body.asset.didWebvh;
    expect(didWebvh).toMatch(/^did:webvh:[^:]+:/);
    
    // Verify the binding is in the originals asset
    expect(body.originalsAsset.bindings).toBeDefined();
    expect(body.originalsAsset.bindings['did:webvh']).toBe(didWebvh);
  });

  it('should issue credential for publication', async () => {
    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      `/api/assets/${peerAssetId}/publish-to-web`,
      testUser.did,
      {}
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    
    const credentials = body.asset.credentials;
    expect(Array.isArray(credentials)).toBe(true);
    expect(credentials.length).toBeGreaterThan(0);
    
    // Find publication credential
    const pubCredential = credentials.find((c: any) =>
      c.type?.includes('ResourceMigrated') || c.type?.includes('ResourcePublished')
    );
    
    expect(pubCredential).toBeDefined();
  });

  it('should handle concurrent publish requests correctly', async () => {
    // Try to publish the same asset twice concurrently
    const promise1 = makeAuthRequest(
      serverUrl,
      'POST',
      `/api/assets/${peerAssetId}/publish-to-web`,
      testUser.did,
      {}
    );
    
    const promise2 = makeAuthRequest(
      serverUrl,
      'POST',
      `/api/assets/${peerAssetId}/publish-to-web`,
      testUser.did,
      {}
    );

    const [response1, response2] = await Promise.all([promise1, promise2]);
    
    // One should succeed, one should fail
    const statuses = [response1.status, response2.status].sort();
    expect(statuses).toContain(200); // At least one succeeds
    expect(statuses).toContain(400); // At least one fails with "already published"
  });

  it('should reject if asset missing did:peer identifier', async () => {
    // Create an asset without did:peer (manually manipulate database)
    const brokenAsset = await storage.createAsset({
      userId: testUser.did,
      title: 'Broken Asset',
      description: 'No did:peer',
      category: 'test',
      tags: null,
      mediaUrl: 'https://example.com/test.png',
      metadata: {},
      currentLayer: 'did:peer',
      didPeer: null, // Missing!
      didWebvh: null,
      didBtco: null,
      didDocument: {} as any,
      credentials: [],
      provenance: {} as any,
      status: 'completed',
      assetType: 'original',
    });

    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      `/api/assets/${brokenAsset.id}/publish-to-web`,
      testUser.did,
      {}
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('did:peer');
  });

  it('should reject if asset missing resources data', async () => {
    // Create an asset without proper resources
    const brokenAsset = await storage.createAsset({
      userId: testUser.did,
      title: 'No Resources Asset',
      description: 'Missing resources',
      category: 'test',
      tags: null,
      mediaUrl: 'https://example.com/test.png',
      metadata: { resources: [] }, // Empty resources!
      currentLayer: 'did:peer',
      didPeer: 'did:peer:xyz789',
      didWebvh: null,
      didBtco: null,
      didDocument: {} as any,
      credentials: [],
      provenance: {} as any,
      status: 'completed',
      assetType: 'original',
    });

    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      `/api/assets/${brokenAsset.id}/publish-to-web`,
      testUser.did,
      {}
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('resources');
  });

  it('should include all expected response fields', async () => {
    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      `/api/assets/${peerAssetId}/publish-to-web`,
      testUser.did,
      {}
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    
    // Check all top-level fields
    expect(body.asset).toBeDefined();
    expect(body.originalsAsset).toBeDefined();
    expect(body.resolverUrl).toBeDefined();
    expect(body.ownershipCredential !== undefined).toBe(true); // Can be null
    
    // Check asset fields
    expect(body.asset.currentLayer).toBe('did:webvh');
    expect(body.asset.didPeer).toBeDefined();
    expect(body.asset.didWebvh).toBeDefined();
    expect(body.asset.didDocument).toBeDefined();
    expect(body.asset.provenance).toBeDefined();
    
    // Check originalsAsset fields
    expect(body.originalsAsset.did).toBeDefined();
    expect(body.originalsAsset.previousDid).toBeDefined();
    expect(body.originalsAsset.resources).toBeDefined();
    expect(body.originalsAsset.provenance).toBeDefined();
    
    // Check resolver URL format
    expect(body.resolverUrl).toMatch(/^https?:\/\/.+\/.well-known\/did\/.+$/);
  });

  it('should update DID document with new id', async () => {
    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      `/api/assets/${peerAssetId}/publish-to-web`,
      testUser.did,
      {}
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    
    // DID document should have the new did:webvh as its id
    expect(body.asset.didDocument.id).toBe(body.asset.didWebvh);
  });

  it('should preserve provenance through publish', async () => {
    const originalAsset = await storage.getAsset(peerAssetId);
    const originalProvenance = originalAsset?.provenance;

    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      `/api/assets/${peerAssetId}/publish-to-web`,
      testUser.did,
      {}
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    
    // Should have original provenance data plus new migration
    expect(body.asset.provenance).toBeDefined();
    expect(body.asset.provenance.migrations).toBeDefined();
    expect(body.asset.provenance.migrations.length).toBeGreaterThan(0);
    
    // Find the webvh migration
    const webvhMigration = body.asset.provenance.migrations.find(
      (m: any) => m.to === 'did:webvh'
    );
    expect(webvhMigration).toBeDefined();
    expect(webvhMigration.from).toBe('did:peer');
  });

  it('should set updatedAt timestamp', async () => {
    const beforeTime = new Date();

    const response = await makeAuthRequest(
      serverUrl,
      'POST',
      `/api/assets/${peerAssetId}/publish-to-web`,
      testUser.did,
      {}
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    
    const afterTime = new Date();
    const updatedAt = new Date(body.asset.updatedAt);
    
    expect(updatedAt >= beforeTime).toBe(true);
    expect(updatedAt <= afterTime).toBe(true);
  });
});
