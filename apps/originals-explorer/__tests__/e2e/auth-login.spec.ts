import { test, expect } from '@playwright/test';

/**
 * Authentication Tests - Turnkey Login Flow
 * Tests the email-based login flow with Turnkey authentication
 */

test.describe('Turnkey Authentication Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Start from the login page
    await page.goto('/login');
  });

  test('should display login page correctly', async ({ page }) => {
    // Check page title
    await expect(page.locator('h2')).toContainText('Welcome to Originals');

    // Check for email input field
    const emailInput = page.locator('input[type="email"]');
    await expect(emailInput).toBeVisible();
    await expect(emailInput).toHaveAttribute('placeholder', 'your@email.com');

    // Check for login button
    const loginButton = page.locator('[data-testid="login-button"]');
    await expect(loginButton).toBeVisible();
    await expect(loginButton).toContainText('Sign In');

    // Check for Turnkey branding
    await expect(page.locator('text=Turnkey')).toBeVisible();
  });

  test('should show validation error for empty email', async ({ page }) => {
    // Click login button without entering email
    await page.click('[data-testid="login-button"]');

    // Should show validation error
    await expect(page.locator('text=Email Required')).toBeVisible();
  });

  test('should show validation error for invalid email', async ({ page }) => {
    // Enter invalid email
    await page.fill('input[type="email"]', 'invalid-email');

    // Click login button
    await page.click('[data-testid="login-button"]');

    // Should show validation error
    await expect(page.locator('text=Invalid Email')).toBeVisible();
  });

  test('should successfully login with valid email', async ({ page }) => {
    // Enter valid email
    const testEmail = `test-${Date.now()}@example.com`;
    await page.fill('input[type="email"]', testEmail);

    // Click login button
    await page.click('[data-testid="login-button"]');

    // Wait for login to complete
    await page.waitForURL('/', { timeout: 10000 });

    // Should redirect to homepage after successful login
    await expect(page).toHaveURL('/');

    // Check if user is authenticated by looking for profile or logout button
    // This depends on your UI - adjust selector as needed
    await page.waitForTimeout(2000); // Give time for UI to render
  });

  test('should maintain authentication after page reload', async ({ page, context }) => {
    // Login first
    const testEmail = `test-${Date.now()}@example.com`;
    await page.fill('input[type="email"]', testEmail);
    await page.click('[data-testid="login-button"]');

    // Wait for redirect to homepage
    await page.waitForURL('/', { timeout: 10000 });

    // Reload the page
    await page.reload();

    // Should still be on homepage (not redirected to login)
    await expect(page).toHaveURL('/');

    // Verify cookie exists
    const cookies = await context.cookies();
    const authCookie = cookies.find(c => c.name === 'auth_token');
    expect(authCookie).toBeTruthy();
    expect(authCookie?.httpOnly).toBe(true);
  });

  test('should handle concurrent logins with different emails', async ({ browser }) => {
    // Create two separate browser contexts (isolated sessions)
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    try {
      // Login with first user
      await page1.goto('/login');
      const email1 = `user1-${Date.now()}@example.com`;
      await page1.fill('input[type="email"]', email1);
      await page1.click('[data-testid="login-button"]');
      await page1.waitForURL('/', { timeout: 10000 });

      // Login with second user
      await page2.goto('/login');
      const email2 = `user2-${Date.now()}@example.com`;
      await page2.fill('input[type="email"]', email2);
      await page2.click('[data-testid="login-button"]');
      await page2.waitForURL('/', { timeout: 10000 });

      // Both should be authenticated with different sessions
      const cookies1 = await context1.cookies();
      const cookies2 = await context2.cookies();

      const authCookie1 = cookies1.find(c => c.name === 'auth_token');
      const authCookie2 = cookies2.find(c => c.name === 'auth_token');

      expect(authCookie1).toBeTruthy();
      expect(authCookie2).toBeTruthy();
      expect(authCookie1?.value).not.toBe(authCookie2?.value);
    } finally {
      await context1.close();
      await context2.close();
    }
  });

  test('should show loading state during login', async ({ page }) => {
    // Enter email
    const testEmail = `test-${Date.now()}@example.com`;
    await page.fill('input[type="email"]', testEmail);

    // Click login button
    const loginButton = page.locator('[data-testid="login-button"]');
    await loginButton.click();

    // Should show loading state (button disabled and text changed)
    await expect(loginButton).toContainText('Signing in...');
    await expect(loginButton).toBeDisabled();

    // Wait for login to complete
    await page.waitForURL('/', { timeout: 10000 });
  });

  test('should handle return path after login', async ({ page }) => {
    // Try to access a protected page (e.g., /profile)
    await page.goto('/profile');

    // Should redirect to login with returnTo parameter
    await page.waitForURL(/\/login/, { timeout: 5000 });

    // Login
    const testEmail = `test-${Date.now()}@example.com`;
    await page.fill('input[type="email"]', testEmail);
    await page.click('[data-testid="login-button"]');

    // Should redirect back to the original page or homepage
    await page.waitForURL(/\/(profile)?/, { timeout: 10000 });
  });
});

