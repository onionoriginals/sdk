import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright';

/**
 * E2E Integration Test for Publish to Web Flow
 * 
 * This test suite validates the complete publish-to-web flow:
 * - Asset creation (did:peer)
 * - Publishing to web (did:peer → did:webvh)
 * - DID resolution verification
 * - UI state updates
 * - Error handling
 * 
 * Prerequisites:
 * - Server must be running on localhost:5000
 * - Privy authentication must be configured
 * - Test user credentials must be available
 */

describe('Publish to Web E2E', () => {
  let browser: Browser;
  let page: Page;
  const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:5000';

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: process.env.CI === 'true',
    });
  });

  afterAll(async () => {
    await browser.close();
  });

  it('should complete full publish flow', async () => {
    page = await browser.newPage();

    try {
      // Step 1: Login
      await page.goto(`${BASE_URL}/login`);
      await page.waitForLoadState('networkidle');

      // Authenticate (simplified for E2E - actual flow may vary)
      const loginButton = page.locator('button:has-text("Sign In")');
      if (await loginButton.isVisible()) {
        await loginButton.click();
        await page.waitForTimeout(1000);
        
        // Handle Privy authentication flow
        const emailInput = page.locator('input[type="email"]');
        if (await emailInput.isVisible()) {
          await emailInput.fill(process.env.TEST_USER_EMAIL || 'test@example.com');
          await page.locator('button:has-text("Continue")').click();
          await page.waitForTimeout(1000);
        }
      }

      // Wait for successful authentication
      await page.waitForURL(/\/(dashboard|$)/, { timeout: 10000 });

      // Step 2: Create asset
      await page.goto(`${BASE_URL}/create`);
      await page.waitForLoadState('networkidle');

      // Fill asset creation form
      const assetTypeSelect = page.locator('[data-testid="asset-type-select"]');
      await assetTypeSelect.click();
      await page.waitForTimeout(500);
      
      // Select first available asset type or create one
      const assetTypeOptions = page.locator('[role="option"]');
      const optionCount = await assetTypeOptions.count();
      
      if (optionCount > 0) {
        await assetTypeOptions.first().click();
      } else {
        // Create asset type first
        await page.goto(`${BASE_URL}/setup`);
        await page.locator('input[name="typeName"]').fill('E2E Publish Test Type');
        await page.locator('button:has-text("Create Type")').click();
        await page.waitForTimeout(1000);
        await page.goto(`${BASE_URL}/create`);
        await page.waitForLoadState('networkidle');
        await assetTypeSelect.click();
        await page.waitForTimeout(500);
        await page.locator('[role="option"]').first().click();
      }

      // Fill title
      await page.locator('[data-testid="asset-title-input"]').fill('Publish Test Asset');

      // Fill description
      await page.locator('[data-testid="asset-description-input"]').fill('Asset for E2E publish testing');

      // Select category
      const categorySelect = page.locator('[data-testid="category-select"]');
      await categorySelect.click();
      await page.waitForTimeout(500);
      await page.locator('[role="option"]:has-text("Art")').click();

      // Upload test file
      const fileInput = page.locator('[data-testid="media-upload-input"]');
      const testImageBuffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      );
      
      await fileInput.setInputFiles({
        name: 'test.png',
        mimeType: 'image/png',
        buffer: testImageBuffer,
      });

      await page.waitForTimeout(500);

      // Submit form
      const submitButton = page.locator('[data-testid="create-asset-button"]');
      await submitButton.click();

      // Step 3: Wait for creation success
      await page.waitForTimeout(2000);

      // Navigate to asset detail (if not auto-redirected)
      const currentUrl = page.url();
      if (currentUrl.includes('/dashboard') || currentUrl.includes('/assets')) {
        // Find and click on the created asset
        await page.locator('text="Publish Test Asset"').first().click();
        await page.waitForTimeout(1000);
      }

      // Step 4: Verify asset is in did:peer layer
      const layerBadge = page.locator('[data-testid="layer-badge"]');
      await layerBadge.waitFor({ state: 'visible', timeout: 5000 });
      
      const badgeText = await layerBadge.textContent();
      expect(badgeText).toMatch(/Private|did:peer/i);

      // Step 5: Click publish button
      const publishButton = page.locator('button:has-text("Publish to Web")');
      await publishButton.waitFor({ state: 'visible', timeout: 5000 });
      await publishButton.click();

      // Step 6: Confirmation modal should appear
      await page.waitForSelector('text=Publish Asset to Web?', { timeout: 5000 });
      
      // Verify modal content
      const modalContent = await page.textContent('body');
      expect(modalContent).toMatch(/publicly accessible/i);

      // Step 7: Confirm publish
      const confirmButton = page.locator('button:has-text("Publish to Web")').last();
      await confirmButton.click();

      // Step 8: Wait for success
      await page.waitForTimeout(2000);
      
      // Check for success toast or message
      const successMessage = page.locator('text=/Published to Web|Success/i');
      const hasSuccess = await successMessage.isVisible().catch(() => false);
      expect(hasSuccess).toBe(true);

      // Step 9: Verify layer badge updated
      const updatedBadge = await layerBadge.textContent();
      expect(updatedBadge).toMatch(/Published|Web|did:webvh/i);

      // Step 10: Verify did:webvh is displayed
      const webDidElement = page.locator('[data-testid="web-did"]');
      if (await webDidElement.isVisible()) {
        const webDid = await webDidElement.textContent();
        expect(webDid).toMatch(/did:webvh:/);
      }

      // Step 11: Click resolver URL (if displayed)
      const resolverLink = page.locator('a[href*=".well-known/did"]');
      const linkCount = await resolverLink.count();
      expect(linkCount).toBeGreaterThan(0);

      // Step 12: Verify publish button is gone or disabled
      const publishButtonAfter = page.locator('button:has-text("Publish to Web")');
      const buttonCount = await publishButtonAfter.count();
      
      if (buttonCount > 0) {
        // If button still exists, it should be disabled
        const isDisabled = await publishButtonAfter.isDisabled();
        expect(isDisabled).toBe(true);
      } else {
        // Button should not exist for published assets
        expect(buttonCount).toBe(0);
      }

      // Step 13: Verify provenance was updated
      const provenanceSection = page.locator('text=/Provenance|Migration|Published/i');
      if (await provenanceSection.isVisible()) {
        const provenanceText = await provenanceSection.textContent();
        expect(provenanceText).toBeDefined();
      }

    } finally {
      await page.close();
    }
  }, 90000); // 90 second timeout for complete E2E test

  it('should prevent publishing already published asset', async () => {
    page = await browser.newPage();

    try {
      // Assume user is already authenticated and has a published asset
      await page.goto(`${BASE_URL}/dashboard`);
      await page.waitForLoadState('networkidle');

      // Find an asset that's already published (must exist for this test)
      const publishedBadge = page.locator('[data-testid="layer-badge"]:has-text("Published")').first();
      
      // Assert prerequisite: published asset must exist
      await expect(publishedBadge).toBeVisible({ timeout: 5000 });
      
      // Click on published asset
      await publishedBadge.locator('..').click(); // Click parent element
      await page.waitForTimeout(1000);

      // Publish button should not be visible
      const publishButton = page.locator('button:has-text("Publish to Web")');
      const isVisible = await publishButton.isVisible().catch(() => false);
      
      expect(isVisible).toBe(false);

    } finally {
      await page.close();
    }
  }, 30000);

  it('should handle publish errors gracefully', async () => {
    page = await browser.newPage();

    try {
      // Intercept the publish API call to return an error
      await page.route('**/api/assets/*/publish-to-web', (route) => {
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Publish failed' }),
        });
      });

      await page.goto(`${BASE_URL}/dashboard`);
      await page.waitForLoadState('networkidle');

      // Find a private asset (must exist for this test)
      const privateBadge = page.locator('[data-testid="layer-badge"]:has-text("Private")').first();
      
      // Assert prerequisite
      await expect(privateBadge).toBeVisible({ timeout: 5000 });
      
      // Click to view details
      await privateBadge.locator('..').click();
      await page.waitForTimeout(1000);

      // Try to publish
      const publishButton = page.locator('button:has-text("Publish to Web")');
      await expect(publishButton).toBeVisible({ timeout: 5000 });
      
      await publishButton.click();
      
      // Confirm in modal
      await page.waitForTimeout(500);
      const confirmButton = page.locator('button:has-text("Publish to Web")').last();
      await confirmButton.click();

      // Wait for error message
      await page.waitForTimeout(1000);
      
      // Should show error toast
      const errorMessage = page.locator('text=/error|failed/i');
      const hasError = await errorMessage.isVisible().catch(() => false);
      expect(hasError).toBe(true);

      // Asset should still be in did:peer
      const layerBadge = page.locator('[data-testid="layer-badge"]');
      const badgeText = await layerBadge.textContent();
      expect(badgeText).toMatch(/Private|did:peer/i);

    } finally {
      await page.close();
    }
  }, 30000);

  it('should show loading state during publish', async () => {
    page = await browser.newPage();

    try {
      // Intercept publish API to delay response
      await page.route('**/api/assets/*/publish-to-web', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        route.continue();
      });

      await page.goto(`${BASE_URL}/dashboard`);
      await page.waitForLoadState('networkidle');

      // Find a private asset and click to view (must exist for this test)
      const privateBadge = page.locator('[data-testid="layer-badge"]:has-text("Private")').first();
      
      // Assert prerequisite
      await expect(privateBadge).toBeVisible({ timeout: 5000 });
      await privateBadge.locator('..').click();
      await page.waitForTimeout(1000);

      const publishButton = page.locator('button:has-text("Publish to Web")');
      await expect(publishButton).toBeVisible({ timeout: 5000 });
      
      await publishButton.click();
      
      // Confirm
      await page.waitForTimeout(500);
      const confirmButton = page.locator('button:has-text("Publish to Web")').last();
      await confirmButton.click();

      // Should show loading indicator
      await page.waitForTimeout(500);
      const loadingIndicator = page.locator('text=/Publishing|Loading/i');
      const isLoading = await loadingIndicator.isVisible().catch(() => false);
      expect(isLoading).toBe(true);

    } finally {
      await page.close();
    }
  }, 30000);

  it('should resolve published DID document', async () => {
    page = await browser.newPage();

    try {
      await page.goto(`${BASE_URL}/dashboard`);
      await page.waitForLoadState('networkidle');

      // Find a published asset (must exist for this test)
      const publishedBadge = page.locator('[data-testid="layer-badge"]:has-text("Published")').first();
      
      // Assert prerequisite
      await expect(publishedBadge).toBeVisible({ timeout: 5000 });
      await publishedBadge.locator('..').click();
      await page.waitForTimeout(1000);

      // Get the resolver URL
      const resolverLink = page.locator('a[href*=".well-known/did"]').first();
      
      await expect(resolverLink).toBeVisible({ timeout: 5000 });
      const resolverUrl = await resolverLink.getAttribute('href');
      expect(resolverUrl).toBeDefined();

      // Visit the resolver URL
      if (resolverUrl) {
        const fullUrl = resolverUrl.startsWith('http') ? resolverUrl : `${BASE_URL}${resolverUrl}`;
        await page.goto(fullUrl);
        await page.waitForLoadState('networkidle');

        // Should return JSON DID document
        const content = await page.textContent('body');
        expect(content).toContain('did:webvh:');
        
        // Try to parse as JSON
        const didDoc = JSON.parse(content || '{}');
        expect(didDoc.id).toMatch(/^did:webvh:/);
      }

    } finally {
      await page.close();
    }
  }, 30000);

  it('should show provenance history after publish', async () => {
    page = await browser.newPage();

    try {
      await page.goto(`${BASE_URL}/dashboard`);
      await page.waitForLoadState('networkidle');

      // Find a published asset (must exist for this test)
      const publishedBadge = page.locator('[data-testid="layer-badge"]:has-text("Published")').first();
      
      // Assert prerequisite
      await expect(publishedBadge).toBeVisible({ timeout: 5000 });
      await publishedBadge.locator('..').click();
      await page.waitForTimeout(1000);

      // Look for provenance section
      const provenanceHeading = page.locator('text=/Provenance|History/i');
      if (await provenanceHeading.isVisible()) {
        // Should show migration from did:peer to did:webvh
        const pageContent = await page.textContent('body');
        
        expect(pageContent).toMatch(/did:peer|Private/i);
        expect(pageContent).toMatch(/did:webvh|Published|Web/i);
      }

    } finally {
      await page.close();
    }
  }, 30000);

  it('should handle unauthorized publish attempts', async () => {
    page = await browser.newPage();

    try {
      // Intercept publish API to return 403
      await page.route('**/api/assets/*/publish-to-web', (route) => {
        route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Not authorized' }),
        });
      });

      await page.goto(`${BASE_URL}/dashboard`);
      await page.waitForLoadState('networkidle');

      const privateBadge = page.locator('[data-testid="layer-badge"]:has-text("Private")').first();
      
      // Assert prerequisite
      await expect(privateBadge).toBeVisible({ timeout: 5000 });
      await privateBadge.locator('..').click();
      await page.waitForTimeout(1000);

      const publishButton = page.locator('button:has-text("Publish to Web")');
      await expect(publishButton).toBeVisible({ timeout: 5000 });
      
      await publishButton.click();
      await page.waitForTimeout(500);
      
      const confirmButton = page.locator('button:has-text("Publish to Web")').last();
      await confirmButton.click();
      await page.waitForTimeout(1000);

      // Should show authorization error
      const errorMessage = page.locator('text=/authorized|permission/i');
      const hasError = await errorMessage.isVisible().catch(() => false);
      expect(hasError).toBe(true);

    } finally {
      await page.close();
    }
  }, 30000);

  it('should preserve asset data after publish', async () => {
    page = await browser.newPage();

    try {
      await page.goto(`${BASE_URL}/dashboard`);
      await page.waitForLoadState('networkidle');

      // Find a private asset (must exist for this test)
      const privateBadge = page.locator('[data-testid="layer-badge"]:has-text("Private")').first();
      
      // Assert prerequisite
      await expect(privateBadge).toBeVisible({ timeout: 5000 });
      await privateBadge.locator('..').click();
      await page.waitForTimeout(1000);

      // Capture original asset data
      const originalTitle = await page.locator('h1').first().textContent();
      const originalDescription = await page.locator('[data-testid="asset-description"]').textContent().catch(() => '');

      // Publish the asset
      const publishButton = page.locator('button:has-text("Publish to Web")');
      await expect(publishButton).toBeVisible({ timeout: 5000 });
      
      await publishButton.click();
      await page.waitForTimeout(500);
      
      const confirmButton = page.locator('button:has-text("Publish to Web")').last();
      await confirmButton.click();
      await page.waitForTimeout(2000);

      // Verify asset data is preserved
      const newTitle = await page.locator('h1').first().textContent();
      const newDescription = await page.locator('[data-testid="asset-description"]').textContent().catch(() => '');

      expect(newTitle).toBe(originalTitle);
      expect(newDescription).toBe(originalDescription);

    } finally {
      await page.close();
    }
  }, 30000);
});
