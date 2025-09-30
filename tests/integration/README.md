# Integration Test Suite

This directory contains integration tests for the Originals SDK, validating complete workflows and adapter integrations.

## Test Files

### CompleteLifecycle.e2e.test.ts (NEW)

**Comprehensive End-to-End Integration Test Suite**

This is the most comprehensive integration test covering the complete lifecycle flow from asset creation through all layers to final transfer.

#### What it Tests

**Complete Lifecycle Flow:**
- ✅ **peer → webvh → btco → transfer**: Full lifecycle with provenance tracking
- ✅ **peer → btco** (direct): Skipping webvh layer
- ✅ Asset integrity validation throughout lifecycle

**Adapter Interface Validation:**
- ✅ Storage adapter (MemoryStorageAdapter wrapper)
- ✅ Fee oracle adapter (FeeOracleMock)
- ✅ Ordinals provider adapter (OrdMockProvider)
- ✅ Adapter integration in publishToWeb
- ✅ Adapter integration in inscribeOnBitcoin

**Error Handling & Edge Cases:**
- ✅ Transfer restrictions (only btco assets)
- ✅ Multiple transfers
- ✅ Empty resources
- ✅ Multiple content types
- ✅ Binding preservation

**Performance & Scalability:**
- ✅ Large resource payloads (100KB+)
- ✅ Many resources (50+ per asset)

**Provenance Chain:**
- ✅ Complete audit trail with all metadata
- ✅ Monotonically increasing timestamps
- ✅ Transaction ID tracking
- ✅ Fee rate recording

#### Key Features

1. **Real Adapters**: Uses functional test doubles (not mocks) for:
   - Storage operations (MemoryStorageAdapter via bridge)
   - Fee estimation (FeeOracleMock)
   - Bitcoin/Ordinals operations (OrdMockProvider)

2. **Complete Provenance**: Validates full provenance chain including:
   - Creator tracking
   - Layer migrations (peer → webvh → btco)
   - Ownership transfers
   - Transaction IDs
   - Fee rates
   - Timestamps

3. **Resource Management**: Tests:
   - Resource storage with content-addressed URLs
   - Multiple resource types
   - Large payloads
   - URL generation and retrieval

4. **Credential Issuance**: Verifies:
   - Publication credentials on webvh migration
   - Credential structure and signatures
   - Credential preservation

#### Test Statistics

- **Total Tests**: 17
- **Test Suites**: 5
  - Complete Lifecycle (3 tests)
  - Adapter Interface Validation (5 tests)
  - Error Handling and Edge Cases (5 tests)
  - Performance and Scalability (2 tests)
  - Provenance Chain Validation (2 tests)

#### Why This Test Suite is Important

**Rationale**: Found individual integration tests but no end-to-end test covering peer→webvh→btco→transfer full lifecycle with real storage adapter and fee oracle. Current tests use mocks extensively.

**Impact**: 
- Catches integration bugs before production
- Validates adapter interfaces work correctly together
- Provides confidence in release quality
- Documents expected behavior for the complete flow

**Estimated Effort**: Large (completed)

### Other Integration Tests

- **CredentialManager.test.ts**: Credential issuance and verification
- **DIDManager.test.ts**: DID resolution via OrdinalsClient adapter
- **Lifecycle.transfer.btco.integration.test.ts**: Bitcoin transfer operations
- **LifecycleManager.test.ts**: Lifecycle management operations
- **MultikeyFlow.test.ts**: End-to-end multikey pipeline
- **WebVhPublish.test.ts**: WebVH publication workflow

## Running Tests

```bash
# Run all integration tests
npm test -- tests/integration/

# Run only the complete lifecycle test
npm test -- tests/integration/CompleteLifecycle.e2e.test.ts

# Run with coverage
npm run test:coverage -- tests/integration/
```

## Test Structure

All integration tests follow these principles:

1. **Real Dependencies**: Use actual implementations where possible
2. **Minimal Mocking**: Only mock external services (Bitcoin network, etc.)
3. **Complete Workflows**: Test full user journeys, not isolated units
4. **Adapter Validation**: Ensure adapter interfaces work correctly
5. **Provenance Tracking**: Verify complete audit trails

## Adding New Tests

When adding new integration tests:

1. Follow the naming convention: `*.test.ts` or `*.e2e.test.ts`
2. Use the setup pattern from CompleteLifecycle.e2e.test.ts
3. Test complete workflows, not isolated methods
4. Verify provenance and metadata
5. Test error conditions and edge cases
6. Document the rationale and impact

## Notes

- Integration tests may be slower than unit tests
- They provide confidence that components work together correctly
- They document expected behavior for complex workflows
- They catch issues that unit tests miss