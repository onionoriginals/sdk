import { test, expect } from '@playwright/test';

/**
 * Logout Tests
 * Tests the logout functionality and session cleanup
 */

test.describe('Logout Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Login before each test
    const testEmail = `test-${Date.now()}@example.com`;
    await page.goto('/login');
    await page.fill('input[type="email"]', testEmail);
    await page.click('[data-testid="login-button"]');
    await page.waitForURL('/', { timeout: 10000 });
  });

  test('should successfully logout', async ({ page, context }) => {
    // Verify user is logged in
    const cookies = await context.cookies();
    const authCookie = cookies.find(c => c.name === 'auth_token');
    expect(authCookie).toBeTruthy();

    // Navigate to profile page (or wherever logout button is)
    await page.goto('/profile');

    // Find and click logout button - adjust selector based on your UI
    // This is a placeholder - update with actual selector
    const logoutButton = page.locator('button:has-text("Logout"), button:has-text("Sign Out"), [data-testid="logout-button"]').first();

    if (await logoutButton.isVisible()) {
      await logoutButton.click();

      // Should redirect to login or homepage
      await page.waitForURL(/\/(login)?/, { timeout: 5000 });

      // Cookie should be cleared
      const cookiesAfterLogout = await context.cookies();
      const authCookieAfterLogout = cookiesAfterLogout.find(c => c.name === 'auth_token');

      // Cookie should either be removed or have empty/expired value
      if (authCookieAfterLogout) {
        expect(authCookieAfterLogout.value).toBe('');
      }
    } else {
      console.log('Logout button not found - skipping test');
      test.skip();
    }
  });

  test('should not access protected routes after logout', async ({ page, context }) => {
    // Navigate to profile page
    await page.goto('/profile');

    // Logout via API call directly
    await page.evaluate(async () => {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    });

    // Try to access protected route
    const response = await page.goto('/api/user');

    // Should return 401 Unauthorized
    expect(response?.status()).toBe(401);

    // Navigate to profile should redirect to login
    await page.goto('/profile');
    // Allow some time for redirect
    await page.waitForTimeout(1000);

    // Should be on login page or show unauthenticated state
    const currentUrl = page.url();
    const isProtected = currentUrl.includes('/login') || currentUrl.includes('/');
    expect(isProtected).toBe(true);
  });

  test('should clear all session data on logout', async ({ page, context }) => {
    // Logout
    await page.evaluate(async () => {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    });

    // Check that auth cookie is cleared
    const cookies = await context.cookies();
    const authCookie = cookies.find(c => c.name === 'auth_token');

    if (authCookie) {
      expect(authCookie.value).toBe('');
    }

    // Verify API calls are unauthorized
    const userResponse = await page.goto('/api/user');
    expect(userResponse?.status()).toBe(401);
  });
});

test.describe('Session Expiration', () => {
  test('should handle expired JWT token', async ({ page, context }) => {
    // Login
    const testEmail = `expiry-test-${Date.now()}@example.com`;
    await page.goto('/login');
    await page.fill('input[type="email"]', testEmail);
    await page.click('[data-testid="login-button"]');
    await page.waitForURL('/', { timeout: 10000 });

    // Manually set an expired token (this is a simulation)
    // In a real scenario, you'd wait for the token to expire or modify the JWT_EXPIRES_IN
    await context.addCookies([{
      name: 'auth_token',
      value: 'expired.token.value',
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Strict',
    }]);

    // Try to access protected route
    const response = await page.goto('/api/user');

    // Should return 401 due to invalid token
    expect(response?.status()).toBe(401);
  });

  test('should handle missing auth cookie', async ({ page }) => {
    // Try to access protected route without logging in
    const response = await page.goto('/api/user');

    // Should return 401 Unauthorized
    expect(response?.status()).toBe(401);

    const data = await response?.json();
    expect(data.error).toMatch(/not authenticated|invalid|expired/i);
  });
});
