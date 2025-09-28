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
    '!src/storage/MemoryStorageAdapter.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html', 'json-summary'],
  coverageThreshold: {
    global: {
      statements: 99.7,
      branches: 98.6,
      functions: 99.5,
      lines: 99.9
    }
  }
};

