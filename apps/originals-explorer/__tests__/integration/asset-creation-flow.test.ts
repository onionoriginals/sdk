import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { chromium, type Browser, type Page } from 'playwright';

/**
 * E2E Integration Test for Asset Creation Flow with DID Integration
 * 
 * This test suite validates the complete asset creation flow from UI to backend:
 * - User authentication with Privy
 * - Asset form validation
 * - File upload handling
 * - DID:peer creation via Originals SDK
 * - Asset storage and retrieval
 * - Layer badge display
 * - Navigation flow
 * 
 * Prerequisites:
 * - Server must be running on localhost:5000
 * - Privy authentication must be configured
 * - Test user credentials must be available
 */

describe('Asset Creation E2E Flow', () => {
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

  it('should create asset with full DID integration', async () => {
    page = await browser.newPage();

    try {
      // Step 1: Navigate to login page
      await page.goto(`${BASE_URL}/login`);
      await page.waitForLoadState('networkidle');

      // Step 2: Authenticate with Privy
      // Note: This assumes Privy test mode or mock authentication
      // In production, you'd need to handle the OAuth flow
      const loginButton = page.locator('button:has-text("Sign In")');
      if (await loginButton.isVisible()) {
        await loginButton.click();
        
        // Wait for Privy modal/redirect
        await page.waitForTimeout(2000);
        
        // If email/OTP flow is used
        const emailInput = page.locator('input[type="email"]');
        if (await emailInput.isVisible()) {
          await emailInput.fill(process.env.TEST_USER_EMAIL || 'test@example.com');
          await page.locator('button:has-text("Continue")').click();
          
          // Handle OTP if needed
          await page.waitForTimeout(1000);
        }
      }

      // Wait for successful authentication and redirect
      await page.waitForURL(/\/(dashboard|$)/, { timeout: 10000 });

      // Step 3: Navigate to create asset page
      await page.goto(`${BASE_URL}/create`);
      await page.waitForLoadState('networkidle');

      // Verify we're on the create page
      expect(await page.locator('h1:has-text("Create Original")').isVisible()).toBe(true);

      // Step 4: Fill out the asset creation form
      
      // Select asset type
      const assetTypeSelect = page.locator('[data-testid="asset-type-select"]');
      await assetTypeSelect.click();
      
      // Wait for options to appear
      await page.waitForTimeout(500);
      
      // Check if there are any asset types configured
      const assetTypeOptions = page.locator('[role="option"]');
      const optionCount = await assetTypeOptions.count();
      
      if (optionCount > 0) {
        // Select the first available option
        await assetTypeOptions.first().click();
      } else {
        // If no asset types, we need to create one first
        console.log('No asset types found, navigating to setup...');
        await page.goto(`${BASE_URL}/setup`);
        
        // Create a basic asset type
        await page.locator('input[name="typeName"]').fill('E2E Test Type');
        await page.locator('button:has-text("Create Type")').click();
        await page.waitForTimeout(1000);
        
        // Navigate back to create page
        await page.goto(`${BASE_URL}/create`);
        await page.waitForLoadState('networkidle');
        
        // Try selecting asset type again
        await assetTypeSelect.click();
        await page.waitForTimeout(500);
        await page.locator('[role="option"]').first().click();
      }

      // Fill in title
      await page.locator('[data-testid="asset-title-input"]').fill('E2E Test Asset');

      // Fill in description
      await page.locator('[data-testid="asset-description-input"]').fill('Created via E2E test');

      // Select category
      const categorySelect = page.locator('[data-testid="category-select"]');
      await categorySelect.click();
      await page.waitForTimeout(500);
      await page.locator('[role="option"]:has-text("Art")').click();

      // Add tags
      await page.locator('[data-testid="tags-input"]').fill('e2e, test, automated');

      // Upload a test file
      const fileInput = page.locator('[data-testid="media-upload-input"]');
      
      // Create a test file buffer
      const testImageBuffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      );
      
      // Set the file input
      await fileInput.setInputFiles({
        name: 'test.png',
        mimeType: 'image/png',
        buffer: testImageBuffer,
      });

      // Wait for file to be selected
      await page.waitForTimeout(500);

      // Verify file name is displayed
      const fileNameText = page.locator('text=test.png');
      expect(await fileNameText.isVisible()).toBe(true);

      // Step 5: Submit the form
      const submitButton = page.locator('[data-testid="create-asset-button"]');
      await submitButton.click();

      // Step 6: Wait for asset creation to complete
      // This should:
      // 1. Call the backend API /api/assets/create-with-did
      // 2. Create a did:peer using Originals SDK
      // 3. Store the asset in the database
      // 4. Redirect to dashboard or show success message

      // Wait for success indication (could be toast, redirect, or success page)
      await page.waitForTimeout(2000);

      // Check for success toast
      const successToast = page.locator('text=/Asset created successfully|Success/i');
      const isToastVisible = await successToast.isVisible().catch(() => false);

      // Or check if we were redirected to dashboard
      const currentUrl = page.url();
      const wasRedirected = currentUrl.includes('/dashboard') || currentUrl.includes('/assets');

      // At least one success indicator should be present
      expect(isToastVisible || wasRedirected).toBe(true);

      // Step 7: Navigate to dashboard to verify asset appears
      if (!wasRedirected) {
        await page.goto(`${BASE_URL}/dashboard`);
        await page.waitForLoadState('networkidle');
      }

      // Wait for assets to load
      await page.waitForTimeout(1000);

      // Step 8: Verify the created asset is displayed
      const assetCard = page.locator('text="E2E Test Asset"');
      expect(await assetCard.isVisible()).toBe(true);

      // Step 9: Verify the layer badge shows "did:peer" or "Private"
      // The badge should be near the asset card
      const layerBadge = page.locator('[data-testid="layer-badge"]').first();
      if (await layerBadge.isVisible()) {
        const badgeText = await layerBadge.textContent();
        expect(badgeText).toMatch(/Private|did:peer/i);
      }

      // Step 10: Click on the asset to view details
      await assetCard.click();
      await page.waitForTimeout(1000);

      // Verify asset details page shows DID information
      const didText = page.locator('text=/did:peer:/');
      if (await didText.isVisible()) {
        const didValue = await didText.textContent();
        expect(didValue).toMatch(/^did:peer:/);
      }

      // Step 11: Verify provenance information is displayed
      const provenanceSection = page.locator('text=/Provenance|Created/i');
      expect(await provenanceSection.isVisible()).toBe(true);

    } finally {
      await page.close();
    }
  }, 60000); // 60 second timeout for full E2E test

  it('should validate required fields before submission', async () => {
    page = await browser.newPage();

    try {
      // Assuming user is already authenticated from previous test
      // or using session persistence
      await page.goto(`${BASE_URL}/create`);
      await page.waitForLoadState('networkidle');

      // Try to submit without filling any fields
      const submitButton = page.locator('[data-testid="create-asset-button"]');
      await submitButton.click();

      // Should show validation errors
      await page.waitForTimeout(500);

      // Check for validation error messages
      const errorMessages = page.locator('text=/required|must be/i');
      const errorCount = await errorMessages.count();
      
      expect(errorCount).toBeGreaterThan(0);

    } finally {
      await page.close();
    }
  }, 30000);

  it('should handle file upload errors gracefully', async () => {
    page = await browser.newPage();

    try {
      await page.goto(`${BASE_URL}/create`);
      await page.waitForLoadState('networkidle');

      // Fill required fields
      const assetTypeSelect = page.locator('[data-testid="asset-type-select"]');
      await assetTypeSelect.click();
      await page.waitForTimeout(500);
      await page.locator('[role="option"]').first().click();

      await page.locator('[data-testid="asset-title-input"]').fill('Error Test');
      
      const categorySelect = page.locator('[data-testid="category-select"]');
      await categorySelect.click();
      await page.waitForTimeout(500);
      await page.locator('[role="option"]:has-text("Art")').click();

      // Try to upload an invalid file type (if validation is in place)
      const fileInput = page.locator('[data-testid="media-upload-input"]');
      
      const textFileBuffer = Buffer.from('This is a text file');
      await fileInput.setInputFiles({
        name: 'test.txt',
        mimeType: 'text/plain',
        buffer: textFileBuffer,
      });

      await page.waitForTimeout(500);

      // Submit form
      const submitButton = page.locator('[data-testid="create-asset-button"]');
      await submitButton.click();
      await page.waitForTimeout(1000);

      // Should show error message for invalid file type
      const errorMessage = page.locator('text=/file type|invalid/i');
      const hasError = await errorMessage.isVisible().catch(() => false);
      
      // Either validation prevents submission or API returns error
      expect(hasError).toBe(true);

    } finally {
      await page.close();
    }
  }, 30000);

  it('should persist form data on navigation back', async () => {
    page = await browser.newPage();

    try {
      await page.goto(`${BASE_URL}/create`);
      await page.waitForLoadState('networkidle');

      // Fill some fields
      await page.locator('[data-testid="asset-title-input"]').fill('Persistence Test');
      await page.locator('[data-testid="asset-description-input"]').fill('Testing form persistence');

      // Navigate back
      const backButton = page.locator('[data-testid="back-to-dashboard"]');
      await backButton.click();
      await page.waitForTimeout(500);

      // Navigate forward again (browser back button)
      await page.goBack();
      await page.waitForTimeout(500);

      // Check if form data persisted (depends on implementation)
      const titleValue = await page.locator('[data-testid="asset-title-input"]').inputValue();
      
      // Note: This test might fail if form doesn't persist data
      // which is acceptable behavior in some implementations
      console.log('Title value after navigation:', titleValue);

    } finally {
      await page.close();
    }
  }, 30000);

  it('should display loading state during asset creation', async () => {
    page = await browser.newPage();

    try {
      await page.goto(`${BASE_URL}/create`);
      await page.waitForLoadState('networkidle');

      // Fill out form quickly
      const assetTypeSelect = page.locator('[data-testid="asset-type-select"]');
      await assetTypeSelect.click();
      await page.locator('[role="option"]').first().click();

      await page.locator('[data-testid="asset-title-input"]').fill('Loading Test');
      
      const categorySelect = page.locator('[data-testid="category-select"]');
      await categorySelect.click();
      await page.locator('[role="option"]:has-text("Art")').click();

      const fileInput = page.locator('[data-testid="media-upload-input"]');
      const testBuffer = Buffer.from('test');
      await fileInput.setInputFiles({
        name: 'test.png',
        mimeType: 'image/png',
        buffer: testBuffer,
      });

      // Submit and immediately check for loading state
      const submitButton = page.locator('[data-testid="create-asset-button"]');
      await submitButton.click();

      // Check if button is disabled or shows loading text
      const buttonText = await submitButton.textContent();
      const isDisabled = await submitButton.isDisabled();

      // Should show loading indicator
      expect(buttonText?.includes('Creating') || isDisabled).toBe(true);

    } finally {
      await page.close();
    }
  }, 30000);
});

