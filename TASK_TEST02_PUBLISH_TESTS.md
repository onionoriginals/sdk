# Task TEST-02: Publish to Web Tests

**Estimated Time**: 3-4 hours  
**Priority**: 🟡 High  
**Dependencies**: TASK_BE02 and TASK_FE02 must be complete

---

## Objective

Add comprehensive tests for the publish-to-web flow, covering backend API, frontend UI, and end-to-end integration.

---

## Context Files to Read

```bash
# Backend endpoint to test
apps/originals-explorer/server/routes.ts (search for /publish-to-web)

# Frontend component to test  
apps/originals-explorer/client/src/pages/asset-detail.tsx (or wherever publish UI is)

# Reference tests
tests/integration/CompleteLifecycle.e2e.test.ts
apps/originals-explorer/server/__tests__/asset-creation.test.ts (from TEST-01)
```

---

## Requirements

### 1. Backend API Tests

Create: `apps/originals-explorer/server/__tests__/publish-to-web.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import request from 'supertest';
import { app } from '../index';
import { storage } from '../storage';

describe('POST /api/assets/:id/publish-to-web', () => {
  let authCookie: string;
  let peerAssetId: string;
  
  beforeEach(async () => {
    authCookie = await getTestAuthCookie();
    
    // Create a did:peer asset first
    const createResponse = await request(app)
      .post('/api/assets/create-with-did')
      .set('Cookie', authCookie)
      .field('title', 'Test Peer Asset')
      .attach('mediaFile', Buffer.from('test'), 'test.png');
    
    peerAssetId = createResponse.body.asset.id;
  });
  
  it('should publish asset from did:peer to did:webvh', async () => {
    const response = await request(app)
      .post(`/api/assets/${peerAssetId}/publish-to-web`)
      .set('Cookie', authCookie)
      .send({})
      .expect(200);
    
    expect(response.body.asset.currentLayer).toBe('did:webvh');
    expect(response.body.asset.didWebvh).toMatch(/^did:webvh:/);
    expect(response.body.asset.didPeer).toBeTruthy(); // Original preserved
    expect(response.body.originalsAsset.previousDid).toBeTruthy();
  });
  
  it('should update provenance with publish event', async () => {
    const response = await request(app)
      .post(`/api/assets/${peerAssetId}/publish-to-web`)
      .set('Cookie', authCookie)
      .send({})
      .expect(200);
    
    const provenance = response.body.asset.provenance;
    const publishEvent = provenance.events.find(e => e.type === 'published');
    
    expect(publishEvent).toBeDefined();
    expect(publishEvent.layer).toBe('did:webvh');
  });
  
  it('should make DID document publicly resolvable', async () => {
    const publishResponse = await request(app)
      .post(`/api/assets/${peerAssetId}/publish-to-web`)
      .set('Cookie', authCookie)
      .send({})
      .expect(200);
    
    const didWebvh = publishResponse.body.asset.didWebvh;
    const slug = didWebvh.split(':').pop();
    
    // Verify DID resolution works
    const resolveResponse = await request(app)
      .get(`/.well-known/did/${slug}`)
      .expect(200);
    
    expect(resolveResponse.body).toBeDefined();
    expect(resolveResponse.body.id).toBe(didWebvh);
  });
  
  it('should reject if asset not in did:peer', async () => {
    // Publish once
    await request(app)
      .post(`/api/assets/${peerAssetId}/publish-to-web`)
      .set('Cookie', authCookie)
      .send({});
    
    // Try to publish again
    const response = await request(app)
      .post(`/api/assets/${peerAssetId}/publish-to-web`)
      .set('Cookie', authCookie)
      .send({})
      .expect(400);
    
    expect(response.body.error).toContain('already');
  });
  
  it('should reject if user does not own asset', async () => {
    const otherUserCookie = await getTestAuthCookie('otheruser');
    
    const response = await request(app)
      .post(`/api/assets/${peerAssetId}/publish-to-web`)
      .set('Cookie', otherUserCookie)
      .send({})
      .expect(403);
    
    expect(response.body.error).toContain('authorized');
  });
  
  it('should reject if asset not found', async () => {
    await request(app)
      .post('/api/assets/nonexistent/publish-to-web')
      .set('Cookie', authCookie)
      .send({})
      .expect(404);
  });
  
  it('should reject unauthenticated request', async () => {
    await request(app)
      .post(`/api/assets/${peerAssetId}/publish-to-web`)
      .send({})
      .expect(401);
  });
  
  it('should handle custom domain', async () => {
    const response = await request(app)
      .post(`/api/assets/${peerAssetId}/publish-to-web`)
      .set('Cookie', authCookie)
      .send({ domain: 'custom.example.com' })
      .expect(200);
    
    expect(response.body.asset.didWebvh).toContain('custom.example.com');
  });
  
  it('should preserve all original asset data', async () => {
    const original = await storage.getAsset(peerAssetId);
    
    await request(app)
      .post(`/api/assets/${peerAssetId}/publish-to-web`)
      .set('Cookie', authCookie)
      .send({});
    
    const published = await storage.getAsset(peerAssetId);
    
    expect(published?.title).toBe(original?.title);
    expect(published?.description).toBe(original?.description);
    expect(published?.mediaUrl).toBe(original?.mediaUrl);
    expect(published?.metadata).toEqual(original?.metadata);
  });
});
```

