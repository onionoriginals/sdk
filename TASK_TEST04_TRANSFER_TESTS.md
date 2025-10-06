# Task TEST-04: Transfer Ownership Tests

**Estimated Time**: 3-4 hours  
**Priority**: 🟡 High  
**Dependencies**: TASK_BE04 and TASK_FE04 must be complete

---

## Objective

Add comprehensive tests for asset transfer functionality, covering transfer API, recipient search, transfer history, and ownership verification.

---

## Context Files to Read

```bash
# Backend endpoints
apps/originals-explorer/server/routes.ts (search for /transfer)

# Frontend component
apps/originals-explorer/client/src/pages/asset-detail.tsx

# Reference tests
tests/integration/CompleteLifecycle.e2e.test.ts
```

---

## Requirements

### 1. Backend API Tests

Create: `apps/originals-explorer/server/__tests__/transfer-ownership.test.ts`

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import request from 'supertest';
import { app } from '../index';
import { storage } from '../storage';

describe('POST /api/assets/:id/transfer', () => {
  let userACookie: string;
  let userBCookie: string;
  let userAId: string;
  let userBId: string;
  let userBDid: string;
  let assetId: string;
  
  beforeEach(async () => {
    // Create two users
    userACookie = await getTestAuthCookie('usera');
    userBCookie = await getTestAuthCookie('userb');
    
    const userA = await getUserByUsername('usera');
    const userB = await getUserByUsername('userb');
    
    userAId = userA.id;
    userBId = userB.id;
    userBDid = userB.did;
    
    // Create asset as User A
    const createResponse = await request(app)
      .post('/api/assets/create-with-did')
      .set('Cookie', userACookie)
      .field('title', 'Transfer Test Asset')
      .attach('mediaFile', Buffer.from('test'), 'test.png');
    
    assetId = createResponse.body.asset.id;
  });
  
  it('should transfer asset ownership', async () => {
    const response = await request(app)
      .post(`/api/assets/${assetId}/transfer`)
      .set('Cookie', userACookie)
      .send({
        recipientDid: userBDid,
        recipientUserId: userBId,
        notes: 'Gift for you!'
      })
      .expect(200);
    
    expect(response.body.asset.userId).toBe(userBId);
    expect(response.body.originalsAsset.currentOwner.did).toBe(userBDid);
  });
  
  it('should update provenance with transfer event', async () => {
    const response = await request(app)
      .post(`/api/assets/${assetId}/transfer`)
      .set('Cookie', userACookie)
      .send({
        recipientDid: userBDid,
        notes: 'Transfer test'
      })
      .expect(200);
    
    const provenance = response.body.asset.provenance;
    const transferEvent = provenance.events.find(e => e.type === 'transferred');
    
    expect(transferEvent).toBeDefined();
    expect(transferEvent.toDid).toBe(userBDid);
    expect(transferEvent.notes).toBe('Transfer test');
  });
  
  it('should prevent non-owner from transferring', async () => {
    // User B tries to transfer User A's asset
    const response = await request(app)
      .post(`/api/assets/${assetId}/transfer`)
      .set('Cookie', userBCookie)
      .send({
        recipientDid: 'did:webvh:example.com:userc'
      })
      .expect(403);
    
    expect(response.body.error).toContain('not own');
  });
  
  it('should prevent self-transfer', async () => {
    const userA = await storage.getUser(userAId);
    
    const response = await request(app)
      .post(`/api/assets/${assetId}/transfer`)
      .set('Cookie', userACookie)
      .send({
        recipientDid: userA.did,
        recipientUserId: userAId
      })
      .expect(400);
    
    expect(response.body.error).toContain('yourself');
  });
  
  it('should require recipientDid', async () => {
    await request(app)
      .post(`/api/assets/${assetId}/transfer`)
      .set('Cookie', userACookie)
      .send({ notes: 'Missing recipient' })
      .expect(400);
  });
  
  it('should validate DID format', async () => {
    await request(app)
      .post(`/api/assets/${assetId}/transfer`)
      .set('Cookie', userACookie)
      .send({ recipientDid: 'invalid-did' })
      .expect(400);
  });
  
  it('should allow multiple transfers', async () => {
    // A → B
    await request(app)
      .post(`/api/assets/${assetId}/transfer`)
      .set('Cookie', userACookie)
      .send({ recipientDid: userBDid })
      .expect(200);
    
    // Create User C
    const userCCookie = await getTestAuthCookie('userc');
    const userC = await getUserByUsername('userc');
    
    // B → C
    const response = await request(app)
      .post(`/api/assets/${assetId}/transfer`)
      .set('Cookie', userBCookie)
      .send({ recipientDid: userC.did })
      .expect(200);
    
    expect(response.body.asset.userId).toBe(userC.id);
    
    // Verify provenance has 2 transfers
    const transferEvents = response.body.asset.provenance.events
      .filter(e => e.type === 'transferred');
    expect(transferEvents.length).toBe(2);
  });
  
  it('should preserve all DIDs after transfer', async () => {
    const beforeTransfer = await storage.getAsset(assetId);
    
    await request(app)
      .post(`/api/assets/${assetId}/transfer`)
      .set('Cookie', userACookie)
      .send({ recipientDid: userBDid })
      .expect(200);
    
    const afterTransfer = await storage.getAsset(assetId);
    
    expect(afterTransfer?.didPeer).toBe(beforeTransfer?.didPeer);
    expect(afterTransfer?.didWebvh).toBe(beforeTransfer?.didWebvh);
    expect(afterTransfer?.didBtco).toBe(beforeTransfer?.didBtco);
    expect(afterTransfer?.currentLayer).toBe(beforeTransfer?.currentLayer);
  });
});