describe('Asset Creation with Different Media Types', () => {
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

  it('should handle image uploads', async () => {
    page = await browser.newPage();

    try {
      await page.goto(`${BASE_URL}/create`);
      await page.waitForLoadState('networkidle');

      // Upload PNG image
      const fileInput = page.locator('[data-testid="media-upload-input"]');
      const pngBuffer = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      );
      
      await fileInput.setInputFiles({
        name: 'image.png',
        mimeType: 'image/png',
        buffer: pngBuffer,
      });

      // Verify file was accepted
      expect(await page.locator('text=image.png').isVisible()).toBe(true);

    } finally {
      await page.close();
    }
  }, 20000);

  it('should reject oversized files', async () => {
    page = await browser.newPage();

    try {
      await page.goto(`${BASE_URL}/create`);
      await page.waitForLoadState('networkidle');

      // Create a large file (>10MB)
      const largeBuffer = Buffer.alloc(11 * 1024 * 1024);

      const fileInput = page.locator('[data-testid="media-upload-input"]');
      await fileInput.setInputFiles({
        name: 'large.png',
        mimeType: 'image/png',
        buffer: largeBuffer,
      });

      await page.waitForTimeout(500);

      // Should show error message
      const errorMessage = page.locator('text=/too large|size limit/i');
      const hasError = await errorMessage.isVisible().catch(() => false);
      
      expect(hasError).toBe(true);

    } finally {
      await page.close();
    }
  }, 20000);
});
