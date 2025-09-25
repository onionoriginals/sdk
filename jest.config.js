const isCI = !!process.env.CI;

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: [
    '**/__tests__/**/*.+(ts|tsx|js)',
    '**/*.(test|spec).+(ts|tsx|js)'
  ],
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
    '^.+\\.(js)$': 'ts-jest'
  },
  testPathIgnorePatterns: [],
  transformIgnorePatterns: [
    '/node_modules/(?!@noble/secp256k1|@noble/ed25519|@noble/hashes|multiformats)/'
  ],
  moduleNameMapper: Object.assign({
    '^multiformats/bases/base58$': '<rootDir>/tests/__mocks__/mf-base58.js'
  }, isCI ? {} : {
    '^@digitalbazaar/bbs-signatures$': '<rootDir>/tests/__mocks__/bbs-signatures.js'
  }),
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/examples/**/*'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html', 'json-summary'],
  coverageThreshold: {
    global: {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100
    }
  }
};

