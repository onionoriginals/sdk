# E2E Tests with Playwright

This directory contains end-to-end (E2E) tests using [Playwright](https://playwright.dev/).

## Prerequisites

1. Install dependencies:
   ```bash
   npm install
   ```

2. Install Playwright browsers (only needed once):
   ```bash
   npx playwright install
   ```

## Running Tests

Run all E2E tests:
```bash
npm run test:e2e
```

Run tests in UI mode (interactive):
```bash
npm run test:e2e:ui
```

Run tests in headed mode (see the browser):
```bash
npm run test:e2e:headed
```

Run tests in debug mode:
```bash
npm run test:e2e:debug
```

## Writing Tests

Tests are written using Playwright's test runner. Here's a basic example:

```typescript
import { test, expect } from '@playwright/test';

test('example test', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page).toHaveTitle(/Example/);
});
```

## Test Structure

- `*.spec.ts` - Test files
- Playwright automatically discovers all `*.spec.ts` files in this directory

## Configuration

The Playwright configuration is in `playwright.config.ts` at the root of the project.

Key settings:
- **testDir**: `./tests/e2e`
- **Browsers**: Chromium, Firefox, WebKit
- **Reporter**: HTML report (view with `npx playwright show-report`)

## Best Practices

1. Use data-testid attributes for reliable selectors
2. Use page object models for complex pages
3. Keep tests independent and isolated
4. Use fixtures for setup/teardown
5. Run tests in parallel when possible

## Debugging

To debug a specific test:
```bash
npx playwright test --debug example.spec.ts
```

To view the last test report:
```bash
npx playwright show-report
```

## CI/CD

The tests are configured to run in CI with:
- Retries: 2
- Workers: 1 (sequential)
- Fail on `.only` tests

## Resources

- [Playwright Documentation](https://playwright.dev/docs/intro)
- [Playwright Best Practices](https://playwright.dev/docs/best-practices)
- [Playwright API Reference](https://playwright.dev/docs/api/class-playwright)
