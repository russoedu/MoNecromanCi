/**
 * Standalone ts-jest config (same rationale as v1: the shared preset factory's
 * fake-timers setup would break tests that flush real setImmediate).
 */
export default {
  displayName:         'monecromanci-v2',
  testEnvironment:     'node',
  rootDir:             '.',
  roots:               ['<rootDir>/src'],
  testMatch:           ['**/*.test.ts'],
  transform:           { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../../tsconfig.jest.json' }] },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.test.ts'],
  coverageReporters:   ['text', 'json-summary'],
  coverageThreshold:   {
    global: { statements: 85, branches: 85, functions: 85, lines: 85 },
  },
  clearMocks: true,
}
