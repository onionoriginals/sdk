# Task TEST-03: Inscribe on Bitcoin Tests

**Estimated Time**: 3-4 hours  
**Priority**: 🟡 High  
**Dependencies**: TASK_BE03 and TASK_FE03 must be complete

---

## Objective

Add comprehensive tests for Bitcoin inscription flow, covering fee estimation, inscription process, and transaction monitoring.

---

## Context Files to Read

```bash
# Backend endpoints
apps/originals-explorer/server/routes.ts (search for /inscribe-on-bitcoin and /fee-estimate)

# Frontend component
apps/originals-explorer/client/src/pages/asset-detail.tsx

# Reference tests
tests/integration/CompleteLifecycle.e2e.test.ts
apps/originals-explorer/server/__tests__/publish-to-web.test.ts
```

---

## Requirements

### 1. Backend API Tests

Create: `apps/originals-explorer/server/__tests__/inscribe-on-bitcoin.test.ts`

```typescript
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import request from 'supertest';
import { app } from '../index';
import { storage } from '../storage';
import { originalsSdk } from '../originals';

describe('POST /api/assets/:id/inscribe-on-bitcoin', () => {
  let authCookie: string;
  let webAssetId: string;
  
  beforeEach(async () => {
    authCookie = await getTestAuthCookie();
    
    // Create asset and publish to web first
    const createResponse = await request(app)
      .post('/api/assets/create-with-did')
      .set('Cookie', authCookie)
      .field('title', 'Bitcoin Test')
      .attach('mediaFile', Buffer.from('test'), 'test.png');
    
    const assetId = createResponse.body.asset.id;
    
    // Publish to web
    await request(app)
      .post(`/api/assets/${assetId}/publish-to-web`)
      .set('Cookie', authCookie)
      .send({});
    
    webAssetId = assetId;
  });
  
  it('should inscribe asset from did:webvh to did:btco', async () => {
    // Mock Bitcoin inscription
    mock.module('../originals', () => ({
      originalsSdk: {
        lifecycle: {
          inscribeOnBitcoin: mock(() => Promise.resolve({
            did: 'did:btco:abc123:0',
            inscriptionTx: 'abc123',
            didDocument: {},
            credentials: {},
            provenance: { events: [] }
          }))
        }
      }
    }));
    
    const response = await request(app)
      .post(`/api/assets/${webAssetId}/inscribe-on-bitcoin`)
      .set('Cookie', authCookie)
      .send({ feeRate: 10 })
      .expect(200);
    
    expect(response.body.asset.currentLayer).toBe('did:btco');
    expect(response.body.asset.didBtco).toMatch(/^did:btco:/);
    expect(response.body.asset.didWebvh).toBeTruthy();
    expect(response.body.asset.didPeer).toBeTruthy();
    expect(response.body.originalsAsset.inscriptionDetails).toBeDefined();
    expect(response.body.originalsAsset.inscriptionDetails.txid).toBeTruthy();
  });
  
  it('should update provenance with inscribe event', async () => {
    const response = await request(app)
      .post(`/api/assets/${webAssetId}/inscribe-on-bitcoin`)
      .set('Cookie', authCookie)
      .send({ feeRate: 10 })
      .expect(200);
    
    const provenance = response.body.asset.provenance;
    const inscribeEvent = provenance.events.find(e => e.type === 'inscribed');
    
    expect(inscribeEvent).toBeDefined();
    expect(inscribeEvent.layer).toBe('did:btco');
    expect(inscribeEvent.txid).toBeTruthy();
  });
  
  it('should reject if asset not in did:webvh', async () => {
    // Create new asset (will be in did:peer)
    const createResponse = await request(app)
      .post('/api/assets/create-with-did')
      .set('Cookie', authCookie)
      .field('title', 'Peer Asset')
      .attach('mediaFile', Buffer.from('test'), 'test.png');
    
    const peerAssetId = createResponse.body.asset.id;
    
    const response = await request(app)
      .post(`/api/assets/${peerAssetId}/inscribe-on-bitcoin`)
      .set('Cookie', authCookie)
      .send({ feeRate: 10 })
      .expect(400);
    
    expect(response.body.error).toContain('did:webvh');
  });
  
  it('should reject if already inscribed', async () => {
    // Inscribe once
    await request(app)
      .post(`/api/assets/${webAssetId}/inscribe-on-bitcoin`)
      .set('Cookie', authCookie)
      .send({ feeRate: 10 });
    
    // Try again
    const response = await request(app)
      .post(`/api/assets/${webAssetId}/inscribe-on-bitcoin`)
      .set('Cookie', authCookie)
      .send({ feeRate: 10 })
      .expect(400);
    
    expect(response.body.error).toContain('already');
  });
  
  it('should reject unauthorized access', async () => {
    const otherUserCookie = await getTestAuthCookie('otheruser');
    
    await request(app)
      .post(`/api/assets/${webAssetId}/inscribe-on-bitcoin`)
      .set('Cookie', otherUserCookie)
      .send({ feeRate: 10 })
      .expect(403);
  });
  
  it('should store transaction details in metadata', async () => {
    const response = await request(app)
      .post(`/api/assets/${webAssetId}/inscribe-on-bitcoin`)
      .set('Cookie', authCookie)
      .send({ feeRate: 15 })
      .expect(200);
    
    const asset = await storage.getAsset(webAssetId);
    
    expect(asset?.metadata.inscription).toBeDefined();
    expect(asset?.metadata.inscription.txid).toBeTruthy();
    expect(asset?.metadata.inscription.feeRate).toBe(15);
    expect(asset?.metadata.inscription.cost).toBeGreaterThan(0);
  });
  
  it('should provide explorer URL', async () => {
    const response = await request(app)
      .post(`/api/assets/${webAssetId}/inscribe-on-bitcoin`)
      .set('Cookie', authCookie)
      .send({ feeRate: 10 })
      .expect(200);
    
    expect(response.body.originalsAsset.inscriptionDetails.explorerUrl).toContain('mempool.space');
  });
});

describe('GET /api/bitcoin/fee-estimate', () => {
  let authCookie: string;
  let assetId: string;
  
  beforeEach(async () => {
    authCookie = await getTestAuthCookie();
    
    const response = await request(app)
      .post('/api/assets/create-with-did')
      .set('Cookie', authCookie)
      .field('title', 'Fee Test')
      .attach('mediaFile', Buffer.from('test'), 'test.png');
    
    assetId = response.body.asset.id;
  });
  
  it('should return fee estimates for all speeds', async () => {
    const response = await request(app)
      .get(`/api/bitcoin/fee-estimate?assetId=${assetId}`)
      .set('Cookie', authCookie)
      .expect(200);
    
    expect(response.body.estimates).toBeDefined();
    expect(response.body.estimates.slow).toBeDefined();
    expect(response.body.estimates.medium).toBeDefined();
    expect(response.body.estimates.fast).toBeDefined();
    
    // Verify slow < medium < fast
    expect(response.body.estimates.slow.feeRate).toBeLessThan(
      response.body.estimates.medium.feeRate
    );
    expect(response.body.estimates.medium.feeRate).toBeLessThan(
      response.body.estimates.fast.feeRate
    );
  });
  
  it('should include cost in sats and BTC', async () => {
    const response = await request(app)
      .get(`/api/bitcoin/fee-estimate?assetId=${assetId}`)
      .set('Cookie', authCookie)
      .expect(200);
    
    const medium = response.body.estimates.medium;
    expect(medium.totalSats).toBeGreaterThan(0);
    expect(medium.totalBtc).toBeGreaterThan(0);
    expect(medium.feeRate).toBeGreaterThan(0);
    expect(medium.estimatedTime).toBeTruthy();
  });
  
  it('should require assetId', async () => {
    await request(app)
      .get('/api/bitcoin/fee-estimate')
      .set('Cookie', authCookie)
      .expect(400);
  });
  
  it('should require authentication', async () => {
    await request(app)
      .get(`/api/bitcoin/fee-estimate?assetId=${assetId}`)
      .expect(401);
  });
});
```

