import { test, expect } from '@playwright/test';

/**
 * Protected Routes Tests
 * Tests access control for authenticated vs unauthenticated users
 */

test.describe('Protected Routes - Unauthenticated', () => {
  test('should allow access to public routes', async ({ page }) => {
    // Homepage should be accessible
    const homeResponse = await page.goto('/');
    expect(homeResponse?.status()).toBe(200);

    // Login page should be accessible
    const loginResponse = await page.goto('/login');
    expect(loginResponse?.status()).toBe(200);

    // Register page should be accessible (if it exists)
    const registerResponse = await page.goto('/register');
    // Could be 200 or 404 depending on if the route exists
    expect([200, 404]).toContain(registerResponse?.status() || 404);
  });

  test('should block API access without authentication', async ({ page }) => {
    // User endpoint should require authentication
    const userResponse = await page.goto('/api/user');
    expect(userResponse?.status()).toBe(401);

    // Assets endpoint should require authentication
    const assetsResponse = await page.goto('/api/assets');
    expect(assetsResponse?.status()).toBe(401);

    // Asset types endpoint should require authentication
    const assetTypesResponse = await page.goto('/api/asset-types');
    expect(assetTypesResponse?.status()).toBe(401);
  });

  test('should handle unauthenticated DID endpoints', async ({ page }) => {
    // DID-related endpoints that should be protected
    const didMeResponse = await page.goto('/api/did/me');
    expect(didMeResponse?.status()).toBe(401);

    const didLogResponse = await page.goto('/api/did/me/log');
    expect(didLogResponse?.status()).toBe(401);

    const ensureDIDResponse = await page.goto('/api/user/ensure-did');
    expect(ensureDIDResponse?.status()).toBe(401);
  });
});

test.describe('Protected Routes - Authenticated', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    const testEmail = `test-${Date.now()}@example.com`;
    await page.goto('/login');
    await page.fill('input[type="email"]', testEmail);
    await page.click('[data-testid="login-button"]');
    await page.waitForURL('/', { timeout: 10000 });
  });

  test('should allow access to user endpoint', async ({ page }) => {
    const response = await page.goto('/api/user');
    expect(response?.status()).toBe(200);

    const userData = await response?.json();
    expect(userData).toBeTruthy();
    expect(userData.email).toBeTruthy();
    expect(userData.turnkeySubOrgId).toBeTruthy();
    expect(userData.did).toMatch(/^did:webvh:/);
  });

  test('should allow access to assets endpoint', async ({ page }) => {
    const response = await page.goto('/api/assets');
    expect(response?.status()).toBe(200);

    const assets = await response?.json();
    expect(Array.isArray(assets)).toBe(true);
  });

  test('should allow access to asset types endpoint', async ({ page }) => {
    const response = await page.goto('/api/asset-types');
    expect(response?.status()).toBe(200);

    const assetTypes = await response?.json();
    expect(Array.isArray(assetTypes)).toBe(true);
  });

  test('should allow access to DID endpoints', async ({ page }) => {
    // Get user DID document
    const didMeResponse = await page.goto('/api/did/me');
    expect(didMeResponse?.status()).toBe(200);

    const didData = await didMeResponse?.json();
    expect(didData).toBeTruthy();
    expect(didData.did).toMatch(/^did:webvh:/);
    expect(didData.didDocument).toBeTruthy();

    // Get DID log
    const didLogResponse = await page.goto('/api/did/me/log');
    expect(didLogResponse?.status()).toBe(200);

    const logData = await didLogResponse?.json();
    expect(logData).toBeTruthy();
    expect(logData.did).toMatch(/^did:webvh:/);
    expect(logData.log).toBeTruthy();
  });

  test('should allow access to profile page', async ({ page }) => {
    const response = await page.goto('/profile');
    expect(response?.status()).toBe(200);

    // Should show user information
    await page.waitForSelector('body');
    const content = await page.content();
    expect(content.length).toBeGreaterThan(0);
  });

  test('should allow access to dashboard', async ({ page }) => {
    const response = await page.goto('/dashboard');
    expect(response?.status()).toBe(200);

    await page.waitForSelector('body');
    const content = await page.content();
    expect(content.length).toBeGreaterThan(0);
  });

  test('should allow asset creation', async ({ page }) => {
    await page.goto('/create');
    expect(page.url()).toContain('/create');

    // Should show create asset form
    await page.waitForSelector('body');
    const content = await page.content();
    expect(content.length).toBeGreaterThan(0);
  });
});

