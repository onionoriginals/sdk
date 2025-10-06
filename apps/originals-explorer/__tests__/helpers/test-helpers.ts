/**
 * Test Helpers for Asset Creation Tests
 * 
 * This module provides utility functions for testing the asset creation flow.
 */

import { storage } from '../../server/storage';
import type { User } from '@shared/schema';
import crypto from 'crypto';

/**
 * Creates a test user with DID:WebVH for testing
 */
export async function createTestUser(suffix?: string): Promise<User> {
  const timestamp = Date.now();
  const uniqueSuffix = suffix || `test-${timestamp}`;
  const privyId = `did:privy:${uniqueSuffix}`;
  const testUserId = `did:webvh:localhost%3A5000:${uniqueSuffix}`;
  
  const user = await storage.createUserWithDid(
    privyId,
    testUserId,
    {
      didDocument: {
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: testUserId,
        verificationMethod: [
          {
            id: `${testUserId}#auth-key`,
            type: 'Multikey',
            controller: testUserId,
            publicKeyMultibase: 'z' + 'a'.repeat(40),
          },
        ],
        authentication: [`${testUserId}#auth-key`],
      },
      didLog: [
        {
          versionId: '1',
          versionTime: new Date().toISOString(),
          parameters: {
            method: 'did:webvh',
            scid: 'test-scid',
          },
          state: {
            '@context': ['https://www.w3.org/ns/did/v1'],
            id: testUserId,
          },
        },
      ],
      didSlug: uniqueSuffix,
      authWalletId: `auth-wallet-${timestamp}`,
      assertionWalletId: `assertion-wallet-${timestamp}`,
      updateWalletId: `update-wallet-${timestamp}`,
      authKeyPublic: `auth-public-key-${timestamp}`,
      assertionKeyPublic: `assertion-public-key-${timestamp}`,
      updateKeyPublic: `update-public-key-${timestamp}`,
      didCreatedAt: new Date(),
    }
  );
  
  return user;
}

/**
 * Gets test assets created during testing
 * Note: This function does NOT delete assets. MemStorage does not provide
 * a delete API, so test data persists in memory for the test session.
 * Each test should use unique user IDs to ensure isolation.
 */
export async function getTestAssets(userDid: string): Promise<any[]> {
  // Get all assets for the test user
  const assets = await storage.getAssetsByUserId(userDid);
  return assets;
}

/**
 * Creates a mock auth cookie/token for testing
 */
export function createMockAuthToken(userId: string): string {
  // In real tests, you'd create a valid JWT token
  // For now, we'll create a simple mock token
  return `mock-token-${userId}`;
}

/**
 * Generates a test file buffer for upload testing
 */
export function createTestFile(type: 'image' | 'video' | 'audio' | 'document', size?: number): {
  buffer: Buffer;
  filename: string;
  mimetype: string;
} {
  const fileSize = size || 1024; // Default 1KB
  
  const files = {
    image: {
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      ),
      filename: 'test-image.png',
      mimetype: 'image/png',
    },
    video: {
      buffer: Buffer.alloc(fileSize),
      filename: 'test-video.mp4',
      mimetype: 'video/mp4',
    },
    audio: {
      buffer: Buffer.alloc(fileSize),
      filename: 'test-audio.mp3',
      mimetype: 'audio/mpeg',
    },
    document: {
      buffer: Buffer.from('Mock PDF content'),
      filename: 'test-document.pdf',
      mimetype: 'application/pdf',
    },
  };
  
  return files[type];
}

/**
 * Generates a valid SHA-256 hash for testing
 */
export function generateTestHash(input?: string): string {
  const content = input || `test-content-${Date.now()}`;
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Creates mock asset metadata for testing
 */
export function createMockAssetMetadata(overrides?: Record<string, any>) {
  return {
    title: 'Test Asset',
    description: 'Test description',
    category: 'art',
    tags: ['test', 'automated'],
    mediaType: 'image/png',
    mediaFileHash: generateTestHash(),
    ...overrides,
  };
}

/**
 * Waits for a condition to be true with timeout
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout: number = 5000,
  interval: number = 100
): Promise<void> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  
  throw new Error(`Condition not met within ${timeout}ms`);
}

/**
 * Mock Privy client for testing
 */
export function createMockPrivyClient() {
  return {
    utils: () => ({
      auth: () => ({
        verifyAuthToken: async (token: string) => {
          // Extract user ID from mock token
          const userId = token.replace('Bearer ', '').replace('mock-token-', '');
          return {
            user_id: userId,
          };
        },
      }),
    }),
    users: () => ({
      _get: async (userId: string) => ({
        id: userId,
        linked_accounts: [
          {
            type: 'wallet',
            chainType: 'bitcoin-segwit',
            address: 'tb1qtest...',
          },
        ],
      }),
    }),
    wallets: () => ({
      create: async (params: any) => ({
        id: `wallet-${Date.now()}`,
        chainType: params.chain_type,
        publicKey: 'test-public-key',
      }),
    }),
  };
}

/**
 * Mock fetch for testing API calls
 */
export function createMockFetch(responses: Record<string, any>) {
  return async (url: string, options?: any) => {
    const method = options?.method || 'GET';
    const key = `${method} ${url}`;
    
    if (responses[key]) {
      return {
        ok: true,
        status: 200,
        json: async () => responses[key],
        ...responses[key]._response,
      };
    }
    
    return {
      ok: false,
      status: 404,
      json: async () => ({ error: 'Not found' }),
    };
  };
}

/**
 * Validates asset structure
 */
export function validateAssetStructure(asset: any): boolean {
  const requiredFields = [
    'id',
    'userId',
    'title',
    'currentLayer',
    'didPeer',
    'didDocument',
    'credentials',
    'provenance',
  ];
  
  for (const field of requiredFields) {
    if (!(field in asset)) {
      console.error(`Missing required field: ${field}`);
      return false;
    }
  }
  
  // Validate currentLayer is valid
  const validLayers = ['did:peer', 'did:webvh', 'did:btco'];
  if (!validLayers.includes(asset.currentLayer)) {
    console.error(`Invalid currentLayer: ${asset.currentLayer}`);
    return false;
  }
  
  // Validate DID format
  if (!asset.didPeer.startsWith('did:peer:')) {
    console.error(`Invalid did:peer format: ${asset.didPeer}`);
    return false;
  }
  
  // Validate provenance structure
  if (!asset.provenance || !asset.provenance.creator || !asset.provenance.createdAt) {
    console.error('Invalid provenance structure');
    return false;
  }
  
  return true;
}

/**
 * Creates a mock Express app for testing
 */
export function createMockApp() {
  const express = require('express');
  const app = express();
  
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  
  return app;
}

/**
 * Utility to extract cookies from response
 */
export function extractCookies(response: any): Record<string, string> {
  const cookies: Record<string, string> = {};
  const setCookieHeader = response.headers.get('set-cookie');
  
  if (setCookieHeader) {
    const cookieStrings = Array.isArray(setCookieHeader) 
      ? setCookieHeader 
      : [setCookieHeader];
      
    for (const cookieString of cookieStrings) {
      const [nameValue] = cookieString.split(';');
      const [name, value] = nameValue.split('=');
      cookies[name.trim()] = value.trim();
    }
  }
  
  return cookies;
}

/**
 * Formats cookies for request header
 */
export function formatCookies(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}
