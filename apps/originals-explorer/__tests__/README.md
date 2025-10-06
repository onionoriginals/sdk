# Asset Creation Tests

Comprehensive test suite for the asset creation flow with DID integration.

## Test Structure

```
__tests__/
├── helpers/
│   └── test-helpers.ts       # Shared test utilities
├── integration/
│   └── asset-creation-flow.test.ts  # E2E tests with Playwright
└── README.md

server/__tests__/
└── asset-creation.test.ts    # Backend API tests

client/src/pages/__tests__/
└── create-asset-simple.test.tsx  # Frontend component tests
```

## Prerequisites

### Required Dependencies

Install testing dependencies:

```bash
# For frontend tests
bun add -d @testing-library/react @testing-library/user-event @testing-library/jest-dom happy-dom

# For E2E tests  
bun add -d playwright
bunx playwright install chromium
```

### Environment Setup

Create a `.env.test` file:

```bash
# Test environment variables
TEST_BASE_URL=http://localhost:5000
TEST_USER_EMAIL=test@example.com
PRIVY_APP_ID=your-test-privy-app-id
PRIVY_APP_SECRET=your-test-privy-app-secret
DID_DOMAIN=localhost:5000
```

## Running Tests

### All Tests

```bash
cd apps/originals-explorer
bun test
```

### Backend API Tests Only

```bash
bun test server/__tests__/asset-creation.test.ts
```

### Frontend Component Tests Only

```bash
bun test client/src/pages/__tests__/create-asset-simple.test.tsx
```

### E2E Integration Tests Only

```bash
# Make sure the server is running first
bun run dev &
sleep 5  # Wait for server to start

# Run E2E tests
bun test __tests__/integration/asset-creation-flow.test.ts
```

### With Coverage

```bash
bun test --coverage
```

### Watch Mode

```bash
bun test --watch
```

## Test Coverage Goals

- **Backend API Tests**: >85% coverage of `/api/assets/create-with-did` endpoint
- **Frontend Tests**: >80% coverage of `create-asset-simple.tsx` component
- **E2E Tests**: Critical user flows validated end-to-end

## Test Scenarios

### Backend API Tests (`asset-creation.test.ts`)

✅ Create asset with file upload
✅ Create asset with media URL
✅ Reject request without media
✅ Reject request without title
✅ Reject invalid file type
✅ Reject file too large (>10MB)
✅ Reject unauthenticated request
✅ Store correct layer tracking fields (did:peer, currentLayer, etc.)
✅ Generate valid provenance chain
✅ Handle SDK errors gracefully
✅ Parse tags correctly
✅ Validate URL safety (reject localhost, private IPs)
✅ Handle metadata correctly
✅ Multiple concurrent asset creations

### Frontend Component Tests (`create-asset-simple.test.tsx`)

✅ Render form fields correctly
✅ Render asset type selector
✅ Show file upload area
✅ Display custom properties when asset type selected
✅ Validate required fields on submit
✅ Handle file selection
✅ Submit form with valid data
✅ Display error when API fails
✅ Disable submit button while uploading
✅ Parse tags from comma-separated string
✅ Show authentication required message
✅ Navigate back to dashboard
✅ Accept multiple file types
✅ Include custom properties in asset data

### E2E Integration Tests (`asset-creation-flow.test.ts`)

✅ Complete asset creation flow with authentication
✅ Form validation before submission
✅ File upload error handling
✅ Form data persistence on navigation
✅ Loading state during asset creation
✅ Different media types (images, videos, etc.)
✅ Oversized file rejection

## Test Data

Tests use mock data and temporary test users:
- Test users are created with unique DIDs: `did:webvh:localhost%3A5000:test-{timestamp}`
- Test assets are created with `did:peer` identifiers
- File uploads use small test buffers (1KB)

## Debugging Tests

### Enable Verbose Logging

```bash
DEBUG=* bun test
```

### Run Tests in Headed Mode (E2E)

```bash
CI=false bun test __tests__/integration/asset-creation-flow.test.ts
```

### Generate Test Report

```bash
bun test --reporter=json > test-results.json
```

## Continuous Integration

Tests are configured to run in CI/CD pipelines:

```yaml
# Example GitHub Actions workflow
- name: Run Tests
  run: |
    cd apps/originals-explorer
    bun install
    bun test --coverage
```

## Common Issues

### Issue: "Port already in use"
**Solution**: Kill the existing server process or use a different port

```bash
pkill -f "bun.*server"
bun run dev
```

### Issue: "Privy authentication fails"
**Solution**: Ensure test Privy credentials are configured in `.env.test`

### Issue: "Playwright browser not found"
**Solution**: Install Playwright browsers

```bash
bunx playwright install chromium
```

### Issue: "Storage not found errors"
**Solution**: Ensure MemStorage is properly initialized in tests

## Best Practices

1. **Isolation**: Each test should be independent and not rely on state from other tests
2. **Cleanup**: Clean up test data after each test (though MemStorage handles this automatically)
3. **Mocking**: Mock external dependencies (Privy, Originals SDK where appropriate)
4. **Timeouts**: Use reasonable timeouts for async operations (default: 30s for E2E)
5. **Assertions**: Use specific assertions that validate behavior, not implementation details

## Contributing

When adding new tests:

1. Follow the existing test structure
2. Add descriptive test names using `it('should...')`
3. Use test helpers from `__tests__/helpers/test-helpers.ts`
4. Update this README with new test scenarios
5. Ensure tests pass locally before committing

## Support

For issues or questions about tests:
- Check the test output for detailed error messages
- Review the test helpers in `__tests__/helpers/test-helpers.ts`
- Consult the main README for project setup instructions
