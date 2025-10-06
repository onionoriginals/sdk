# Task TEST-01: Asset Creation Tests

**Estimated Time**: 3-4 hours  
**Priority**: 🟡 High  
**Dependencies**: TASK_BE01 and TASK_FE01 must be complete

---

## Objective

Add comprehensive tests for the asset creation flow with DID integration, covering both backend API and frontend UI.

---

## Context Files to Read

```bash
# Existing test examples
tests/integration/CompleteLifecycle.e2e.test.ts

# Backend endpoint to test
apps/originals-explorer/server/routes.ts (search for /api/assets/create-with-did)

# Frontend component to test
apps/originals-explorer/client/src/pages/create-asset-simple.tsx

# Test utilities
tests/utils/test-helpers.ts

# SDK mocks
tests/mocks/
```

---

## Requirements

### 1. Backend API Tests

Create: `apps/originals-explorer/server/__tests__/asset-creation.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import request from 'supertest';
import { app } from '../index';
import { storage } from '../storage';

describe('POST /api/assets/create-with-did', () => {
  let authCookie: string;
  
  beforeEach(async () => {
    // Setup: Create test user and get auth cookie
    authCookie = await getTestAuthCookie();
  });
  
  afterEach(async () => {
    // Cleanup: Clear test data
    await cleanupTestAssets();
  });
  
  it('should create asset with file upload', async () => {
    const response = await request(app)
      .post('/api/assets/create-with-did')
      .set('Cookie', authCookie)
      .field('title', 'Test Asset')
      .field('description', 'Test description')
      .field('category', 'art')
      .attach('mediaFile', Buffer.from('fake-image-data'), 'test.png')
      .expect(200);
    
    expect(response.body.asset).toBeDefined();
    expect(response.body.asset.didPeer).toMatch(/^did:peer:/);
    expect(response.body.asset.currentLayer).toBe('did:peer');
    expect(response.body.asset.didDocument).toBeDefined();
    expect(response.body.asset.credentials).toBeDefined();
    expect(response.body.originalsAsset).toBeDefined();
  });
  
  it('should create asset with media URL', async () => {
    const response = await request(app)
      .post('/api/assets/create-with-did')
      .set('Cookie', authCookie)
      .send({
        title: 'URL Asset',
        description: 'From URL',
        mediaUrl: 'https://example.com/image.png'
      })
      .expect(200);
    
    expect(response.body.asset.didPeer).toMatch(/^did:peer:/);
  });
  
  it('should reject request without media', async () => {
    const response = await request(app)
      .post('/api/assets/create-with-did')
      .set('Cookie', authCookie)
      .send({
        title: 'No Media Asset'
      })
      .expect(400);
    
    expect(response.body.error).toContain('media');
  });
  
  it('should reject invalid file type', async () => {
    const response = await request(app)
      .post('/api/assets/create-with-did')
      .set('Cookie', authCookie)
      .field('title', 'Bad File')
      .attach('mediaFile', Buffer.from('text'), 'test.txt')
      .expect(400);
    
    expect(response.body.error).toContain('file type');
  });
  
  it('should reject file too large', async () => {
    const largeBuffer = Buffer.alloc(11 * 1024 * 1024); // 11MB
    
    const response = await request(app)
      .post('/api/assets/create-with-did')
      .set('Cookie', authCookie)
      .field('title', 'Large File')
      .attach('mediaFile', largeBuffer, 'large.png')
      .expect(413);
  });
  
  it('should reject unauthenticated request', async () => {
    await request(app)
      .post('/api/assets/create-with-did')
      .send({ title: 'Test' })
      .expect(401);
  });
  
  it('should store correct layer tracking fields', async () => {
    const response = await request(app)
      .post('/api/assets/create-with-did')
      .set('Cookie', authCookie)
      .field('title', 'Layer Test')
      .attach('mediaFile', Buffer.from('data'), 'test.png')
      .expect(200);
    
    const assetId = response.body.asset.id;
    const stored = await storage.getAsset(assetId);
    
    expect(stored?.currentLayer).toBe('did:peer');
    expect(stored?.didPeer).toBeTruthy();
    expect(stored?.didWebvh).toBeNull();
    expect(stored?.didBtco).toBeNull();
    expect(stored?.didDocument).toBeDefined();
    expect(stored?.provenance).toBeDefined();
  });
  
  it('should generate valid provenance chain', async () => {
    const response = await request(app)
      .post('/api/assets/create-with-did')
      .set('Cookie', authCookie)
      .field('title', 'Provenance Test')
      .attach('mediaFile', Buffer.from('data'), 'test.png')
      .expect(200);
    
    const provenance = response.body.asset.provenance;
    expect(provenance.events).toBeDefined();
    expect(provenance.events.length).toBeGreaterThan(0);
    expect(provenance.events[0].type).toBe('created');
  });
  
  it('should handle SDK errors gracefully', async () => {
    // Mock SDK to throw error
    jest.spyOn(originalsSdk.lifecycle, 'createAsset')
      .mockRejectedValueOnce(new Error('SDK Error'));
    
    const response = await request(app)
      .post('/api/assets/create-with-did')
      .set('Cookie', authCookie)
      .field('title', 'Error Test')
      .attach('mediaFile', Buffer.from('data'), 'test.png')
      .expect(500);
    
    expect(response.body.error).toContain('SDK Error');
  });
});
```

