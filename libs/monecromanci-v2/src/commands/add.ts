import { join } from 'node:path'
import { select } from '@inquirer/prompts'
import { quote, runNx, runShell } from '../nx'
import { promptText } from '../prompts'
import { fileExists, readJson, toJson, writeFileEnsured } from '../util/fsx'
import { logger } from '../util/logger'

/* The generator flags below are the plugins' own options; v2 adds no config
 * of its own on top of what @nx/react, @nx/js and @nxazure/func emit. */

/**
 * The project kinds v2 can add — deliberately just four.
 *
 * @remarks
 * Each maps to an official (or established community) Nx plugin generator;
 * v2 itself writes no project files. Layout convention drives release
 * scoping: `apps/` (never released), `packages/` (publishable, released by
 * `nx release`), `libs/` (internal, `private: true`, never released).
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type ProjectKind = 'react-app' | 'function-app' | 'npm-lib' | 'internal-lib'

/**
 * Every kind {@link runAdd} accepts, in menu order.
 *
 * @remarks
 * Also drives the interactive kind picker shown when `add` is run bare.
 */
export const PROJECT_KINDS: ProjectKind[] = ['react-app', 'function-app', 'npm-lib', 'internal-lib']

/**
 * Options accepted by {@link runAdd}.
 *
 * @remarks
 * Mirrors the CLI's flags.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface AddOptions {
  /** npm scope for a publishable lib's import path (defaults to `@<workspace name>`). */
  scope?: string
}

/**
 * Whether a plugin package is already declared in the workspace's manifest.
 *
 * @remarks
 * Keeps repeat `add` calls fast by skipping the install step.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param packageName - The plugin package (e.g. `@nx/react`).
 * @returns `true` when the package is a dependency or devDependency.
 * @throws Propagates any `fs`/JSON error reading the root manifest.
 * @typeParam None - this function has no generic type parameters.
 */
function hasPlugin (workspaceRoot: string, packageName: string): boolean {
  const manifest = readJson<{ dependencies?: Record<string, string>, devDependencies?: Record<string, string> }>(join(workspaceRoot, 'package.json'))
  const installed = { ...manifest.dependencies, ...manifest.devDependencies }
  return Object.hasOwn(installed, packageName)
}

/**
 * Ensures an Nx plugin is installed in the workspace, installing it on first use.
 *
 * @remarks
 * `nx add` installs the package and runs its init generator — the Nx-native
 * way to bring a plugin into an existing workspace.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param packageName - The plugin package (e.g. `@nx/react`).
 * @returns Nothing.
 * @throws Error when the underlying `nx add` exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
function ensurePlugin (workspaceRoot: string, packageName: string): void {
  if (hasPlugin(workspaceRoot, packageName)) {
    return
  }
  logger.step(`Installing Nx plugin ${packageName}`)
  runNx(['add', packageName], workspaceRoot)
}

/**
 * Ensures a plugin whose init generator needs arguments is plain-installed.
 *
 * @remarks
 * `@nxazure/func`'s init generator requires a name/directory, so `nx add`
 * (which runs it bare) always fails — install the package directly and let
 * {@link runAdd} invoke the generators with the right arguments.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param packageName - The plugin package (e.g. `@nxazure/func`).
 * @returns Nothing.
 * @throws Error when npm install exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
function ensurePackageInstalled (workspaceRoot: string, packageName: string): void {
  if (hasPlugin(workspaceRoot, packageName)) {
    return
  }
  logger.step(`Installing ${packageName}`)
  const status = runShell('npm', ['install', '--save-dev', packageName], workspaceRoot)
  if (status !== 0) {
    throw new Error(`npm install of ${packageName} failed with exit code ${status}`)
  }
}

/**
 * Fails fast, with install instructions, when Azure Functions Core Tools is absent.
 *
 * @remarks
 * `@nxazure/func`'s generators shell out to the `func` CLI even at generation
 * time; without this preflight the user gets a raw "Command failed: func init"
 * with no hint of the actual requirement.
 *
 * @param workspaceRoot - Absolute path to the workspace (cwd for the probe).
 * @returns Nothing.
 * @throws Error when the `func` CLI is not on the PATH.
 * @typeParam None - this function has no generic type parameters.
 */
function ensureFunctionCoreTools (workspaceRoot: string): void {
  if (runShell('func', ['--version'], workspaceRoot) !== 0) {
    throw new Error('Azure Functions Core Tools not found. Install it first: npm install -g azure-functions-core-tools@4 --unsafe-perm true')
  }
}

