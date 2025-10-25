# Playwright E2E Testing Setup for Turnkey Authentication

This document describes the Playwright end-to-end testing setup for the Originals Explorer application's Turnkey authentication flow.

## What Was Added

### 1. Test Configuration
- **File**: `playwright.config.ts`
- Configures Playwright to test the Originals Explorer app
- Sets up web server auto-start before tests
- Configures browser projects (Chromium by default)
- Sets base URL to `http://localhost:5001`

### 2. Test Suites

#### auth-login.spec.ts
Tests the complete Turnkey login flow:
- Login page UI rendering
- Email validation (empty and invalid emails)
- Successful login with valid email
- Authentication persistence after page reload
- Concurrent logins with different users
- Loading states during login
- Return path handling after login
- Turnkey sub-organization creation
- Sub-organization reuse for returning users

#### auth-logout.spec.ts
Tests logout functionality:
- Successful logout flow
- Cookie cleanup after logout
- Protected route access prevention after logout
- Session data cleanup
- Expired JWT token handling
- Missing auth cookie handling

#### auth-protected-routes.spec.ts
Tests access control and authorization:
- Public vs protected routes
- API endpoint authentication
- DID endpoint protection
- User data isolation between different users
- Asset ownership verification
- API error handling (404s, validation errors)
- Authorization checks

### 3. Documentation
- **File**: `__tests__/e2e/README.md`
- Comprehensive guide for running and debugging tests
- Setup instructions
- Test structure explanation
- Troubleshooting guide
- CI/CD integration examples

### 4. Package Scripts
Added to `package.json`:
- `test:e2e` - Run all tests
- `test:e2e:ui` - Run tests with Playwright UI
- `test:e2e:headed` - Run tests in headed mode (visible browser)
- `test:e2e:debug` - Run tests with debugger
- `test:e2e:report` - View test report

### 5. Environment Configuration
- Created `.env` file with test configuration
- JWT secret for token generation
- Turnkey credentials placeholders
- DID domain configuration
- Playwright base URL

## Architecture

### Authentication Flow Tested

```
User Login:
1. User enters email on /login
2. Server calls Turnkey API to create/retrieve sub-organization
3. Server generates JWT token with Turnkey sub-org ID
4. Server sets HTTP-only cookie with JWT
5. User redirected to homepage

Protected Routes:
1. Browser sends cookie with each request
2. Server middleware verifies JWT
3. Server extracts Turnkey sub-org ID from token
4. Server loads/creates user record
5. User data attached to request
6. Route handler processes authenticated request
```

### Key Security Features Tested

1. **HTTP-only Cookies**: JWT tokens are not accessible via JavaScript
2. **SameSite Protection**: Cookies set with `SameSite=Strict`
3. **User Isolation**: Each user has separate Turnkey sub-organization
4. **Automatic DID Creation**: did:webvh created on first login
5. **Session Management**: Proper logout and token expiration

## Test Coverage

### What Is Tested

✅ Login page rendering and validation
✅ Email-based authentication flow
✅ Turnkey sub-organization creation
✅ JWT token issuance in HTTP-only cookies
✅ Authentication persistence across page reloads
✅ Concurrent user sessions
✅ Protected route access control
✅ User data isolation
✅ DID creation on first login
✅ Logout and session cleanup
✅ Cookie security properties
✅ API error handling

### What Is Not Tested (Yet)

❌ Asset creation and management
❌ Publishing assets to web (did:peer → did:webvh)
❌ DID document resolution
❌ Verifiable credential signing
❌ Google Drive import
❌ Spreadsheet upload
❌ Mobile viewports
❌ Cross-browser compatibility (Firefox, Safari)
❌ Performance benchmarks

## Running the Tests

### Prerequisites

1. Install dependencies:
   ```bash
   cd /home/user/sdk
   npm install
   ```

2. Install Playwright browsers:
   ```bash
   npx playwright install
   ```

3. Set up Turnkey credentials in `.env`:
   ```bash
   cd apps/originals-explorer
   cp .env.example .env
   # Edit .env with your Turnkey credentials
   ```

### Run Tests

From the `apps/originals-explorer` directory:

```bash
# Run all tests
npm run test:e2e

# Run with UI
npm run test:e2e:ui

# Run in headed mode
npm run test:e2e:headed

# Debug tests
npm run test:e2e:debug

# View report
npm run test:e2e:report
```

## Test Data Management

- Each test creates unique users: `test-{timestamp}@example.com`
- Tests are currently stateless (no cleanup between runs)
- For CI, consider adding test data cleanup hooks

## CI/CD Integration

The tests are ready for CI/CD with these considerations:

1. Set Turnkey credentials as environment secrets
2. Run `npx playwright install --with-deps` in CI setup
3. Tests run sequentially to avoid authentication conflicts
4. Automatic retries on CI (configured to retry 2 times)

Example for GitHub Actions:

```yaml
- name: Install dependencies
  run: npm ci

- name: Install Playwright Browsers
  run: npx playwright install --with-deps

- name: Run E2E Tests
  run: npm run test:e2e
  env:
    TURNKEY_ORGANIZATION_ID: ${{ secrets.TURNKEY_ORGANIZATION_ID }}
    TURNKEY_API_PUBLIC_KEY: ${{ secrets.TURNKEY_API_PUBLIC_KEY }}
    TURNKEY_API_PRIVATE_KEY: ${{ secrets.TURNKEY_API_PRIVATE_KEY }}
    JWT_SECRET: ${{ secrets.JWT_SECRET }}

- name: Upload test results
  if: failure()
  uses: actions/upload-artifact@v3
  with:
    name: playwright-report
    path: apps/originals-explorer/playwright-report/
```

## Debugging Tips

### View test execution in browser
```bash
npm run test:e2e:headed
```

### Use Playwright Inspector
```bash
npm run test:e2e:debug
```

### Check screenshots and videos
After test failures, check:
- `playwright-report/` - HTML report with screenshots
- `test-results/` - Detailed test artifacts

### Enable verbose logging
```bash
DEBUG=pw:api npm run test:e2e
```

## Next Steps

1. **Add Asset Management Tests**: Test creating, publishing, and managing assets
2. **Add DID Operation Tests**: Test DID resolution and updates
3. **Add Import Flow Tests**: Test Google Drive and spreadsheet imports
4. **Add Visual Regression Tests**: Ensure UI consistency
5. **Add Performance Tests**: Monitor authentication flow performance
6. **Add Mobile Tests**: Test responsive design
7. **Add Cross-Browser Tests**: Enable Firefox and Safari

## Troubleshooting

### Server won't start
- Check that port 5001 is available
- Verify all dependencies are installed
- Check that `.env` file exists with correct values

### Turnkey API errors
- Verify credentials in `.env`
- Check Turnkey organization is active
- Ensure API keys have correct permissions

### Cookie-related failures
- Check browser context configuration
- Verify `credentials: 'include'` in API calls
- Confirm HTTP-only cookie settings in server

### Timeout errors
- Increase timeouts in `playwright.config.ts`
- Check server startup time
- Verify network connectivity

## Additional Resources

- [Playwright Documentation](https://playwright.dev)
- [Turnkey Documentation](https://docs.turnkey.com)
- [Test README](./__tests__/e2e/README.md)
- [Migration Status](../../TURNKEY_MIGRATION_V2_STATUS.md)