### 2. Frontend Component Tests

Create: `apps/originals-explorer/client/src/pages/__tests__/inscribe-ui.test.tsx`

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AssetDetailPage from '../asset-detail';

describe('Inscribe on Bitcoin UI', () => {
  beforeEach(() => {
    // Mock asset in did:webvh
    global.fetch = jest.fn((url) => {
      if (url.includes('/fee-estimate')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            currentNetwork: 'testnet',
            estimates: {
              slow: { feeRate: 5, totalSats: 10000, totalBtc: 0.0001, estimatedTime: '~2 hours' },
              medium: { feeRate: 10, totalSats: 20000, totalBtc: 0.0002, estimatedTime: '~30 min' },
              fast: { feeRate: 20, totalSats: 40000, totalBtc: 0.0004, estimatedTime: '~10 min' }
            }
          })
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          currentLayer: 'did:webvh',
          didWebvh: 'did:webvh:example.com:xyz'
        })
      });
    });
  });
  
  it('should show inscribe button for did:webvh assets', async () => {
    render(<AssetDetailPage assetId="test-id" />);
    
    await waitFor(() => {
      expect(screen.getByText(/inscribe on bitcoin/i)).toBeInTheDocument();
    });
  });
  
  it('should load fee estimates when inscribe clicked', async () => {
    render(<AssetDetailPage assetId="test-id" />);
    
    await waitFor(() => screen.getByText(/inscribe on bitcoin/i));
    await userEvent.click(screen.getByText(/inscribe on bitcoin/i));
    
    // Modal appears
    await waitFor(() => {
      expect(screen.getByText(/select fee rate/i)).toBeInTheDocument();
    });
    
    // All three fee options shown
    expect(screen.getByText(/slow/i)).toBeInTheDocument();
    expect(screen.getByText(/medium/i)).toBeInTheDocument();
    expect(screen.getByText(/fast/i)).toBeInTheDocument();
    
    // Costs displayed
    expect(screen.getByText(/10,000 sats/i)).toBeInTheDocument();
    expect(screen.getByText(/20,000 sats/i)).toBeInTheDocument();
    expect(screen.getByText(/40,000 sats/i)).toBeInTheDocument();
  });
  
  it('should allow fee selection', async () => {
    render(<AssetDetailPage assetId="test-id" />);
    
    await waitFor(() => screen.getByText(/inscribe on bitcoin/i));
    await userEvent.click(screen.getByText(/inscribe on bitcoin/i));
    
    await waitFor(() => screen.getByText(/fast/i));
    
    // Click fast option
    const fastButton = screen.getByText(/fast/i).closest('button');
    await userEvent.click(fastButton);
    
    // Verify selection (check for checkmark or visual indicator)
    expect(fastButton).toHaveClass(/bg-blue-50/);
  });
  
  it('should call API on confirm', async () => {
    const inscribeMock = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          asset: {
            currentLayer: 'did:btco',
            didBtco: 'did:btco:abc123:0'
          },
          originalsAsset: {
            inscriptionDetails: {
              txid: 'abc123',
              explorerUrl: 'https://mempool.space/tx/abc123'
            }
          }
        })
      })
    );
    
    global.fetch = jest.fn((url, options) => {
      if (url.includes('/inscribe-on-bitcoin') && options?.method === 'POST') {
        return inscribeMock();
      }
      // ... other mocks
    });
    
    // ... render, click inscribe, select fee, click confirm
    
    await waitFor(() => {
      expect(inscribeMock).toHaveBeenCalled();
    });
  });
  
  it('should display success with transaction details', async () => {
    // ... setup and inscribe ...
    
    await waitFor(() => {
      expect(screen.getByText(/inscribed on bitcoin/i)).toBeInTheDocument();
      expect(screen.getByText(/did:btco:abc123:0/i)).toBeInTheDocument();
      expect(screen.getByText(/view on block explorer/i)).toBeInTheDocument();
    });
  });
  
  it('should handle API errors', async () => {
    global.fetch = jest.fn((url, options) => {
      if (url.includes('/inscribe-on-bitcoin')) {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: 'Insufficient funds' })
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });
    
    // ... trigger inscription ...
    
    await waitFor(() => {
      expect(screen.getByText(/insufficient funds/i)).toBeInTheDocument();
    });
  });
});
```

### 3. E2E Integration Test

Create: `apps/originals-explorer/__tests__/integration/inscribe-flow.test.ts`

```typescript
import { describe, it, expect } from 'bun:test';
import { chromium } from 'playwright';

