/** Shared Jest preset. Each project's own jest.config.mjs calls createConfig(name). */
export function createConfig (projectName) {
  return {
    displayName:        projectName,
    testEnvironment:    'node',
    rootDir:            '.',
    roots:              ['<rootDir>/src'],
    setupFilesAfterEnv: [
      '<rootDir>/../../jest.setup.mjs',
      '<rootDir>/../../jest.clear.mjs',
    ],
    transform: {
      '^.+\\.[tj]sx?$': ['ts-jest', { tsconfig: '<rootDir>/../../tsconfig.jest.json' }],
    },
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json'],
    collectCoverageFrom:  [
      '<rootDir>/src/**/*.ts',
      '!<rootDir>/src/**/*.d.ts',
      '!<rootDir>/src/index.ts',
    ],
    coverageProvider:  'v8',
    coverageDirectory: './coverage',
    coverageReporters: ['text', 'cobertura', 'html', 'lcov'],
  }
}