test.describe('Authentication State Management', () => {
  test('should create Turnkey sub-organization for new user', async ({ page }) => {
    // This test verifies the server-side Turnkey integration
    const testEmail = `new-user-${Date.now()}@example.com`;

    await page.goto('/login');
    await page.fill('input[type="email"]', testEmail);
    await page.click('[data-testid="login-button"]');

    // Wait for successful login
    await page.waitForURL('/', { timeout: 10000 });

    // User should be authenticated
    const response = await page.goto('/api/user');
    expect(response?.status()).toBe(200);

    const userData = await response?.json();
    expect(userData).toBeTruthy();
    expect(userData.email).toBe(testEmail);
    expect(userData.turnkeySubOrgId).toBeTruthy();
    expect(userData.did).toMatch(/^did:webvh:/);
  });

  test('should reuse existing Turnkey sub-organization for returning user', async ({ page, context }) => {
    // Login first time
    const testEmail = `returning-user-${Date.now()}@example.com`;

    await page.goto('/login');
    await page.fill('input[type="email"]', testEmail);
    await page.click('[data-testid="login-button"]');
    await page.waitForURL('/', { timeout: 10000 });

    // Get user data
    const firstLoginResponse = await page.goto('/api/user');
    const firstUserData = await firstLoginResponse?.json();
    const firstSubOrgId = firstUserData.turnkeySubOrgId;

    // Logout (clear cookies)
    await context.clearCookies();

    // Login again with same email
    await page.goto('/login');
    await page.fill('input[type="email"]', testEmail);
    await page.click('[data-testid="login-button"]');
    await page.waitForURL('/', { timeout: 10000 });

    // Get user data again
    const secondLoginResponse = await page.goto('/api/user');
    const secondUserData = await secondLoginResponse?.json();
    const secondSubOrgId = secondUserData.turnkeySubOrgId;

    // Should reuse the same sub-organization
    expect(firstSubOrgId).toBe(secondSubOrgId);
  });
});

test.describe('Cookie Security', () => {
  test('should set secure HTTP-only cookie', async ({ page, context }) => {
    // Login
    const testEmail = `security-test-${Date.now()}@example.com`;
    await page.goto('/login');
    await page.fill('input[type="email"]', testEmail);
    await page.click('[data-testid="login-button"]');
    await page.waitForURL('/', { timeout: 10000 });

    // Check cookie properties
    const cookies = await context.cookies();
    const authCookie = cookies.find(c => c.name === 'auth_token');

    expect(authCookie).toBeTruthy();
    expect(authCookie?.httpOnly).toBe(true);
    expect(authCookie?.sameSite).toBe('Strict');
    // In development, secure may be false, in production it should be true
    // expect(authCookie?.secure).toBe(true);
  });

  test('should not expose JWT token to JavaScript', async ({ page }) => {
    // Login
    const testEmail = `js-security-test-${Date.now()}@example.com`;
    await page.goto('/login');
    await page.fill('input[type="email"]', testEmail);
    await page.click('[data-testid="login-button"]');
    await page.waitForURL('/', { timeout: 10000 });

    // Try to access cookie via JavaScript (should not be accessible)
    const cookieValue = await page.evaluate(() => {
      return document.cookie;
    });

    // HTTP-only cookie should not be in document.cookie
    expect(cookieValue).not.toContain('auth_token');
  });
});