describe('Inscribe on Bitcoin E2E', () => {
  it('should complete full inscription flow', async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    // Login, create, and publish asset first
    // ... (similar to previous E2E tests)
    
    // Now asset is in did:webvh
    await page.waitForSelector('[data-testid="layer-badge"]:has-text("Published")');
    
    // Click inscribe button
    await page.click('button:has-text("Inscribe on Bitcoin")');
    
    // Fee modal appears
    await page.waitForSelector('text=Select Fee Rate');
    
    // Verify fee options loaded
    expect(await page.textContent('text=slow')).toBeTruthy();
    expect(await page.textContent('text=medium')).toBeTruthy();
    expect(await page.textContent('text=fast')).toBeTruthy();
    
    // Select medium fee
    await page.click('button:has-text("medium")');
    
    // Confirm inscription
    await page.click('button:has-text("Confirm Inscription")');
    
    // Wait for success
    await page.waitForSelector('text=Inscribed on Bitcoin', { timeout: 30000 });
    
    // Verify layer updated
    const layerBadge = await page.textContent('[data-testid="layer-badge"]');
    expect(layerBadge).toContain('Inscribed');
    
    // Verify Bitcoin DID displayed
    const btcDid = await page.textContent('[data-testid="btc-did"]');
    expect(btcDid).toMatch(/did:btco:/);
    
    // Verify explorer link exists
    const explorerLink = page.locator('a:has-text("View on Block Explorer")');
    expect(await explorerLink.count()).toBeGreaterThan(0);
    
    await browser.close();
  });
});
```

---

## Validation Checklist

- [ ] Backend inscription tests pass
- [ ] Fee estimation tests pass
- [ ] Frontend UI tests pass
- [ ] E2E integration test passes
- [ ] Tests cover all fee options
- [ ] Tests verify layer transitions
- [ ] Tests verify transaction storage
- [ ] Tests check authorization
- [ ] Tests handle errors
- [ ] Coverage > 80%

---

## Running Tests

```bash
# Backend
bun test server/__tests__/inscribe-on-bitcoin.test.ts

# Frontend  
bun test client/src/pages/__tests__/inscribe-ui.test.tsx

# E2E
bun test __tests__/integration/inscribe-flow.test.ts

# All
bun test
```

---

## Success Criteria

✅ Task is complete when:
1. All tests pass consistently
2. Fee estimation tested thoroughly
3. Inscription process verified
4. Transaction details validated
5. Error cases covered
6. E2E flow works end-to-end
7. Coverage adequate

---

## Next Task

After completion, proceed to:
- **TASK_BE04_TRANSFER_OWNERSHIP.md** - Implement asset transfer
