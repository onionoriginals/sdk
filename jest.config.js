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
  testPathIgnorePatterns: [
    '<rootDir>/tests/bitcoin/',
    '<rootDir>/tests/vc/',
    '<rootDir>/tests/lifecycle/',
    '<rootDir>/tests/did/DIDManager.test.ts'
  ],
  transformIgnorePatterns: [
    '/node_modules/(?!@noble/secp256k1|@noble/ed25519|@noble/hashes|multiformats)/'
  ],
  collectCoverageFrom: [
    'src/crypto/Signer.ts',
    'src/did/KeyManager.ts'
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

