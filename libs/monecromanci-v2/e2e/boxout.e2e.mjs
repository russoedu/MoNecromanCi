#!/usr/bin/env node

/**
 * E2E: the box-out thesis, verified for real.
 *
 * Runs the BUILT v2 CLI against the real network: `new` (which runs the
 * latest create-nx-workspace and real npm installs), then `add` for one of
 * each of the four kinds, then real `nx run-many -t lint,test,build` and a
 * real `nx release version --dry-run` inside the generated repo.
 *
 * ENFORCED failures exit non-zero. PENDING checks cover the function app's
 * build, which may require Azure Functions Core Tools not present locally —
 * reported but never failing (CI installs the tools; local runs may not).
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// js-yaml is CommonJS; load it through require so native ESM interop can't trip.
const yaml = createRequire(import.meta.url)('js-yaml')

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(SCRIPT_DIR, '..', 'dist', 'cli.js')

/** Runs a command inheriting stdio, throwing on non-zero exit. */
function run (command, cwd) {
  console.log(`\n$ ${command}   (cwd: ${cwd})`)
  execSync(command, { cwd, stdio: 'inherit', env: { ...process.env, NX_DAEMON: 'false', HUSKY: '0', CI: 'true' } })
}

/** Runs a command, returning true/false instead of throwing. */
function tryRun (command, cwd) {
  try {
    run(command, cwd)
    return true
  } catch {
    return false
  }
}

const results = { enforced: [], pending: [] }