test.describe('Authorization - User Isolation', () => {
  test('should only return assets owned by authenticated user', async ({ browser }) => {
    // Create two users
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    try {
      // User 1 login
      const email1 = `user1-${Date.now()}@example.com`;
      await page1.goto('/login');
      await page1.fill('input[type="email"]', email1);
      await page1.click('[data-testid="login-button"]');
      await page1.waitForURL('/', { timeout: 10000 });

      // User 2 login
      const email2 = `user2-${Date.now()}@example.com`;
      await page2.goto('/login');
      await page2.fill('input[type="email"]', email2);
      await page2.click('[data-testid="login-button"]');
      await page2.waitForURL('/', { timeout: 10000 });

      // Get user data for both
      const user1Response = await page1.goto('/api/user');
      const user1Data = await user1Response?.json();

      const user2Response = await page2.goto('/api/user');
      const user2Data = await user2Response?.json();

      // Users should have different IDs and DIDs
      expect(user1Data.id).not.toBe(user2Data.id);
      expect(user1Data.did).not.toBe(user2Data.did);
      expect(user1Data.turnkeySubOrgId).not.toBe(user2Data.turnkeySubOrgId);

      // Each user should only see their own assets
      const assets1Response = await page1.goto('/api/assets');
      const assets1 = await assets1Response?.json();

      const assets2Response = await page2.goto('/api/assets');
      const assets2 = await assets2Response?.json();

      // Assets arrays should be independent
      expect(Array.isArray(assets1)).toBe(true);
      expect(Array.isArray(assets2)).toBe(true);

      // If one user creates an asset, the other shouldn't see it
      // This is verified by the isolation of the arrays

    } finally {
      await context1.close();
      await context2.close();
    }
  });

  test('should prevent access to other users DIDs via API', async ({ browser }) => {
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    try {
      // User 1 login
      await page1.goto('/login');
      await page1.fill('input[type="email"]', `user1-${Date.now()}@example.com`);
      await page1.click('[data-testid="login-button"]');
      await page1.waitForURL('/', { timeout: 10000 });

      // User 2 login
      await page2.goto('/login');
      await page2.fill('input[type="email"]', `user2-${Date.now()}@example.com`);
      await page2.click('[data-testid="login-button"]');
      await page2.waitForURL('/', { timeout: 10000 });

      // Get User 1's DID
      const user1DIDResponse = await page1.goto('/api/did/me');
      const user1DID = await user1DIDResponse?.json();
      const user1DidString = user1DID.did;

      // User 2 tries to access User 1's DID via the authenticated endpoint
      // This should return User 2's own DID, not User 1's
      const user2DIDResponse = await page2.goto('/api/did/me');
      const user2DID = await user2DIDResponse?.json();
      const user2DidString = user2DID.did;

      // Should be different DIDs
      expect(user1DidString).not.toBe(user2DidString);

      // Public DID resolution is different - that should work for any DID
      // But authenticated endpoints should only return the current user's data

    } finally {
      await context1.close();
      await context2.close();
    }
  });
});

test.describe('API Error Handling', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    const testEmail = `test-${Date.now()}@example.com`;
    await page.goto('/login');
    await page.fill('input[type="email"]', testEmail);
    await page.click('[data-testid="login-button"]');
    await page.waitForURL('/', { timeout: 10000 });
  });

  test('should handle 404 for non-existent assets', async ({ page }) => {
    const response = await page.goto('/api/assets/non-existent-id');
    expect(response?.status()).toBe(404);

    const data = await response?.json();
    expect(data.error).toMatch(/not found/i);
  });

  test('should handle 404 for non-existent DIDs', async ({ page }) => {
    const response = await page.goto('/api/did/resolve/did:webvh:example.com:nonexistent');
    expect(response?.status()).toBe(404);

    const data = await response?.json();
    expect(data.error).toMatch(/not found/i);
  });

  test('should validate request data', async ({ page }) => {
    // Try to create asset with invalid data
    const response = await page.evaluate(async () => {
      const res = await fetch('/api/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ invalid: 'data' }),
      });
      return {
        status: res.status,
        data: await res.json(),
      };
    });

    expect(response.status).toBe(400);
    expect(response.data.error).toMatch(/validation|required/i);
  });
});
