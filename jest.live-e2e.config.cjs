const LIVE_E2E_TEST_TIMEOUT_MS = 180_000;

module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/live/**/*.live-e2e.cjs'],
  testTimeout: LIVE_E2E_TEST_TIMEOUT_MS,
};
