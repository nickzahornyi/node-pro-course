module.exports = {
  testEnvironment: 'node',
  transform: {},
  testMatch: ['<rootDir>/test/integration/**/*.spec.js', '<rootDir>/test/e2e/**/*.spec.js', '<rootDir>/test/contract/**/*.spec.js'],
  reporters: ['default'],
  verbose: true,
  maxWorkers: 1,
  watchman: false,
  testTimeout: 120000,
};