/** Records an ENFORCED expectation, which fails the run when false. */
function enforce (label, ok, detail = '') {
  results.enforced.push({ label, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — ${detail}`}`)
}

/** Records a PENDING expectation, reported but never failing. */
function pending (label, ok, detail = '') {
  results.pending.push({ label, ok, detail })
  console.log(`  ${ok ? '✓ (pending, passing)' : '• (pending)'} ${label}${ok ? '' : `  — ${detail}`}`)
}

const temporary = mkdtempSync(path.join(tmpdir(), 'mnci2-e2e-'))
const workspace = path.join(temporary, 'demo')

process.on('exit', () => rmSync(temporary, { recursive: true, force: true }))

/* ---------------------------------------------------------------------------
 * new
 * ------------------------------------------------------------------------- */

console.log(`\n▸ mnci2 new demo (in ${temporary})`)
run(`node ${CLI} new demo --yes --registry npm --scope @demo`, temporary)

enforce('workspace created with nx.json', existsSync(path.join(workspace, 'nx.json')))

const nxJson = JSON.parse(readFileSync(path.join(workspace, 'nx.json'), 'utf8'))
const release = nxJson.release ?? {}
enforce('release: conventional commits + independent versioning', release.version?.conventionalCommits === true && release.projectsRelationship === 'independent')
enforce('release: tag-only git (version.git commit: false, tag: true)', release.version?.git?.commit === false && release.version?.git?.tag === true)
enforce('release scoped to packages/*', JSON.stringify(release.projects) === '["packages/*"]')

enforce('.npmrc written', existsSync(path.join(workspace, '.npmrc')))
enforce('commitlint config written', existsSync(path.join(workspace, 'commitlint.config.mjs')))
const hookPath = path.join(workspace, '.husky/commit-msg')
enforce('husky commit-msg hook written and executable', existsSync(hookPath) && (statSync(hookPath).mode & 0o111) !== 0)
enforce('azure-pipelines.yml written', existsSync(path.join(workspace, 'azure-pipelines.yml')))

const rootManifest = JSON.parse(readFileSync(path.join(workspace, 'package.json'), 'utf8'))
const rootDevelopmentDependencies = rootManifest.devDependencies ?? {}
enforce('husky + commitlint installed as devDependencies', Boolean(rootDevelopmentDependencies.husky && rootDevelopmentDependencies['@commitlint/cli']))
enforce('curated root scripts stamped (build/affected/prepare)',
  rootManifest.scripts?.build === 'nx run-many -t build'
  && rootManifest.scripts?.affected === 'nx affected -t lint,test,build'
  && rootManifest.scripts?.prepare === 'husky')

const pipelineYaml = readFileSync(path.join(workspace, 'azure-pipelines.yml'), 'utf8')
enforce('pipeline is cross-platform: no multi-line shell blocks, no bash-isms', !pipelineYaml.includes('script: |') && !pipelineYaml.includes('shopt'))
enforce('pipeline stamps the CLI agent and variable group', pipelineYaml.includes('vmImage: ubuntu-latest') && pipelineYaml.includes('- group: Build'))
enforce('pipeline packs apps to a drop and tags per app (type-name)',
  pipelineYaml.includes('nx run-many -t package')
  && pipelineYaml.includes('ArtifactName: drop')
  && pipelineYaml.includes('##vso[build.addbuildtag]')
  && pipelineYaml.includes(`path.basename(f,'.zip')`))
enforce('pipeline authenticates npm via the PAT env, not npmAuthenticate', pipelineYaml.includes('PAT: $(PAT)') && !pipelineYaml.includes('npmAuthenticate'))
let pipelineParsed = null
try {
  pipelineParsed = yaml.load(pipelineYaml)
} catch { /* leaves pipelineParsed null → the check below fails with the parse error surfaced above */ }
enforce('azure-pipelines.yml is valid YAML (steps + pool + variables)',
  Boolean(pipelineParsed) && Array.isArray(pipelineParsed.steps) && Boolean(pipelineParsed.pool) && Array.isArray(pipelineParsed.variables))

/* ---------------------------------------------------------------------------
 * add — one of each kind
 * ------------------------------------------------------------------------- */

console.log('\n▸ mnci2 add npm-lib sdk')
run(`node ${CLI} add npm-lib sdk`, workspace)

console.log('\n▸ mnci2 add internal-lib utils')
run(`node ${CLI} add internal-lib utils`, workspace)

/* ---------------------------------------------------------------------------
 * The dependency chain: a PUBLISHED package using a PRIVATE internal lib.
 * The internal lib is imported directly and NEVER declared in the consumer's
 * dependencies — npm workspaces links every member into root node_modules,
 * and rollup (which externalizes only manifest deps) inlines it from source.
 * ------------------------------------------------------------------------- */

console.log('\n▸ wiring sdk (published) -> utils (private internal)')
writeFileSync(path.join(workspace, 'libs/utils/src/lib/utils.ts'), 'export function utils(): string {\n  return \'utils\';\n}\n')
writeFileSync(path.join(workspace, 'packages/sdk/src/lib/sdk.ts'), 'import { utils } from \'@demo/utils\';\n\nexport function sdk(): string {\n  return \'sdk uses \' + utils();\n}\n')
writeFileSync(path.join(workspace, 'packages/sdk/src/lib/sdk.spec.ts'), 'import { sdk } from \'./sdk.js\';\n\ndescribe(\'sdk\', () => {\n  it(\'uses the internal lib\', () => {\n    expect(sdk()).toEqual(\'sdk uses utils\');\n  });\n});\n')
run('npx nx sync', workspace)

console.log('\n▸ mnci2 add react-app web')
run(`node ${CLI} add react-app web`, workspace)

console.log('\n▸ mnci2 add function-app api')
const coreToolsAvailable = tryRun('func --version', workspace)
const functionAppGenerated = coreToolsAvailable && tryRun(`node ${CLI} add function-app api`, workspace)
if (coreToolsAvailable) {
  enforce('function app generated (@nxazure/func)', functionAppGenerated, 'generator failed — see log above')
} else {
  pending('function app generated (@nxazure/func)', false, 'Azure Functions Core Tools not installed locally')
}

/* ---------------------------------------------------------------------------
 * The minimal-config promise
 * ------------------------------------------------------------------------- */

enforce('publishable lib has NO project.json (targets are inferred)', !existsSync(path.join(workspace, 'packages/sdk/project.json')))
enforce('internal lib has NO project.json (targets are inferred)', !existsSync(path.join(workspace, 'libs/utils/project.json')))

const sdkManifest = JSON.parse(readFileSync(path.join(workspace, 'packages/sdk/package.json'), 'utf8'))
enforce('publishable lib named under the scope', sdkManifest.name === '@demo/sdk')

const internalLibraryManifest = JSON.parse(readFileSync(path.join(workspace, 'libs/utils/package.json'), 'utf8'))
enforce('internal lib is private', internalLibraryManifest.private === true)
enforce('internal lib named under the scope (the sdk import path)', internalLibraryManifest.name === '@demo/utils')

enforce('no per-project eslint config beyond the root one', !existsSync(path.join(workspace, 'packages/sdk/eslint.config.mjs')) || existsSync(path.join(workspace, 'eslint.config.mjs')))

/* ---------------------------------------------------------------------------
 * Real toolchain runs inside the generated repo
 * ------------------------------------------------------------------------- */

enforce(
  'nx run-many -t lint,test,build succeeds (function app included)',
  tryRun('npx nx run-many -t lint,test,build', workspace),
  'see log above',
)

/* ---------------------------------------------------------------------------
 * Packing: each app zips into dist/drop/<type>-<name>.zip — the CI 'drop', and
 * the exact string CI turns into the per-app build tag.
 * ------------------------------------------------------------------------- */

enforce('nx run-many -t package succeeds', tryRun('npx nx run-many -t package', workspace), 'see log above')
enforce('react app builds per environment into the drop (dev/uat/prod zips)',
  ['dev', 'uat', 'prod'].every((environment) => existsSync(path.join(workspace, `dist/drop/react-app-web-${environment}.zip`))))
enforce('react app scaffolds a committed .env per environment',
  ['dev', 'uat', 'prod'].every((environment) => existsSync(path.join(workspace, `apps/web/.env.${environment}`))))

if (functionAppGenerated) {
  // The rewired function app bundles to ONE self-contained deployable folder
  // (the plugin's executors are bypassed — their shared prepare-build breaks
  // on Nx 23 workspaces).
  const bundleDirectory = path.join(workspace, 'dist/function-apps/api')
  enforce('function app bundles to a single main.cjs', existsSync(path.join(bundleDirectory, 'main.cjs')))
  enforce('bundle folder is a complete deployable (host.json + package.json)',
    existsSync(path.join(bundleDirectory, 'host.json')) && existsSync(path.join(bundleDirectory, 'package.json')))
  const bundle = readFileSync(path.join(bundleDirectory, 'main.cjs'), 'utf8')
  enforce('bundle inlines @azure/functions; only the host-injected functions-core stays external',
    bundle.includes('@azure/functions-core') && !/require\("@azure\/functions"\)/.test(bundle))
  const functionAppManifest = JSON.parse(readFileSync(path.join(workspace, 'apps/api/package.json'), 'utf8'))
  enforce('function app manifest repaired (name, bundled main, runtime SDK dependency)',
    functionAppManifest.name === '@demo/api'
    && functionAppManifest.main === 'main.cjs'
    && Boolean(functionAppManifest.dependencies?.['@azure/functions']))

  // A hand-rewired function app gets no plugin jest setup; v2 wires its own so
  // `nx test <fn-app>` works like every other kind.
  enforce('function app has a jest config + spec tsconfig',
    existsSync(path.join(workspace, 'apps/api/jest.config.mjs'))
    && existsSync(path.join(workspace, 'apps/api/tsconfig.spec.json')))
  const functionAppProject = JSON.parse(readFileSync(path.join(workspace, 'apps/api/project.json'), 'utf8'))
  enforce('function app has a test target', Boolean(functionAppProject.targets?.test))
  enforce('function app test target runs green (sample spec passes)', tryRun('npx nx test api', workspace), 'see log above')
  enforce('function app has a package target', Boolean(functionAppProject.targets?.package))
  enforce('function app packs into the drop (function-app-api.zip)', existsSync(path.join(workspace, 'dist/drop/function-app-api.zip')))
}

/* ---------------------------------------------------------------------------
 * The published-package-uses-private-lib promise, verified on the real output
 * ------------------------------------------------------------------------- */

const sdkBundle = readFileSync(path.join(workspace, 'packages/sdk/dist/index.esm.js'), 'utf8')
enforce('sdk bundle inlines the private lib (no import of it remains)', !sdkBundle.includes('@demo/utils'))
enforce(
  'sdk bundle runs standalone under node',
  tryRun(`node --input-type=module -e "import { sdk } from './packages/sdk/dist/index.esm.js'; if (sdk() !== 'sdk uses utils') { throw new Error('wrong output: ' + sdk()) }"`, workspace),
  'see log above',
)
const publishedDependencies = JSON.parse(readFileSync(path.join(workspace, 'packages/sdk/package.json'), 'utf8')).dependencies ?? {}
enforce('sdk publishable manifest never mentions the private lib', !Object.hasOwn(publishedDependencies, '@demo/utils'))

/* ---------------------------------------------------------------------------
 * Release config resolves for real
 * ------------------------------------------------------------------------- */

run('git init -q -b main && git add -A', workspace)
// The committed .env files must survive `git add -A` (allowEnvFiles un-ignores
// them even if the preset's .gitignore ignores .env*).
enforce('react .env.dev is tracked (not gitignored)', tryRun('git ls-files --error-unmatch apps/web/.env.dev', workspace))
run('git -c user.email=e2e@test -c user.name=e2e commit -q -m "feat: initial workspace"', workspace)
enforce(
  'nx release version --dry-run computes versions from conventional commits',
  tryRun('npx nx release version --dry-run --verbose', workspace),
  'see log above',
)

/* ---------------------------------------------------------------------------
 * Alternate stack: TS6 + oxlint + vitest, exercised end-to-end so the non-default
 * choices are proven on the real toolchain (not just in unit tests).
 * ------------------------------------------------------------------------- */

const altWorkspace = path.join(temporary, 'alt')
console.log('\n▸ mnci2 new alt --linter oxlint --test-runner vitest')
run(`node ${CLI} new alt --yes --registry npm --scope @alt --linter oxlint --test-runner vitest`, temporary)

const altNx = JSON.parse(readFileSync(path.join(altWorkspace, 'nx.json'), 'utf8'))
enforce('alt: stack persisted as nx.json generator defaults (linter:none + vitest)',
  altNx.generators?.['@nx/js:library']?.linter === 'none' && altNx.generators?.['@nx/js:library']?.unitTestRunner === 'vitest')
const altManifest = JSON.parse(readFileSync(path.join(altWorkspace, 'package.json'), 'utf8'))
enforce('alt: oxlint set up (.oxlintrc.json + root lint = oxlint)',
  existsSync(path.join(altWorkspace, '.oxlintrc.json')) && altManifest.scripts?.lint === 'oxlint')

run(`node ${CLI} add npm-lib sdk`, altWorkspace)
run(`node ${CLI} add react-app web`, altWorkspace)
enforce('alt: npm-lib gets no per-lib eslint config under oxlint', !existsSync(path.join(altWorkspace, 'packages/sdk/eslint.config.mjs')))
enforce('alt: npm run lint (oxlint) runs green', tryRun('npm run lint', altWorkspace), 'see log above')
enforce('alt: test + build (vitest) runs green', tryRun('npx nx run-many -t test,build', altWorkspace), 'see log above')
enforce('alt: apps still pack per environment into the drop', tryRun('npx nx run-many -t package', altWorkspace)
&& ['dev', 'uat', 'prod'].every((environment) => existsSync(path.join(altWorkspace, `dist/drop/react-app-web-${environment}.zip`))))

/* ---------------------------------------------------------------------------
 * Report
 * ------------------------------------------------------------------------- */

console.log('\n=== box-out e2e ===')
const failed = results.enforced.filter((result) => !result.ok)
for (const result of results.enforced) {
  console.log(`  ${result.ok ? '✓' : '✗'} ENFORCED  ${result.label}`)
}
for (const result of results.pending) {
  console.log(`  ${result.ok ? '✓' : '•'} PENDING   ${result.label}`)
}

if (failed.length > 0) {
  console.error(`\n✗ ${failed.length} ENFORCED expectation(s) failed.`)
  process.exit(1)
}
console.log(`\n✓ ${results.enforced.length} enforced checks passed; ${results.pending.filter((result) => !result.ok).length} pending gap(s).`)