describe('GET /api/assets/:id/transfer-history', () => {
  it('should return transfer history', async () => {
    // ... setup: create asset, transfer A→B, transfer B→C ...
    
    const response = await request(app)
      .get(`/api/assets/${assetId}/transfer-history`)
      .set('Cookie', userCCookie)
      .expect(200);
    
    expect(response.body.totalTransfers).toBe(2);
    expect(response.body.transfers).toHaveLength(2);
    expect(response.body.transfers[0].fromUsername).toBe('usera');
    expect(response.body.transfers[0].toUsername).toBe('userb');
    expect(response.body.transfers[1].fromUsername).toBe('userb');
    expect(response.body.transfers[1].toUsername).toBe('userc');
  });
  
  it('should return empty array for never-transferred asset', async () => {
    const response = await request(app)
      .get(`/api/assets/${assetId}/transfer-history`)
      .set('Cookie', userACookie)
      .expect(200);
    
    expect(response.body.totalTransfers).toBe(0);
    expect(response.body.transfers).toHaveLength(0);
  });
});

describe('GET /api/assets/:id/verify-ownership', () => {
  it('should verify current owner', async () => {
    const response = await request(app)
      .get(`/api/assets/${assetId}/verify-ownership`)
      .expect(200);
    
    expect(response.body.currentOwner.userId).toBe(userAId);
    expect(response.body.currentOwner.username).toBe('usera');
    expect(response.body.transferCount).toBe(0);
  });
  
  it('should update after transfer', async () => {
    await request(app)
      .post(`/api/assets/${assetId}/transfer`)
      .set('Cookie', userACookie)
      .send({ recipientDid: userBDid });
    
    const response = await request(app)
      .get(`/api/assets/${assetId}/verify-ownership`)
      .expect(200);
    
    expect(response.body.currentOwner.userId).toBe(userBId);
    expect(response.body.transferCount).toBe(1);
  });
});
```

### 2. Frontend Component Tests

Create: `apps/originals-explorer/client/src/pages/__tests__/transfer-ui.test.tsx`

```typescript
import { describe, it, expect } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AssetDetailPage from '../asset-detail';