### 2. Frontend Component Tests

Create: `apps/originals-explorer/client/src/pages/__tests__/publish-to-web.test.tsx`

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AssetDetailPage from '../asset-detail'; // Or wherever publish UI is
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

describe('Publish to Web UI', () => {
  let queryClient: QueryClient;
  
  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
    
    // Mock asset in did:peer layer
    global.fetch = jest.fn((url) => {
      if (url.includes('/api/assets/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            id: 'test-id',
            title: 'Test Asset',
            currentLayer: 'did:peer',
            didPeer: 'did:peer:abc123',
            userId: 'current-user-id'
          })
        });
      }
    });
  });
  
  const renderComponent = (assetId = 'test-id') => {
    return render(
      <QueryClientProvider client={queryClient}>
        <AssetDetailPage assetId={assetId} />
      </QueryClientProvider>
    );
  };
  
  it('should show publish button for did:peer assets', async () => {
    renderComponent();
    
    await waitFor(() => {
      expect(screen.getByText(/publish to web/i)).toBeInTheDocument();
    });
  });
  
  it('should not show publish button for did:webvh assets', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          currentLayer: 'did:webvh',
          didWebvh: 'did:webvh:example.com:xyz'
        })
      })
    );
    
    renderComponent();
    
    await waitFor(() => {
      expect(screen.queryByText(/publish to web/i)).not.toBeInTheDocument();
    });
  });
  
  it('should show confirmation modal on publish click', async () => {
    renderComponent();
    
    await waitFor(() => screen.getByText(/publish to web/i));
    
    const publishButton = screen.getByText(/publish to web/i);
    await userEvent.click(publishButton);
    
    expect(screen.getByText(/publish asset to web\?/i)).toBeInTheDocument();
    expect(screen.getByText(/publicly accessible/i)).toBeInTheDocument();
  });
  
  it('should call API when publish confirmed', async () => {
    const publishMock = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          asset: {
            currentLayer: 'did:webvh',
            didWebvh: 'did:webvh:example.com:xyz',
            didPeer: 'did:peer:abc123'
          },
          resolverUrl: 'https://example.com/.well-known/did/xyz'
        })
      })
    );
    
    global.fetch = jest.fn((url, options) => {
      if (url.includes('/publish-to-web') && options?.method === 'POST') {
        return publishMock();
      }
      // Default fetch for initial load
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          currentLayer: 'did:peer',
          didPeer: 'did:peer:abc123'
        })
      });
    });
    
    renderComponent();
    
    await waitFor(() => screen.getByText(/publish to web/i));
    await userEvent.click(screen.getByText(/publish to web/i));
    
    // Confirm in modal
    const confirmButton = screen.getByRole('button', { name: /publish to web/i });
    await userEvent.click(confirmButton);
    
    await waitFor(() => {
      expect(publishMock).toHaveBeenCalled();
    });
  });
  
  it('should display success state after publish', async () => {
    global.fetch = jest.fn((url, options) => {
      if (url.includes('/publish-to-web')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            asset: {
              currentLayer: 'did:webvh',
              didWebvh: 'did:webvh:example.com:xyz'
            },
            resolverUrl: 'https://example.com/.well-known/did/xyz'
          })
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    
    renderComponent();
    // ... click publish, confirm ...
    
    await waitFor(() => {
      expect(screen.getByText(/published to web/i)).toBeInTheDocument();
      expect(screen.getByText(/did:webvh:example.com:xyz/i)).toBeInTheDocument();
    });
  });
  
  it('should display resolver URL link', async () => {
    // Similar to above, verify link is clickable
  });
  
  it('should handle API errors', async () => {
    global.fetch = jest.fn((url, options) => {
      if (url.includes('/publish-to-web')) {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({
            error: 'Publish failed'
          })
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    
    renderComponent();
    // ... trigger publish ...
    
    await waitFor(() => {
      expect(screen.getByText(/publish failed/i)).toBeInTheDocument();
    });
  });
  
  it('should show loading state during publish', async () => {
    renderComponent();
    // ... click publish ...
    
    expect(screen.getByText(/publishing/i)).toBeInTheDocument();
  });
});
```

### 3. E2E Integration Test

Create: `apps/originals-explorer/__tests__/integration/publish-flow.test.ts`

```typescript
import { describe, it, expect } from 'bun:test';
import { chromium } from 'playwright';

describe('Publish to Web E2E', () => {
  it('should complete full publish flow', async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    // Login
    await page.goto('http://localhost:5000/login');
    await page.fill('[name="username"]', 'testuser');
    await page.fill('[name="password"]', 'testpass');
    await page.click('button[type="submit"]');
    
    // Create asset
    await page.goto('http://localhost:5000/create');
    await page.fill('[name="title"]', 'Publish Test Asset');
    await page.setInputFiles('input[type="file"]', {
      name: 'test.png',
      mimeType: 'image/png',
      buffer: Buffer.from('test-image')
    });
    await page.click('button:has-text("Create")');
    
    // Wait for creation success
    await page.waitForSelector('text=Asset Created Successfully');
    
    // Navigate to asset (or stay on success page)
    await page.click('text=View Asset');
    
    // Verify asset is in did:peer
    await page.waitForSelector('[data-testid="layer-badge"]:has-text("Private")');
    
    // Click publish button
    await page.click('button:has-text("Publish to Web")');
    
    // Confirmation modal appears
    await page.waitForSelector('text=Publish Asset to Web?');
    
    // Confirm publish
    await page.click('button:has-text("Publish to Web")');
    
    // Wait for success
    await page.waitForSelector('text=Published to Web');
    
    // Verify layer badge updated
    const layerBadge = await page.textContent('[data-testid="layer-badge"]');
    expect(layerBadge).toContain('Published');
    
    // Verify did:webvh displayed
    const webDid = await page.textContent('[data-testid="web-did"]');
    expect(webDid).toMatch(/did:webvh:/);
    
    // Click resolver URL
    const resolverLink = page.locator('a[href*=".well-known/did"]');
    expect(await resolverLink.count()).toBeGreaterThan(0);
    
    // Verify can't publish again
    const publishButton = page.locator('button:has-text("Publish to Web")');
    expect(await publishButton.count()).toBe(0);
    
    await browser.close();
  });
});
```

---

## Validation Checklist

- [ ] All backend API tests pass
- [ ] All frontend component tests pass
- [ ] E2E integration test passes
- [ ] Tests cover success paths
- [ ] Tests cover error cases
- [ ] Tests verify layer transitions
- [ ] Tests verify DID resolution
- [ ] Tests verify authorization
- [ ] Tests are not flaky (run 3x)
- [ ] Coverage > 80% for new code

---

## Running Tests

```bash
# Backend
bun test server/__tests__/publish-to-web.test.ts

# Frontend
bun test client/src/pages/__tests__/publish-to-web.test.tsx

# E2E
bun test __tests__/integration/publish-flow.test.ts

# All tests
bun test
```

---

## Success Criteria

✅ Task is complete when:
1. All tests pass consistently
2. Edge cases are covered
3. Error scenarios tested
4. E2E flow works end-to-end
5. Test coverage is adequate
6. Tests are maintainable

---

## Next Task

After completion, proceed to:
- **TASK_BE03_INSCRIBE_ON_BITCOIN.md** - Implement Bitcoin inscription
