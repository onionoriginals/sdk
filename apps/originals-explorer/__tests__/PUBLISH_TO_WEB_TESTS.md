# Publish to Web Tests Documentation

This document describes the comprehensive test suite for the publish-to-web flow.

## Overview

The test suite covers three layers:
1. **Backend API Tests** - Tests for the `/api/assets/:id/publish-to-web` endpoint
2. **Frontend Component Tests** - Tests for the publish UI components
3. **E2E Integration Tests** - End-to-end tests for the complete flow

## Test Files

### 1. Backend API Tests
**Location**: `apps/originals-explorer/server/__tests__/publish-to-web.test.ts`

**Coverage**:
- ✅ Publishing asset from did:peer to did:webvh
- ✅ Provenance update with publish event
- ✅ DID document public resolution
- ✅ Rejection of already-published assets
- ✅ Authorization checks (user ownership)
- ✅ Asset not found handling
- ✅ Unauthenticated request rejection
- ✅ Custom domain support
- ✅ Preservation of asset data
- ✅ Resolver URL generation
- ✅ SDK error handling
- ✅ Layer tracking updates
- ✅ WebVH binding creation
- ✅ Credential issuance
- ✅ Concurrent publish request handling

**Test Count**: 15 tests

**Run Command**:
```bash
bun test apps/originals-explorer/server/__tests__/publish-to-web.test.ts
```

### 2. Frontend Component Tests
**Location**: `apps/originals-explorer/client/src/pages/__tests__/publish-to-web.test.tsx`

**Coverage**:
- ✅ Show publish button for did:peer assets
- ✅ Hide publish button for did:webvh assets
- ✅ Hide publish button for did:btco assets
- ✅ Show confirmation modal
- ✅ Cancel publish in modal
- ✅ API call on publish confirmation
- ✅ Success state display
- ✅ Resolver URL link display
- ✅ API error handling
- ✅ Loading state during publish
- ✅ Display did:webvh after publish
- ✅ Layer badge update
- ✅ Hide button for non-owned assets
- ✅ Authorization error handling
- ✅ Disable button while publishing
- ✅ Explanation of publishing

**Test Count**: 16 tests

**Run Command**:
```bash
bun test apps/originals-explorer/client/src/pages/__tests__/publish-to-web.test.tsx
```

### 3. E2E Integration Tests
**Location**: `apps/originals-explorer/__tests__/integration/publish-flow.test.ts`

**Coverage**:
- ✅ Complete publish flow (create → publish → verify)
- ✅ Prevent publishing already-published asset
- ✅ Handle publish errors gracefully
- ✅ Show loading state during publish
- ✅ Resolve published DID document
- ✅ Show provenance history
- ✅ Handle unauthorized publish attempts
- ✅ Preserve asset data after publish

**Test Count**: 8 tests

**Run Command**:
```bash
bun test apps/originals-explorer/__tests__/integration/publish-flow.test.ts
```

**Prerequisites**:
- Server running on localhost:5000
- Privy authentication configured
- Test user credentials available

## Running All Tests

### Individual Test Suites
```bash
# Backend tests
bun test apps/originals-explorer/server/__tests__/publish-to-web.test.ts

# Frontend tests
bun test apps/originals-explorer/client/src/pages/__tests__/publish-to-web.test.tsx

# E2E tests
bun test apps/originals-explorer/__tests__/integration/publish-flow.test.ts
```

### All Tests
```bash
bun test
```

### With Coverage
```bash
bun test --coverage
```

## Test Patterns

### Backend Test Pattern
```typescript
it('should publish asset from did:peer to did:webvh', async () => {
  const response = await makeAuthRequest(
    serverUrl,
    'POST',
    `/api/assets/${peerAssetId}/publish-to-web`,
    testUser.did,
    {}
  );

  expect(response.status).toBe(200);
  const body = await response.json();
  
  expect(body.asset.currentLayer).toBe('did:webvh');
  expect(body.asset.didWebvh).toMatch(/^did:webvh:/);
  expect(body.asset.didPeer).toBeTruthy();
});
```

