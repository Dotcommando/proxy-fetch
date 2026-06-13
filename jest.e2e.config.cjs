const E2E_TEST_TIMEOUT_MS = 30_000;

module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/e2e/**/*.e2e.cjs'],
  testTimeout: E2E_TEST_TIMEOUT_MS,
};