describe('Transfer Ownership UI', () => {
  beforeEach(() => {
    global.fetch = jest.fn((url) => {
      if (url.includes('/api/assets/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            id: 'test-asset',
            title: 'Test Asset',
            userId: 'current-user-id',
            currentLayer: 'did:peer'
          })
        });
      }
      if (url.includes('/users/by-username')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            id: 'recipient-id',
            username: 'recipient',
            did: 'did:webvh:example.com:recipient'
          })
        });
      }
    });
  });
  
  it('should show transfer button for owned assets', async () => {
    render(<AssetDetailPage assetId="test-asset" currentUserId="current-user-id" />);
    
    await waitFor(() => {
      expect(screen.getByText(/transfer ownership/i)).toBeInTheDocument();
    });
  });
  
  it('should not show transfer button for non-owned assets', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          userId: 'other-user-id' // Different from current user
        })
      })
    );
    
    render(<AssetDetailPage assetId="test-asset" currentUserId="current-user-id" />);
    
    await waitFor(() => {
      expect(screen.queryByText(/transfer ownership/i)).not.toBeInTheDocument();
    });
  });
  
  it('should open transfer modal on button click', async () => {
    render(<AssetDetailPage assetId="test-asset" currentUserId="current-user-id" />);
    
    await waitFor(() => screen.getByText(/transfer ownership/i));
    await userEvent.click(screen.getByText(/transfer ownership/i));
    
    expect(screen.getByText(/transfer asset ownership/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/enter username/i)).toBeInTheDocument();
  });
  
  it('should search for recipient', async () => {
    render(<AssetDetailPage assetId="test-asset" currentUserId="current-user-id" />);
    
    await waitFor(() => screen.getByText(/transfer ownership/i));
    await userEvent.click(screen.getByText(/transfer ownership/i));
    
    const input = screen.getByPlaceholderText(/enter username/i);
    await userEvent.type(input, 'recipient');
    await userEvent.click(screen.getByText(/find/i));
    
    await waitFor(() => {
      expect(screen.getByText(/recipient found/i)).toBeInTheDocument();
      expect(screen.getByText('recipient')).toBeInTheDocument();
    });
  });
  
  it('should call transfer API on confirm', async () => {
    const transferMock = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          asset: { userId: 'recipient-id' }
        })
      })
    );
    
    global.fetch = jest.fn((url, options) => {
      if (url.includes('/transfer') && options?.method === 'POST') {
        return transferMock();
      }
      // ... other mocks
    });
    
    // ... render, search recipient, click transfer ...
    
    await waitFor(() => {
      expect(transferMock).toHaveBeenCalled();
    });
  });
  
  it('should display transfer history', async () => {
    global.fetch = jest.fn((url) => {
      if (url.includes('/transfer-history')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            totalTransfers: 2,
            transfers: [
              { fromUsername: 'alice', toUsername: 'bob', timestamp: '2024-01-01' },
              { fromUsername: 'bob', toUsername: 'charlie', timestamp: '2024-01-02' }
            ]
          })
        });
      }
      // ... other mocks
    });
    
    render(<AssetDetailPage assetId="test-asset" />);
    
    await waitFor(() => {
      expect(screen.getByText(/transfer history/i)).toBeInTheDocument();
      expect(screen.getByText('alice → bob')).toBeInTheDocument();
      expect(screen.getByText('bob → charlie')).toBeInTheDocument();
    });
  });
});
```

### 3. E2E Integration Test

Create: `apps/originals-explorer/__tests__/integration/transfer-flow.test.ts`

```typescript
import { describe, it, expect } from 'bun:test';
import { chromium } from 'playwright';

