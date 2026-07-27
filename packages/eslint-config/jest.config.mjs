/**
 * This package deliberately does NOT use the shared preset.
 *
 * The preset assumes a `src/` tree of TypeScript compiled to `dist/`. An
 * ESLint config package is plain ESM that consumers load directly — there is
 * nothing to compile, and adding a build step would risk the published config
 * drifting from the source. So the layout is `index.js` + `configs/*.js`, and
 * the tests live in `tests/` and exercise the config the way a consumer does:
 * through the real ESLint binary against real fixture files.
 */
export default {
  displayName: 'eslint-config',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/tests'],
  transform: {
    '^.+\\.[tj]sx?$': ['ts-jest', { tsconfig: '<rootDir>/../../tsconfig.jest.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'mjs', 'cjs', 'json'],
  // The config is declarative; the meaningful assertion is that ESLint loads it
  // and the rules actually fire, which the integration tests do directly.
  collectCoverage: false,
  testTimeout: 30_000,
}
