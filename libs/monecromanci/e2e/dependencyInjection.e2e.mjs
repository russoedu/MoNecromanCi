#!/usr/bin/env node

/**
 * E2E: zero-config dependency injection across a mix of project types.
 *
 * Scaffolds a real monorepo with the built CLI, wires the three dependency
 * cases, runs the REAL builds (tsc / esbuild plus generate-dist-package for
 * libs, 03-package-apps for apps), and asserts the injected manifests:
 *
 * - Case 3: external deps resolved from the root manifest (ENFORCED).
 * - Case 2: publishable-to-publishable, a star spec rewritten to a caret
 *   version (ENFORCED).
 * - Case 1: internal (private, never-published) lib dependency (PENDING).
 *
 * ENFORCED failures exit non-zero. PENDING checks encode the desired case-1
 * behaviour that is a known gap today: they are reported but do not fail the
 * run. When case 1 is fixed, promote them to enforce.
 *
 * Fully offline: the workspace borrows the repo's node_modules for the toolchain
 * and a hand-made fake external, so nothing is installed from a registry.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..')
const CLI = path.resolve(SCRIPT_DIR, '..', 'dist', 'cli.js')
const SCOPE = '@e2e'

/** Runs a command and returns its captured stdout. */
function run (command, commandArguments, cwd, environment) {
  return execFileSync(command, commandArguments, { cwd, encoding: 'utf8', env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Reads and parses a JSON file. */
function readJson (filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

/** Writes a value as pretty JSON. */
function writeJson (filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, undefined, 2)}\n`)
}

/** Shallow-merges a patch into the JSON file at the given path. */
function patchJson (filePath, patch) {
  writeJson(filePath, { ...readJson(filePath), ...patch })
}

const results = { enforced: [], pending: [] }

/** Records an ENFORCED expectation, which fails the run when false. */
function enforce (label, ok, detail) {
  results.enforced.push({ label, ok, detail })
}

/** Records a PENDING known-gap expectation, reported but never failing. */
function pending (label, ok, detail) {
  results.pending.push({ label, ok, detail })
}

/* ---------------------------------------------------------------------------
 * Scaffold
 * ------------------------------------------------------------------------- */

const temporary = mkdtempSync(path.join(tmpdir(), 'mnci-e2e-'))
const workspace = path.join(temporary, 'e2e')

process.on('exit', () => rmSync(temporary, { recursive: true, force: true }))

console.log(`\n▸ scaffolding monorepo in ${workspace}`)
run('node', [CLI, 'new', 'e2e', '--yes', '--ci', 'github', '--registry', 'npm', '--scope', SCOPE, '--lib', ''], temporary)

const projects = [
  ['internal-lib', 'core'],
  ['publishable-lib', 'beta'],
  ['publishable-lib', 'alpha'],
  ['cli-tool', 'cli'],
  ['function-app', 'fapp'],
  ['node-app', 'napp'],
]
for (const [kind, name] of projects) {
  run('node', [CLI, 'add', kind, name], workspace)
}

/* ---------------------------------------------------------------------------
 * Offline module resolution. The temp parent node_modules is symlinked to the
 * repo toolchain (tsc, esbuild, nx, commander, tslib). The workspace scope dir
 * holds symlinks to the workspace packages, plus a hand-made fake external.
 * monecromanci-toolchain is symlinked directly into the workspace's own
 * node_modules too: per-project build/lint/jest scripts resolve it via an
 * explicit `../../node_modules/monecromanci-toolchain/...` path (two levels
 * up from libs/<project>, i.e. the workspace root), which is a literal
 * filesystem path, not a specifier — it does not benefit from Node's
 * parent-directory node_modules walk-up the way bare imports do.
 * ------------------------------------------------------------------------- */

symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(temporary, 'node_modules'), 'dir')

const workspaceModules = path.join(workspace, 'node_modules')
mkdirSync(path.join(workspaceModules, SCOPE), { recursive: true })
for (const name of ['core', 'beta', 'alpha', 'cli']) {
  symlinkSync(path.join(workspace, 'libs', name), path.join(workspaceModules, SCOPE, name), 'dir')
}
symlinkSync(path.join(REPO_ROOT, 'libs', 'monecromanci-toolchain'), path.join(workspaceModules, 'monecromanci-toolchain'), 'dir')

const fakeExternal = path.join(workspaceModules, '@e2e-ext', 'tool')
mkdirSync(fakeExternal, { recursive: true })
writeJson(path.join(fakeExternal, 'package.json'), { name: '@e2e-ext/tool', version: '9.9.9', main: 'index.js', types: 'index.d.ts' })
writeFileSync(path.join(fakeExternal, 'index.js'), 'module.exports.tool = () => \'tool\'\n')
writeFileSync(path.join(fakeExternal, 'index.d.ts'), 'export declare function tool (): string\n')

/* ---------------------------------------------------------------------------
 * Wire the dependency cases
 * ------------------------------------------------------------------------- */

// Root manifest must carry the external deps so version resolution has a source.
patchJson(path.join(workspace, 'package.json'), {
  dependencies: {
    ...readJson(path.join(workspace, 'package.json')).dependencies,
    commander:       '^15.0.0',
    '@e2e-ext/tool': '^9.9.9',
  },
})

/** Resolves a source file path inside a lib project. */
function libSource (project, file) {
  return path.join(workspace, 'libs', project, 'src', file)
}

// Internal lib `core` pulls in a distinct external so we can check whether it is
// hoisted into a publishable consumer once bundling lands.
writeFileSync(libSource('core', 'index.ts'), 'import { tool } from \'@e2e-ext/tool\'\n\nexport function fromCore (): string {\n  return \'core:\' + tool()\n}\n')

// Publishable sibling `beta` at a real version to prove a star spec is rewritten.
writeFileSync(libSource('beta', 'index.ts'), 'export function fromBeta (): string {\n  return \'beta\'\n}\n')
patchJson(path.join(workspace, 'libs', 'beta', 'package.json'), { version: '1.2.3' })

// Publishable `alpha` imports an external (case 3), the sibling (case 2), the
// internal (case 1). Source deps carry star specs as a user would write them.
writeFileSync(libSource('alpha', 'index.ts'), [
  'import { Command } from \'commander\'',
  'import { fromBeta } from \'@e2e/beta\'',
  'import { fromCore } from \'@e2e/core\'',
  '',
  'export function fromAlpha (): string {',
  '  return new Command().name() + fromBeta() + fromCore()',
  '}',
  '',
].join('\n'))
patchJson(path.join(workspace, 'libs', 'alpha', 'package.json'), {
  dependencies: { commander: '*', '@e2e/beta': '*', '@e2e/core': '*' },
})

// cli-tool bundles everything (esbuild): the internal should vanish from deps.
writeFileSync(libSource('cli', 'cli.ts'), 'import { fromCore } from \'@e2e/core\'\n\nprocess.stdout.write(fromCore() + \'\\n\')\n')

// Apps import an external plus the internal. Replace scaffold sources so the app
// build does not require @azure/functions, which is out of scope here.
for (const app of ['fapp', 'napp']) {
  rmSync(path.join(workspace, 'apps', app, 'src'), { recursive: true, force: true })
  mkdirSync(path.join(workspace, 'apps', app, 'src'), { recursive: true })
  writeFileSync(path.join(workspace, 'apps', app, 'src', 'index.ts'), [
    'import { Command } from \'commander\'',
    'import { fromCore } from \'@e2e/core\'',
    '',
    'export function handler (): string {',
    '  return new Command().name() + fromCore()',
    '}',
    '',
  ].join('\n'))
}

/* ---------------------------------------------------------------------------
 * Build libs + package apps
 * ------------------------------------------------------------------------- */

const libEnvironment = { HUSKY: '0' }
console.log('▸ building publishable lib `alpha` (tsc + generate-dist-package)')
run('npm', ['run', 'build', '-w', `${SCOPE}/alpha`], workspace, libEnvironment)
console.log('▸ building cli-tool `cli` (esbuild bundle + generate-dist-package)')
run('npm', ['run', 'build', '-w', `${SCOPE}/cli`], workspace, libEnvironment)

// Hand-write the pipeline context so 03 packages the two apps without needing
// git or nx-affected. Shape mirrors enrichProject's output (see lib/context.mjs).
const appProject = (name, type) => ({
  affected:    true,
  ignored:     false,
  name,
  root:        `apps/${name}`,
  packageName: `${SCOPE}/${name}`,
  version:     '0.0.0',
  type:        { functionApp: type === 'fapp', nodeApp: type === 'napp', reactApp: false, externalPackage: false, internalPackage: false },
})
mkdirSync(path.join(workspace, '.build-templates'), { recursive: true })
writeJson(path.join(workspace, '.build-templates', '01-preparation.context.json'), {
  affectedProjects: ['fapp', 'napp'],
  hasAffected:      true,
  projects:         [appProject('fapp', 'fapp'), appProject('napp', 'napp')],
})

console.log('▸ packaging apps `fapp`, `napp` (03-package-apps --dry-run)')
run('node', ['node_modules/monecromanci-toolchain/build-templates/03-package-apps.mjs', '--dry-run'], workspace, { NX_DAEMON: 'false', HUSKY: '0' })

/* ---------------------------------------------------------------------------
 * Assertions
 * ------------------------------------------------------------------------- */

const alphaDependencies = readJson(path.join(workspace, 'libs', 'alpha', 'dist', 'package.json')).dependencies || {}
const cliDependencies = readJson(path.join(workspace, 'libs', 'cli', 'dist', 'package.json')).dependencies || {}

// Case 3 — external from root.
enforce('alpha: external `commander` injected at root version', alphaDependencies.commander === '^15.0.0', `got ${alphaDependencies.commander}`)
// Case 2 — sibling publishable star spec rewritten to a caret version.
enforce('alpha: sibling `@e2e/beta` rewritten to ^1.2.3', alphaDependencies['@e2e/beta'] === '^1.2.3', `got ${alphaDependencies['@e2e/beta']}`)
// cli-tool bundles the internal away (the target behaviour, already working).
enforce('cli: internal `@e2e/core` bundled away (absent from deps)', cliDependencies['@e2e/core'] === undefined, `got ${cliDependencies['@e2e/core']}`)

// Case 1 (publishable to internal) — desired once bundling lands.
pending('alpha: internal `@e2e/core` NOT a runtime dep (should be bundled)', alphaDependencies['@e2e/core'] === undefined, `got ${alphaDependencies['@e2e/core']}`)
pending('alpha: internal\'s external `@e2e-ext/tool` hoisted in', alphaDependencies['@e2e-ext/tool'] !== undefined, `got ${alphaDependencies['@e2e-ext/tool']}`)

// App runtime manifests.
for (const [app, group] of [['fapp', 'function-apps'], ['napp', 'node-apps']]) {
  const stage = path.join(workspace, '.pipeline-staging', group, app)
  const manifest = readJson(path.join(stage, 'package.json')).dependencies || {}
  // Case 3 — external resolved with a version.
  enforce(`${app}: external \`commander\` resolved with a version`, typeof manifest.commander === 'string' && manifest.commander.length > 0, `got ${manifest.commander}`)
  // Case 1 (app to internal) — vendored, and it must be runnable JS.
  const vendored = manifest[`${SCOPE}/core`]
  enforce(`${app}: internal \`@e2e/core\` vendored as a tarball`, typeof vendored === 'string' && vendored.startsWith('file:'), `got ${vendored}`)
  let mainField = '(unread)'
  if (typeof vendored === 'string') {
    const tarball = path.join(stage, vendored.replace(/^file:\.?\/?/, ''))
    const packageJson = JSON.parse(run('tar', ['-xzOf', tarball, 'package/package.json'], stage))
    mainField = String(packageJson.main || '')
  }
  pending(`${app}: vendored internal is runnable (main ends in .js)`, /\.js$/.test(mainField), `main=${mainField}`)
}

/* ---------------------------------------------------------------------------
 * Report
 * ------------------------------------------------------------------------- */

console.log('\n=== dependency-injection e2e ===')
let failed = 0
for (const result of results.enforced) {
  console.log(`  ${result.ok ? '✓' : '✗'} ENFORCED  ${result.label}${result.ok ? '' : `  — ${result.detail}`}`)
  if (!result.ok) {
    failed += 1
  }
}
for (const result of results.pending) {
  console.log(`  ${result.ok ? '✓ (now passing!)' : '•'} PENDING  ${result.label}${result.ok ? '' : `  — ${result.detail}`}`)
}

const nowPassing = results.pending.filter(result => result.ok)
if (nowPassing.length > 0) {
  console.log(`\n⚠ ${nowPassing.length} PENDING check(s) now pass — case 1 is fixed. Promote them to enforce.`)
}

if (failed > 0) {
  console.error(`\n✗ ${failed} ENFORCED expectation(s) failed.`)
  process.exit(1)
}
console.log(`\n✓ ${results.enforced.length} enforced checks passed; ${results.pending.length - nowPassing.length} known case-1 gap(s) still pending.`)
