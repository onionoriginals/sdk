# Originals Explorer E2E Tests

Playwright end-to-end tests for the Originals Explorer application, focusing on Turnkey authentication and user workflows.

## Setup

### Prerequisites

1. **Turnkey Account**: You need a Turnkey account to run these tests. Sign up at [https://app.turnkey.com](https://app.turnkey.com)

2. **Environment Variables**: Copy `.env.example` to `.env` and fill in your Turnkey credentials:
   ```bash
   cp .env.example .env
   ```

   Required variables:
   - `TURNKEY_ORGANIZATION_ID`: Your Turnkey organization ID
   - `TURNKEY_API_PUBLIC_KEY`: Your Turnkey API public key
   - `TURNKEY_API_PRIVATE_KEY`: Your Turnkey API private key
   - `JWT_SECRET`: A secure random string (generate with `openssl rand -base64 32`)

3. **Install Playwright Browsers** (first time only):
   ```bash
   npx playwright install
   ```

## Running Tests

### Run all tests
```bash
npm run test:e2e
```

### Run tests with UI
```bash
npm run test:e2e:ui
```

### Run tests in headed mode (see browser)
```bash
npm run test:e2e:headed
```

### Run tests in debug mode
```bash
npm run test:e2e:debug
```

### View test report
```bash
npm run test:e2e:report
```

### Run specific test file
```bash
npx playwright test auth-login.spec.ts
```

### Run tests matching a pattern
```bash
npx playwright test --grep "login"
```

## Test Structure

### Test Files

- **auth-login.spec.ts**: Tests for the login flow
  - Login page display
  - Email validation
  - Successful login
  - Authentication persistence
  - Concurrent sessions
  - Turnkey sub-organization creation

- **auth-logout.spec.ts**: Tests for the logout flow
  - Logout functionality
  - Session cleanup
  - Protected route access after logout
  - Token expiration handling

- **auth-protected-routes.spec.ts**: Tests for access control
  - Public vs protected routes
  - API endpoint authentication
  - User data isolation
  - Authorization checks

## Authentication Flow

The tests verify the following Turnkey authentication flow:

1. **User Login**:
   - User enters email on login page
   - Server creates or retrieves Turnkey sub-organization for the user
   - Server issues JWT token in HTTP-only cookie
   - User is redirected to homepage

2. **Authentication State**:
   - JWT token stored in secure HTTP-only cookie
   - Token includes Turnkey sub-org ID and email
   - Token validated on each protected route access

3. **DID Creation**:
   - On first login, a did:webvh is automatically created
   - DID document is stored with user record
   - Keys are managed via Turnkey

4. **User Isolation**:
   - Each user has their own Turnkey sub-organization
   - Assets and data are isolated per user
   - No cross-user data access

## Test Data

- Tests create unique test users with timestamps: `test-{timestamp}@example.com`
- Each test run uses fresh users to avoid conflicts
- No test data cleanup is currently implemented (TODO)

## Debugging

### View browser during test execution
```bash
npm run test:e2e:headed
```

### Step through tests with debugger
```bash
npm run test:e2e:debug
```

### Check screenshots and videos
After a test failure, check:
- `playwright-report/` for HTML report
- `test-results/` for screenshots and videos

### Enable verbose logging
```bash
DEBUG=pw:api npm run test:e2e
```

## CI/CD Integration

These tests can be run in CI with the following considerations:

1. **Environment Variables**: Set Turnkey credentials as secrets
2. **Browser Installation**: Run `npx playwright install` in CI setup
3. **Parallel Execution**: Tests are configured to run sequentially to avoid auth conflicts
4. **Retries**: Tests retry twice on CI for flaky network conditions

Example GitHub Actions:
```yaml
- name: Install Playwright Browsers
  run: npx playwright install --with-deps

- name: Run E2E Tests
  run: npm run test:e2e
  env:
    TURNKEY_ORGANIZATION_ID: ${{ secrets.TURNKEY_ORGANIZATION_ID }}
    TURNKEY_API_PUBLIC_KEY: ${{ secrets.TURNKEY_API_PUBLIC_KEY }}
    TURNKEY_API_PRIVATE_KEY: ${{ secrets.TURNKEY_API_PRIVATE_KEY }}
    JWT_SECRET: ${{ secrets.JWT_SECRET }}
```

## Troubleshooting

### "Server not ready" errors
- Ensure the dev server is not already running on port 5001
- Check that `npm run dev` can start the server successfully
- Increase `webServer.timeout` in playwright.config.ts if needed

### "Login failed" errors
- Verify Turnkey credentials in .env
- Check that Turnkey organization is active
- Ensure JWT_SECRET is set
- Check server logs for detailed errors

### "Cookie not found" errors
- Browser context may not be preserving cookies
- Check that `credentials: 'include'` is set in fetch calls
- Verify HTTP-only cookie settings in server

### Flaky tests
- Tests may be timing-dependent
- Increase timeouts in test files if needed
- Check for race conditions in authentication flow

## Future Improvements

- [ ] Add test data cleanup
- [ ] Mock Turnkey API for offline testing
- [ ] Add visual regression tests
- [ ] Test mobile viewports
- [ ] Add performance benchmarks
- [ ] Test with different JWT expiration times
- [ ] Add tests for DID operations (publish to web, etc.)