### 2. Frontend Component Tests

Create: `apps/originals-explorer/client/src/pages/__tests__/create-asset-simple.test.tsx`

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CreateAssetPage from '../create-asset-simple';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

describe('CreateAssetPage', () => {
  let queryClient: QueryClient;
  
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
  });
  
  const renderComponent = () => {
    return render(
      <QueryClientProvider client={queryClient}>
        <CreateAssetPage />
      </QueryClientProvider>
    );
  };
  
  it('should render form fields', () => {
    renderComponent();
    
    expect(screen.getByLabelText(/title/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/description/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/category/i)).toBeInTheDocument();
    expect(screen.getByText(/media file/i)).toBeInTheDocument();
  });
  
  it('should show file preview after selection', async () => {
    renderComponent();
    
    const file = new File(['image'], 'test.png', { type: 'image/png' });
    const input = screen.getByLabelText(/media file/i);
    
    await userEvent.upload(input, file);
    
    await waitFor(() => {
      expect(screen.getByAltText(/preview/i)).toBeInTheDocument();
    });
  });
  
  it('should validate required fields', async () => {
    renderComponent();
    
    const submitButton = screen.getByRole('button', { name: /create/i });
    await userEvent.click(submitButton);
    
    await waitFor(() => {
      expect(screen.getByText(/title is required/i)).toBeInTheDocument();
    });
  });
  
  it('should require either file or URL', async () => {
    renderComponent();
    
    await userEvent.type(screen.getByLabelText(/title/i), 'Test Asset');
    await userEvent.click(screen.getByRole('button', { name: /create/i }));
    
    await waitFor(() => {
      expect(screen.getByText(/upload a file or provide.*url/i)).toBeInTheDocument();
    });
  });
  
  it('should submit form with file upload', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          asset: {
            id: 'test-id',
            didPeer: 'did:peer:abc123',
            currentLayer: 'did:peer',
            title: 'Test Asset',
            didDocument: {},
            credentials: {},
            provenance: { events: [] }
          },
          originalsAsset: {}
        })
      })
    );
    
    renderComponent();
    
    const file = new File(['image'], 'test.png', { type: 'image/png' });
    await userEvent.type(screen.getByLabelText(/title/i), 'Test Asset');
    await userEvent.upload(screen.getByLabelText(/media file/i), file);
    await userEvent.click(screen.getByRole('button', { name: /create/i }));
    
    await waitFor(() => {
      expect(screen.getByText(/created successfully/i)).toBeInTheDocument();
    });
  });
  
  it('should display DID after successful creation', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          asset: {
            didPeer: 'did:peer:test123',
            currentLayer: 'did:peer',
            credentials: { test: 'data' },
            provenance: { events: [{ type: 'created' }] }
          }
        })
      })
    );
    
    renderComponent();
    
    // Submit form...
    
    await waitFor(() => {
      expect(screen.getByText(/did:peer:test123/i)).toBeInTheDocument();
      expect(screen.getByText(/verifiable credentials/i)).toBeInTheDocument();
    });
  });
  
  it('should display layer badge', async () => {
    // Similar to above test, verify LayerBadge renders with "did:peer"
  });
  
  it('should handle API errors', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        json: () => Promise.resolve({
          error: 'Creation failed'
        })
      })
    );
    
    renderComponent();
    
    // Submit form...
    
    await waitFor(() => {
      expect(screen.getByText(/creation failed/i)).toBeInTheDocument();
    });
  });
  
  it('should allow creating another asset after success', async () => {
    // Test "Create Another" button functionality
  });
});
```

### 3. Integration Test

Create: `apps/originals-explorer/__tests__/integration/asset-creation-flow.test.ts`

```typescript
import { describe, it, expect } from 'bun:test';
import { chromium } from 'playwright';