### Frontend Test Pattern
```typescript
it('should call API when publish confirmed', async () => {
  await renderAssetDetailPage();
  
  const publishButton = await screen.findByText(/publish to web/i);
  await user.click(publishButton);
  
  const confirmButton = await screen.findByRole('button', { name: /^publish/i });
  await user.click(confirmButton);
  
  await waitFor(() => {
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringMatching(/success/i),
      })
    );
  });
});
```

### E2E Test Pattern
```typescript
it('should complete full publish flow', async () => {
  // Login
  await page.goto(`${BASE_URL}/login`);
  // ... authenticate
  
  // Create asset
  await page.goto(`${BASE_URL}/create`);
  // ... fill form and submit
  
  // Publish asset
  await page.locator('button:has-text("Publish to Web")').click();
  await page.locator('button:has-text("Publish to Web")').last().click();
  
  // Verify success
  await page.waitForSelector('text=/Published to Web/i');
});
```

## Test Dependencies

The tests depend on:
- **bun:test** - Test runner
- **@testing-library/react** - Component testing
- **@tanstack/react-query** - Query client for tests
- **playwright** - E2E browser automation
- **Test helpers** - Located in `__tests__/helpers/test-helpers.ts`

## Expected Test Behavior

### When Implementation Doesn't Exist
Tests will fail with appropriate errors indicating missing:
- API endpoints (`404 Not Found`)
- UI components (`Component not found`)
- Routes (`404 Not Found`)

This is expected and tests serve as specifications for implementation.

### When Implementation Exists
All tests should pass, demonstrating:
- ✅ API correctly handles publish requests
- ✅ UI correctly displays publish functionality
- ✅ E2E flow works end-to-end
- ✅ Error cases are handled properly
- ✅ Authorization is enforced
- ✅ Layer transitions are tracked
- ✅ Provenance is updated correctly

## Coverage Goals

Target coverage for publish-to-web functionality:
- **Line Coverage**: > 80%
- **Branch Coverage**: > 75%
- **Function Coverage**: > 80%

## Validation Checklist

Before marking tests as complete, verify:

- [x] All backend API tests written
- [x] All frontend component tests written
- [x] All E2E integration tests written
- [ ] Tests cover success paths
- [ ] Tests cover error cases
- [ ] Tests verify layer transitions
- [ ] Tests verify DID resolution
- [ ] Tests verify authorization
- [ ] Tests run consistently (not flaky)
- [ ] Coverage meets goals

## CI/CD Integration

Tests should be run in CI/CD pipeline:

```yaml
# Example GitHub Actions workflow
name: Publish to Web Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1
      - run: bun install
      - run: bun test server/__tests__/publish-to-web.test.ts
      - run: bun test client/src/pages/__tests__/publish-to-web.test.tsx
      - run: bun test __tests__/integration/publish-flow.test.ts
```

## Troubleshooting

### Tests Fail with "Component not found"
**Solution**: The implementation (endpoint/component) doesn't exist yet. This is expected for TEST-02 when TASK_BE02 and TASK_FE02 are not yet complete.

### Tests Fail with "Mock not working"
**Solution**: Check mock setup in `beforeEach`. Ensure mocks are cleared between tests.

### E2E Tests Timeout
**Solution**: 
- Verify server is running on localhost:5000
- Check Playwright is installed: `bunx playwright install`
- Increase timeout in test config

### Authentication Errors
**Solution**: 
- Verify test user credentials are configured
- Check Privy mock setup in test helpers
- Ensure test environment variables are set

## Related Documentation

- [Asset Creation Tests](../server/__tests__/asset-creation.test.ts) - Reference implementation
- [Test Helpers](./helpers/test-helpers.ts) - Utility functions
- [E2E Test Guide](./README.md) - General E2E testing patterns

## Notes

These tests serve as both:
1. **Specifications** for the publish-to-web feature implementation
2. **Validation** that the implementation works correctly

Tests follow TDD (Test-Driven Development) principles where tests are written first, then implementation follows to make tests pass.

## Success Criteria

✅ Task TEST-02 is complete when:
1. All tests are written (Backend, Frontend, E2E)
2. All tests pass consistently
3. Edge cases are covered
4. Error scenarios are tested
5. E2E flow works end-to-end
6. Test coverage is adequate (>80%)
7. Tests are maintainable and well-documented