/**
 * Adds a project to the workspace by delegating to the matching Nx generator.
 *
 * @remarks
 * Pure delegation — v2 performs no post-generation file rewriting, with one
 * tiny exception: an internal lib is marked `"private": true` so it can never
 * be published by accident. The known gap (same as v1): a *publishable* lib
 * importing a *private internal* lib cannot be published as-is; internal libs
 * are for apps and other internal libs.
 *
 * @param kind - The project kind, prompted for when omitted.
 * @param name - The project name, prompted for when omitted.
 * @param options - The CLI flags.
 * @returns A promise that resolves when the generator has finished.
 * @throws Error when run outside a workspace root or a generator fails.
 * @typeParam None - this function has no generic type parameters.
 */
export async function runAdd (kind: ProjectKind | undefined, name: string | undefined, options: AddOptions): Promise<void> {
  const workspaceRoot = process.cwd()
  if (!fileExists(join(workspaceRoot, 'nx.json'))) {
    throw new Error('No nx.json found here. Run `add` from the workspace root.')
  }

  const resolvedKind = kind ?? await select<ProjectKind>({
    message: 'What kind of project?',
    choices: PROJECT_KINDS.map((value) => ({ name: value, value })),
  })
  const resolvedName = name ?? await promptText('Project name')

  switch (resolvedKind) {
    case 'react-app': {
      ensurePlugin(workspaceRoot, '@nx/react')
      runNx([
        'g', '@nx/react:app', `apps/${resolvedName}`,
        '--bundler=vite',
        '--unitTestRunner=jest',
        '--linter=eslint',
        '--style=css',
        '--e2eTestRunner=none',
        '--no-interactive',
      ], workspaceRoot)
      break
    }
    case 'function-app': {
      ensureFunctionCoreTools(workspaceRoot)
      ensurePackageInstalled(workspaceRoot, '@nxazure/func')
      runNx(['g', '@nxazure/func:init', resolvedName, `--directory=apps/${resolvedName}`, '--no-interactive'], workspaceRoot)
      runNx(['g', '@nxazure/func:new', 'hello', `--project=${resolvedName}`, `--template=${quote('HTTP trigger')}`], workspaceRoot)
      break
    }
    case 'npm-lib': {
      const scope = options.scope ?? defaultScope(workspaceRoot)
      // rollup (not tsc): a bundler is what lets a published package depend on
      // private internal libs. @nx/rollup's withNx externalizes exactly the
      // manifest's dependencies/peerDependencies — so imported internal libs
      // (never declared in the manifest, npm workspaces links them regardless)
      // are compiled INTO the bundle from source, and the private name never
      // reaches the published package.json.
      runNx([
        'g', '@nx/js:lib', `packages/${resolvedName}`,
        '--publishable',
        `--importPath=${scope}/${resolvedName}`,
        '--bundler=rollup',
        '--unitTestRunner=jest',
        '--linter=eslint',
        '--no-interactive',
      ], workspaceRoot)
      writeFileEnsured(join(workspaceRoot, 'packages', resolvedName, 'eslint.config.mjs'), NPM_LIB_ESLINT_CONFIG)
      break
    }
    case 'internal-lib': {
      // tsc (not none): the default @nx/enforce-module-boundaries rule forbids
      // buildable libraries (every npm-lib) from importing non-buildable ones,
      // so internal libs must be buildable — just never published (private).
      runNx([
        'g', '@nx/js:lib', `libs/${resolvedName}`,
        '--bundler=tsc',
        '--unitTestRunner=jest',
        '--linter=eslint',
        '--no-interactive',
      ], workspaceRoot)
      markPrivate(join(workspaceRoot, 'libs', resolvedName, 'package.json'))
      break
    }
  }

  logger.success(`Added ${resolvedKind} '${resolvedName}'.`)
}

/**
 * Derives the default npm scope from the workspace's root package name.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The scope, e.g. `@demo` for a workspace named `demo` (or
 * `@demo/source`-style names produced by some presets).
 * @throws Propagates any `fs`/JSON error reading the root manifest.
 * @typeParam None - this function has no generic type parameters.
 */
function defaultScope (workspaceRoot: string): string {
  const { name } = readJson<{ name: string }>(join(workspaceRoot, 'package.json'))
  const base = (name.startsWith('@') ? name.slice(1) : name).split('/', 1)[0]
  return `@${base}`
}

/**
 * Sets `"private": true` in a package manifest.
 *
 * @remarks
 * One of the two deliberate post-generation touches: it makes internal
 * libraries structurally unpublishable, no matter what future config drifts.
 *
 * @param manifestPath - Absolute path to the lib's `package.json`.
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the manifest.
 * @typeParam None - this function has no generic type parameters.
 */
function markPrivate (manifestPath: string): void {
  const manifest = readJson<Record<string, unknown>>(manifestPath)
  writeFileEnsured(manifestPath, toJson({ ...manifest, private: true }))
}

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
