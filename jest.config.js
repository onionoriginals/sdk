const isCI = !!process.env.CI;

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/tests/setup.jest.ts'],
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: [
    '**/__tests__/**/*.+(ts|tsx|js)',
    '**/*.(test|spec).+(ts|tsx|js)'
  ],
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', {
      tsconfig: 'tsconfig.test.json'
    }],
    '^.+\\.(js)$': 'ts-jest'
  },
  testPathIgnorePatterns: [],
  transformIgnorePatterns: [
    '/node_modules/(?!@noble/secp256k1|@noble/ed25519|@noble/hashes|multiformats)/',
    '/tests/__mocks__/'
  ],
  moduleNameMapper: Object.assign({
    '^multiformats/bases/base58$': '<rootDir>/tests/__mocks__/mf-base58.js'
  }, isCI ? {} : {
    '^@digitalbazaar/bbs-signatures$': '<rootDir>/tests/__mocks__/bbs-signatures.js'
  }),
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/examples/**/*',
    '!src/storage/LocalStorageAdapter.ts',
    '!src/storage/MemoryStorageAdapter.ts',
    // Exclude complex integration-heavy modules from unit coverage
    '!src/bitcoin/BitcoinManager.ts',
    '!src/bitcoin/utxo.ts',
    '!src/crypto/Signer.ts',
    '!src/vc/CredentialManager.ts',
    '!src/did/KeyManager.ts',
    '!src/did/DIDManager.ts',
    '!src/lifecycle/LifecycleManager.ts',
    '!src/utils/serialization.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html', 'json-summary'],
  coverageThreshold: {
    global: {
      statements: 99.8,
      branches: 100,
      functions: 100,
      lines: 99.8
    }
  }
};

