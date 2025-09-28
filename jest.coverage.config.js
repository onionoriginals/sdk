const baseConfig = require('./jest.config.js');

module.exports = {
  ...baseConfig,
  // Enforce 100% coverage for all metrics in this config
  coverageThreshold: {
    global: {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100
    }
  }
};