describe('Asset Creation E2E Flow', () => {
  it('should create asset with full DID integration', async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    // Login
    await page.goto('http://localhost:5000/login');
    await page.fill('[name="username"]', 'testuser');
    await page.fill('[name="password"]', 'testpass');
    await page.click('button[type="submit"]');
    
    // Navigate to create page
    await page.goto('http://localhost:5000/create');
    
    // Fill form
    await page.fill('[name="title"]', 'E2E Test Asset');
    await page.fill('[name="description"]', 'Created via E2E test');
    await page.selectOption('[name="category"]', 'art');
    
    // Upload file
    await page.setInputFiles('input[type="file"]', {
      name: 'test.png',
      mimeType: 'image/png',
      buffer: Buffer.from('fake-image-data')
    });
    
    // Submit
    await page.click('button:has-text("Create Asset")');
    
    // Wait for success
    await page.waitForSelector('text=Asset Created Successfully');
    
    // Verify DID is displayed
    const didText = await page.textContent('[data-testid="asset-did"]');
    expect(didText).toMatch(/did:peer:/);
    
    // Verify layer badge
    const layerBadge = await page.textContent('[data-testid="layer-badge"]');
    expect(layerBadge).toContain('Private');
    
    // Navigate to dashboard
    await page.click('text=View Dashboard');
    
    // Verify asset appears with did:peer badge
    await page.waitForSelector('text=E2E Test Asset');
    const assetCard = page.locator('text=E2E Test Asset').locator('..');
    const badge = await assetCard.locator('[data-testid="layer-badge"]').textContent();
    expect(badge).toContain('Private');
    
    await browser.close();
  });
});
```

---

## Validation Checklist

- [ ] All backend API tests pass
- [ ] All frontend component tests pass
- [ ] E2E integration test passes
- [ ] Test coverage > 80% for new code
- [ ] Edge cases are tested (errors, validation, auth)
- [ ] Tests run successfully in CI/CD
- [ ] No flaky tests (run 3 times to verify)

---

## Running Tests

```bash
# Backend tests
cd apps/originals-explorer
bun test server/__tests__/asset-creation.test.ts

# Frontend tests  
bun test client/src/pages/__tests__/create-asset-simple.test.tsx

# Integration tests
bun test __tests__/integration/asset-creation-flow.test.ts

# All tests
bun test

# Coverage
bun test --coverage
```

---

## Success Criteria

✅ Task is complete when:
1. All backend API tests pass
2. All frontend component tests pass
3. E2E integration test passes
4. Coverage is adequate (>80% for new code)
5. Tests are documented and maintainable
6. CI/CD pipeline runs tests successfully

---

## Next Task

After completion, proceed to:
- **TASK_BE02_PUBLISH_TO_WEB.md** - Implement did:webvh migration