describe('Asset Transfer E2E', () => {
  it('should complete full transfer flow', async () => {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    
    // Login as User A
    await page.goto('http://localhost:5000/login');
    await page.fill('[name="username"]', 'usera');
    await page.fill('[name="password"]', 'password');
    await page.click('button[type="submit"]');
    
    // Create asset
    await page.goto('http://localhost:5000/create');
    await page.fill('[name="title"]', 'Transfer Test Asset');
    await page.setInputFiles('input[type="file"]', {
      name: 'test.png',
      mimeType: 'image/png',
      buffer: Buffer.from('test')
    });
    await page.click('button:has-text("Create")');
    
    // Wait for success and go to asset
    await page.waitForSelector('text=Asset Created Successfully');
    await page.click('text=View Asset');
    
    // Verify owner is User A
    await page.waitForSelector('text=Transfer Ownership');
    
    // Click transfer
    await page.click('button:has-text("Transfer Ownership")');
    
    // Modal opens
    await page.waitForSelector('text=Transfer Asset Ownership');
    
    // Search for User B
    await page.fill('input[placeholder*="username"]', 'userb');
    await page.click('button:has-text("Find")');
    
    // Wait for recipient found
    await page.waitForSelector('text=Recipient Found');
    
    // Add notes
    await page.fill('textarea', 'Gifting this to you!');
    
    // Confirm transfer
    await page.click('button:has-text("Transfer Asset")');
    
    // Wait for success
    await page.waitForSelector('text=Transfer Successful', { timeout: 10000 });
    
    // Should redirect to dashboard
    await page.waitForURL('**/dashboard');
    
    // Logout
    await page.click('button:has-text("Logout")');
    
    // Login as User B
    await page.goto('http://localhost:5000/login');
    await page.fill('[name="username"]', 'userb');
    await page.fill('[name="password"]', 'password');
    await page.click('button[type="submit"]');
    
    // Go to dashboard
    await page.goto('http://localhost:5000/dashboard');
    
    // Verify asset now appears in User B's assets
    await page.waitForSelector('text=Transfer Test Asset');
    
    // Click on asset
    await page.click('text=Transfer Test Asset');
    
    // Verify User B is owner (transfer button should be visible)
    await page.waitForSelector('text=Transfer Ownership');
    
    // Check transfer history
    await page.waitForSelector('text=Transfer History');
    expect(await page.textContent('text=usera → userb')).toBeTruthy();
    
    await browser.close();
  });
});
```

---

## Validation Checklist

- [ ] All backend transfer tests pass
- [ ] Frontend UI tests pass
- [ ] E2E integration test passes
- [ ] Transfer history tested
- [ ] Ownership verification tested
- [ ] Authorization checked
- [ ] Self-transfer prevented
- [ ] Multiple transfers work
- [ ] Coverage > 80%

---

## Running Tests

```bash
# Backend
bun test server/__tests__/transfer-ownership.test.ts

# Frontend
bun test client/src/pages/__tests__/transfer-ui.test.tsx

# E2E
bun test __tests__/integration/transfer-flow.test.ts

# All tests
bun test
```

---

## Success Criteria

✅ Task is complete when:
1. All backend tests pass
2. Frontend tests pass
3. E2E test passes
4. Transfer history validated
5. Ownership changes verified
6. Authorization tested
7. Multi-transfer scenarios work
8. Coverage adequate
9. Tests are maintainable

---

## 🎉 All Tasks Complete!

After completing this task, all major features of the asset migration system are implemented and tested:

- ✅ **Asset Creation** (BE-01, FE-01, TEST-01)
- ✅ **Publish to Web** (BE-02, FE-02, TEST-02)
- ✅ **Inscribe on Bitcoin** (BE-03, FE-03, TEST-03)
- ✅ **Transfer Ownership** (BE-04, FE-04, TEST-04)

The system now supports the complete asset lifecycle:
1. Create asset (did:peer)
2. Publish to web (did:webvh)
3. Inscribe on Bitcoin (did:btco)
4. Transfer ownership at any layer
5. Full provenance tracking
6. Verifiable credentials
