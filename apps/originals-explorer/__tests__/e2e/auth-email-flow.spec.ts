import { test, expect } from '@playwright/test';

/**
 * Email Authentication Tests - Turnkey Email Auth Flow
 * Tests the two-step email verification process
 */

test.describe('Email Authentication Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Start from the login page
    await page.goto('/login');
  });

  test('should display email input step', async ({ page }) => {
    // Check page elements
    await expect(page.locator('h2')).toContainText('Welcome to Originals');
    await expect(page.locator('[data-testid="email-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="send-code-button"]')).toBeVisible();
    await expect(page.locator('[data-testid="send-code-button"]')).toContainText('Send Verification Code');
    await expect(page.locator('text=Turnkey')).toBeVisible();
  });

  test('should validate email before sending code', async ({ page }) => {
    // Try to submit empty email
    await page.click('[data-testid="send-code-button"]');
    await expect(page.locator('text=Email Required')).toBeVisible();

    // Try invalid email
    await page.fill('[data-testid="email-input"]', 'invalid-email');
    await page.click('[data-testid="send-code-button"]');
    await expect(page.locator('text=Invalid Email')).toBeVisible();
  });

  test('should complete full email auth flow', async ({ page }) => {
    const testEmail = `test-${Date.now()}@example.com`;

    // Step 1: Enter email
    await page.fill('[data-testid="email-input"]', testEmail);
    await page.click('[data-testid="send-code-button"]');

    // Should show success message and move to code step
    await expect(page.locator('text=Verification Code Sent')).toBeVisible();
    await expect(page.locator('[data-testid="code-input"]')).toBeVisible({ timeout: 5000 });

    // Step 2: Verify we're on the code entry screen
    await expect(page.locator('h2')).toContainText('Enter Verification Code');
    await expect(page.locator(`text=${testEmail}`)).toBeVisible();

    // Note: In real scenario, we'd get the code from the server console
    // For automated testing, we'll need to mock or intercept the API response

    // The code input should be visible and focused
    await expect(page.locator('[data-testid="code-input"]')).toBeFocused();
  });

  test('should show back button on code screen', async ({ page }) => {
    const testEmail = `test-${Date.now()}@example.com`;

    // Get to code screen
    await page.fill('[data-testid="email-input"]', testEmail);
    await page.click('[data-testid="send-code-button"]');
    await page.waitForSelector('[data-testid="code-input"]', { timeout: 5000 });

    // Check for back button
    const backButton = page.locator('[data-testid="back-button"]');
    await expect(backButton).toBeVisible();
    await expect(backButton).toContainText('Use Different Email');

    // Click back
    await backButton.click();

    // Should return to email step
    await expect(page.locator('[data-testid="email-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="email-input"]')).toHaveValue(testEmail);
  });

  test('should only accept numeric input for code', async ({ page }) => {
    const testEmail = `test-${Date.now()}@example.com`;

    // Get to code screen
    await page.fill('[data-testid="email-input"]', testEmail);
    await page.click('[data-testid="send-code-button"]');
    await page.waitForSelector('[data-testid="code-input"]', { timeout: 5000 });

    // Try to enter non-numeric characters
    const codeInput = page.locator('[data-testid="code-input"]');
    await codeInput.fill('abc123xyz');

    // Should only have numeric characters
    await expect(codeInput).toHaveValue('123');
  });

  test('should limit code to 6 digits', async ({ page }) => {
    const testEmail = `test-${Date.now()}@example.com`;

    // Get to code screen
    await page.fill('[data-testid="email-input"]', testEmail);
    await page.click('[data-testid="send-code-button"]');
    await page.waitForSelector('[data-testid="code-input"]', { timeout: 5000 });

    // Try to enter more than 6 digits
    const codeInput = page.locator('[data-testid="code-input"]');
    await codeInput.fill('1234567890');

    // Should only have 6 digits
    await expect(codeInput).toHaveValue('123456');
  });

  test('should disable verify button until 6 digits entered', async ({ page }) => {
    const testEmail = `test-${Date.now()}@example.com`;

    // Get to code screen
    await page.fill('[data-testid="email-input"]', testEmail);
    await page.click('[data-testid="send-code-button"]');
    await page.waitForSelector('[data-testid="code-input"]', { timeout: 5000 });

    const verifyButton = page.locator('[data-testid="verify-code-button"]');
    const codeInput = page.locator('[data-testid="code-input"]');

    // Button should be disabled with no code
    await expect(verifyButton).toBeDisabled();

    // Still disabled with partial code
    await codeInput.fill('123');
    await expect(verifyButton).toBeDisabled();

    // Enabled with 6 digits
    await codeInput.fill('123456');
    await expect(verifyButton).toBeEnabled();
  });

  test('should show resend option', async ({ page }) => {
    const testEmail = `test-${Date.now()}@example.com`;

    // Get to code screen
    await page.fill('[data-testid="email-input"]', testEmail);
    await page.click('[data-testid="send-code-button"]');
    await page.waitForSelector('[data-testid="code-input"]', { timeout: 5000 });

    // Check for resend link
    await expect(page.locator('text=Didn\'t receive a code?')).toBeVisible();
    await expect(page.locator('text=Resend')).toBeVisible();
  });
});

