import { join } from 'node:path'
import { runNx } from '../../nx'
import { promptText } from '../../prompts'
import { readJson, toJson, writeFileEnsured } from '../../util/fsx'
import { defaultScope, type AddOptions, type WorkspaceStack } from './shared'

/**
 * The per-npm-lib ESLint config written over the generator's default.
 *
 * @remarks
 * Identical to what `@nx/js:lib --bundler=rollup` generates, plus ONE
 * addition: `@nx/dependency-checks` gets an `ignoredDependencies` list of
 * every `private: true` workspace package, computed at lint time. Private
 * libs are compiled INTO the rollup bundle and never declared in the
 * manifest (a consumer could not install them) — without this, the rule
 * flags every internal-lib import as a missing dependency. Because the list
 * is computed, adding a new internal lib never requires touching this file.
 */
export const NPM_LIB_ESLINT_CONFIG = `import { globSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import baseConfig from '../../eslint.config.mjs';

// Private workspace libs are compiled INTO this package's rollup bundle and
// never declared in the manifest (a consumer could not install them), so the
// dependency check must ignore them. Computed at lint time: adding a new
// internal lib never requires touching this file.
const workspaceRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const privateWorkspacePackages = globSync(['libs/*/package.json', 'packages/*/package.json'], { cwd: workspaceRoot })
  .map((manifestPath) => JSON.parse(readFileSync(join(workspaceRoot, manifestPath), 'utf8')))
  .filter((manifest) => manifest.private === true)
  .map((manifest) => manifest.name);

export default [
  ...baseConfig,
  {
    files: ['**/*.json'],
    rules: {
      '@nx/dependency-checks': [
        'error',
        {
          ignoredDependencies: privateWorkspacePackages,
          ignoredFiles: [
            '{projectRoot}/eslint.config.{js,cjs,mjs,ts,cts,mts}',
            '{projectRoot}/rollup.config.{js,ts,mjs,mts,cjs,cts}',
          ],
        },
      ],
    },
    languageOptions: {
      parser: await import('jsonc-eslint-parser'),
    },
  },
  {
    ignores: ['**/out-tsc'],
  },
];
`

/**
 * Adds a publishable npm library: `@nx/js:lib` as a rollup bundle.
 *
 * @remarks
 * rollup (not tsc): a bundler is what lets a published package depend on
 * private internal libs. `@nx/rollup`'s `withNx` externalizes exactly the
 * manifest's `dependencies`/`peerDependencies` — so imported internal libs
 * (never declared in the manifest, npm workspaces links them regardless) are
 * compiled INTO the bundle from source, and the private name never reaches
 * the published `package.json`.
 *
 * The scope is resolved here: an explicit `--scope` wins; otherwise the flag
 * path (`kindProvided`) defaults it silently, while the interactive/bare path
 * prompts for it (with the workspace's own scope as the default).
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @param options - The CLI flags.
 * @param kindProvided - Whether `kind` was passed as a flag (vs. prompted) —
 * gates whether the scope is prompted for or silently defaulted.
 * @param stack - The workspace's chosen linter/test runner.
 * @returns A promise that resolves when the generator has finished.
 * @throws Error when the generator exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
export async function addNpmLib (workspaceRoot: string, name: string, options: AddOptions, kindProvided: boolean, stack: WorkspaceStack): Promise<void> {
  const scope = options.scope ?? (kindProvided
    ? defaultScope(workspaceRoot)
    : await promptText('npm scope for the published package', defaultScope(workspaceRoot)))
  runNx([
    'g', '@nx/js:lib', `packages/${name}`,
    '--publishable',
    `--importPath=${scope}/${name}`,
    '--bundler=rollup',
    `--unitTestRunner=${stack.testRunner}`,
    `--linter=${stack.linter}`,
    '--no-interactive',
  ], workspaceRoot)
  markPublic(join(workspaceRoot, 'packages', name, 'package.json'))
  // The dependency-check override is an ESLint config; oxlint has no such
  // rule, so it only applies when ESLint is the chosen linter.
  if (stack.linter === 'eslint') {
    writeFileEnsured(join(workspaceRoot, 'packages', name, 'eslint.config.mjs'), NPM_LIB_ESLINT_CONFIG)
  }
}

/**
 * Sets `publishConfig.access: "public"` in a package manifest.
 *
 * @remarks
 * npm treats every scoped package (`@scope/name` — what every npm-lib's
 * `importPath` always is) as private by default: an unmodified first publish
 * fails with `402 Payment Required — You must sign up for private packages`
 * (verified empirically against the real registry), not with anything a
 * dry-run surfaces, since dry-runs never call the registry. This is the one
 * post-generation touch that makes a freshly added npm-lib publishable
 * as-is.
 *
 * @param manifestPath - Absolute path to the lib's `package.json`.
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the manifest.
 * @typeParam None - this function has no generic type parameters.
 */
function markPublic (manifestPath: string): void {
  const manifest = readJson<Record<string, unknown>>(manifestPath)
  writeFileEnsured(manifestPath, toJson({ ...manifest, publishConfig: { access: 'public' } }))
}
