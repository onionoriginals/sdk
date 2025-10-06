# Quick Test Guide - Asset Creation Tests

## 🚀 Quick Start

### 1. Install Dependencies (First Time Only)

```bash
cd apps/originals-explorer

# Install frontend testing libraries
bun add -d @testing-library/react @testing-library/user-event @testing-library/jest-dom happy-dom

# Install E2E testing with Playwright
bun add -d playwright
bunx playwright install chromium
```

### 2. Run All Tests

```bash
bun test
```

### 3. Run Specific Test Suites

```bash
# Backend API Tests
bun test server/__tests__/asset-creation.test.ts

# Frontend Component Tests
bun test client/src/pages/__tests__/create-asset-simple.test.tsx

# E2E Integration Tests (requires server running)
bun test __tests__/integration/asset-creation-flow.test.ts
```

## 📊 Test Coverage

```bash
# Generate coverage report
bun test --coverage

# View coverage in browser
open coverage/index.html
```

## 🐛 Debugging Tests

### Run Single Test

```bash
bun test --test-name-pattern "should create asset with file upload"
```

### Verbose Output

```bash
bun test --verbose
```

### Watch Mode

```bash
bun test --watch
```

## 🎯 Test File Locations

```text
apps/originals-explorer/
├── server/__tests__/
│   └── asset-creation.test.ts          # Backend API tests (14 cases)
├── client/src/pages/__tests__/
│   └── create-asset-simple.test.tsx    # Frontend tests (14 cases)
├── __tests__/
│   ├── integration/
│   │   └── asset-creation-flow.test.ts # E2E tests (8 scenarios)
│   └── helpers/
│       └── test-helpers.ts             # Test utilities
└── __tests__/README.md                 # Full documentation
```

## ✅ Expected Results

When all tests pass, you should see:

```text
✓ Backend API Tests: 14/14 passed
✓ Frontend Component Tests: 14/14 passed
✓ E2E Integration Tests: 8/8 passed
✓ Total: 36/36 tests passed
```

## 🔧 Common Issues

### Issue: "Cannot find module"
**Solution**: Run `bun install` to ensure all dependencies are installed

### Issue: "Port already in use" (E2E tests)
**Solution**: 
```bash
# Kill existing server
pkill -f "bun.*server"
# Start fresh server
bun run dev &
```

### Issue: "Playwright browser not found"
**Solution**: 
```bash
bunx playwright install chromium
```

### Issue: "Authentication failed"
**Solution**: Tests use mock authentication. Ensure mock setup is correct.

## 📝 Test Coverage by Feature

| Feature | Backend | Frontend | E2E |
|---------|---------|----------|-----|
| File Upload | ✅ | ✅ | ✅ |
| URL-based Assets | ✅ | ✅ | ✅ |
| Validation | ✅ | ✅ | ✅ |
| Authentication | ✅ | ✅ | ✅ |
| DID Creation | ✅ | ⚠️ | ✅ |
| Error Handling | ✅ | ✅ | ✅ |
| Layer Tracking | ✅ | ⚠️ | ✅ |
| Provenance | ✅ | ⚠️ | ✅ |

✅ = Fully tested | ⚠️ = Partially tested

## 🎨 Test Types Explained

### Unit Tests (Backend API)
Test individual API endpoints in isolation with mocked dependencies.

**Example**: Testing `/api/assets/create-with-did` endpoint

### Component Tests (Frontend)
Test React components with user interactions using Testing Library.

**Example**: Testing form submission in `create-asset-simple.tsx`

### Integration Tests (E2E)
Test complete user flows from browser to backend using Playwright.

**Example**: Full asset creation flow with authentication

## 🔄 CI/CD Integration

### GitHub Actions Example

```yaml
name: Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: oven-sh/setup-bun@v1
      
      - name: Install dependencies
        run: bun install
        
      - name: Run tests
        run: bun test --coverage
        
      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          files: ./coverage/coverage-final.json
```

## 📚 More Information

- Full Documentation: `__tests__/README.md`
- Test Helpers: `__tests__/helpers/test-helpers.ts`
- Completion Summary: `/workspace/TASK_TEST01_COMPLETION_SUMMARY.md`

## 🎯 Next Steps

1. ✅ Install dependencies
2. ✅ Run all tests
3. ✅ Check coverage report
4. ✅ Review any failures
5. ✅ Integrate into CI/CD

## 💡 Pro Tips

- Run tests before committing: `git commit` → `bun test` → `git push`
- Use watch mode during development: `bun test --watch`
- Focus on failing tests: `bun test --only-failures`
- Update tests when changing implementation
- Keep coverage above 80%

---

**Quick Command Reference**:
```bash
bun test                    # Run all tests
bun test --coverage         # With coverage
bun test --watch           # Watch mode
bun test --verbose         # Detailed output
```