test.describe('Email Auth with API Mocking', () => {
  test('should complete full flow with mocked API', async ({ page }) => {
    const testEmail = `mock-test-${Date.now()}@example.com`;
    const sessionId = 'mock-session-123';
    const code = '123456';

    // Mock the initiate endpoint
    await page.route('**/api/auth/initiate', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          sessionId: sessionId,
          message: 'Verification code sent',
        }),
      });
    });

    // Mock the verify endpoint
    await page.route('**/api/auth/verify', async (route) => {
      const postData = route.request().postDataJSON();
      if (postData.code === code) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            message: 'Authentication successful',
          }),
          headers: {
            'Set-Cookie': 'auth_token=mock-jwt-token; HttpOnly; Secure; SameSite=Strict',
          },
        });
      } else {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'Verification failed',
            details: 'Invalid code',
          }),
        });
      }
    });

    // Navigate to login
    await page.goto('/login');

    // Enter email
    await page.fill('[data-testid="email-input"]', testEmail);
    await page.click('[data-testid="send-code-button"]');

    // Should move to code step
    await page.waitForSelector('[data-testid="code-input"]', { timeout: 5000 });
    await expect(page.locator('h2')).toContainText('Enter Verification Code');

    // Enter code
    await page.fill('[data-testid="code-input"]', code);
    await page.click('[data-testid="verify-code-button"]');

    // Should show success toast
    await expect(page.locator('text=Verification Successful')).toBeVisible();
  });

  test('should handle invalid verification code', async ({ page }) => {
    const testEmail = `mock-test-${Date.now()}@example.com`;
    const sessionId = 'mock-session-123';

    // Mock endpoints
    await page.route('**/api/auth/initiate', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          sessionId: sessionId,
          message: 'Verification code sent',
        }),
      });
    });

    await page.route('**/api/auth/verify', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Verification failed',
          details: 'Invalid code',
        }),
      });
    });

    // Go through flow
    await page.goto('/login');
    await page.fill('[data-testid="email-input"]', testEmail);
    await page.click('[data-testid="send-code-button"]');
    await page.waitForSelector('[data-testid="code-input"]', { timeout: 5000 });

    // Enter wrong code
    await page.fill('[data-testid="code-input"]', '999999');
    await page.click('[data-testid="verify-code-button"]');

    // Should show error
    await expect(page.locator('text=Verification Failed')).toBeVisible();
    await expect(page.locator('text=Invalid code')).toBeVisible();

    // Should still be on code screen
    await expect(page.locator('[data-testid="code-input"]')).toBeVisible();
  });

  test('should handle network errors gracefully', async ({ page }) => {
    const testEmail = `network-error-${Date.now()}@example.com`;

    // Mock network failure
    await page.route('**/api/auth/initiate', async (route) => {
      await route.abort('failed');
    });

    await page.goto('/login');
    await page.fill('[data-testid="email-input"]', testEmail);
    await page.click('[data-testid="send-code-button"]');

    // Should show error toast
    await expect(page.locator('text=Connection Error')).toBeVisible();

    // Should still be on email step
    await expect(page.locator('[data-testid="email-input"]')).toBeVisible();
  });

  test('should handle expired session', async ({ page }) => {
    const testEmail = `expired-${Date.now()}@example.com`;
    const sessionId = 'expired-session-123';

    await page.route('**/api/auth/initiate', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          sessionId: sessionId,
          message: 'Verification code sent',
        }),
      });
    });

    await page.route('**/api/auth/verify', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Verification failed',
          details: 'Session expired. Please request a new code.',
        }),
      });
    });

    await page.goto('/login');
    await page.fill('[data-testid="email-input"]', testEmail);
    await page.click('[data-testid="send-code-button"]');
    await page.waitForSelector('[data-testid="code-input"]', { timeout: 5000 });

    await page.fill('[data-testid="code-input"]', '123456');
    await page.click('[data-testid="verify-code-button"]');

    await expect(page.locator('text=Session expired')).toBeVisible();
  });
});
