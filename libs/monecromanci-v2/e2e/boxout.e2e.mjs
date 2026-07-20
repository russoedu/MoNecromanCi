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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

/** Runs a command capturing combined output; returns an ok/output record. */
function tryRunCapture (command, cwd) {
  console.log(`\n$ ${command}   (cwd: ${cwd})`)
  try {
    const output = execSync(command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NX_DAEMON: 'false', HUSKY: '0', CI: 'true' } })
    console.log(output)
    return { ok: true, output }
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    console.log(output)
    return { ok: false, output }
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
enforce('release scoped to the publishable dirs (npm + python)', JSON.stringify(release.projects) === '["packages/*","python-packages/*"]')

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

// Dual TypeScript compiler: `tsc` runs TS7 (native), while the importable API
// (node_modules/typescript) stays TS6 for Nx's graph/plugins, Vite and eslint.
let tscVersion = ''
try {
  tscVersion = execSync('node_modules/.bin/tsc --version', { cwd: workspace, encoding: 'utf8' })
} catch {
  // Leaves tscVersion empty → the check below fails and surfaces the problem.
}
enforce('dual compiler: `tsc` runs TypeScript 7 (native)', tscVersion.includes('Version 7'))
const tsApiManifest = JSON.parse(readFileSync(path.join(workspace, 'node_modules/typescript/package.json'), 'utf8'))
enforce('dual compiler: the importable TypeScript API stays TS6 (Nx graph/Vite/eslint)', String(tsApiManifest.version).startsWith('6'))

/* ---------------------------------------------------------------------------
 * add — one of each kind
 * ------------------------------------------------------------------------- */

console.log('\n▸ mnci2 add npm-lib sdk')
run(`node ${CLI} add npm-lib sdk`, workspace)

console.log('\n▸ mnci2 add internal-lib utils')
run(`node ${CLI} add internal-lib utils`, workspace)

/* ---------------------------------------------------------------------------
 * The dependency chain: a PUBLISHED package using a PRIVATE internal lib AND a
 * real EXTERNAL dependency (ms) — opposite fates. The internal lib is imported
 * directly and NEVER declared in the consumer's dependencies — npm workspaces
 * links every member into root node_modules, and rollup (which externalizes
 * only manifest deps) inlines it from source. `ms` IS declared, so rollup
 * externalizes it: the published tarball must still work when `npm install`d
 * standalone, which only holds if real dependencies stay real `require`/
 * `import`s rather than getting bundled in.
 * ------------------------------------------------------------------------- */

console.log('\n▸ wiring sdk (published) -> utils (private internal) + ms (real external dependency)')
run('npm install ms @types/ms --save-dev', workspace)
const msVersion = JSON.parse(readFileSync(path.join(workspace, 'node_modules/ms/package.json'), 'utf8')).version
const msSource = readFileSync(path.join(workspace, 'node_modules/ms/index.js'), 'utf8')
// A literal string constant from ms's own installed source — survives
// minification (string literals are never renamed), so its presence proves
// real inlined code, not just "no import statement remains". Extracted live
// rather than hardcoded so a future ms release can't silently break the check.
const MS_SOURCE_MARKER = 'val is not a non-empty string or a valid number. val='
if (!msSource.includes(MS_SOURCE_MARKER)) {
  throw new Error(`ms@${msVersion} source changed — update the e2e's inline-detection marker`)
}
writeFileSync(path.join(workspace, 'libs/utils/src/lib/utils.ts'), 'export function utils(): string {\n  return \'utils\';\n}\n')
const sdkManifestPath = path.join(workspace, 'packages/sdk/package.json')
const sdkManifestForDependency = JSON.parse(readFileSync(sdkManifestPath, 'utf8'))
sdkManifestForDependency.dependencies = { ...sdkManifestForDependency.dependencies, ms: `^${msVersion}` }
writeFileSync(sdkManifestPath, `${JSON.stringify(sdkManifestForDependency, undefined, 2)}\n`)
writeFileSync(path.join(workspace, 'packages/sdk/src/lib/sdk.ts'), 'import ms from \'ms\';\nimport { utils } from \'@demo/utils\';\n\nexport function sdk(): string {\n  return \'sdk uses \' + utils() + \' and \' + ms(60000);\n}\n')
writeFileSync(path.join(workspace, 'packages/sdk/src/lib/sdk.spec.ts'), 'import { sdk } from \'./sdk.js\';\n\ndescribe(\'sdk\', () => {\n  it(\'uses the internal lib and the external dependency\', () => {\n    expect(sdk()).toEqual(\'sdk uses utils and 1m\');\n  });\n});\n')
run('npx nx sync', workspace)

console.log('\n▸ mnci2 add react-app web')
run(`node ${CLI} add react-app web`, workspace)

// A browser bundle inlines everything by default (same direction as a function
// app's self-contained deploy), so wire the same private-lib + real-external
// pair here too. `App` itself is unit-tested under Jest, which (unlike Vite)
// has no `import.meta.env` support — verified empirically — so the deps go in
// `main.tsx` (the Vite entry point, never imported by a spec file) instead.
console.log('\n▸ wiring react app (web) -> utils (private internal) + ms (real external dependency)')
writeFileSync(path.join(workspace, 'apps/web/src/main.tsx'), [
  'import { StrictMode } from \'react\';',
  'import * as ReactDOM from \'react-dom/client\';',
  'import ms from \'ms\';',
  'import { utils } from \'@demo/utils\';',
  'import App from \'./app/app\';',
  '',
  'console.log(\'deps-check:\', utils(), ms(60000), import.meta.env.VITE_API_URL);',
  '',
  'const root = ReactDOM.createRoot(',
  '  document.getElementById(\'root\') as HTMLElement,',
  ');',
  '',
  'root.render(',
  '  <StrictMode>',
  '    <App />',
  '  </StrictMode>,',
  ');',
  '',
].join('\n'))

console.log('\n▸ mnci2 add function-app api')
const coreToolsAvailable = tryRun('func --version', workspace)
const functionAppGenerated = coreToolsAvailable && tryRun(`node ${CLI} add function-app api`, workspace)
if (coreToolsAvailable) {
  enforce('function app generated (@nxazure/func)', functionAppGenerated, 'generator failed — see log above')
} else {
  pending('function app generated (@nxazure/func)', false, 'Azure Functions Core Tools not installed locally')
}
if (functionAppGenerated) {
  // A function app's whole point is a self-contained deploy (no npm install at
  // Azure deploy time), so — unlike the sdk's real external dependency — BOTH
  // the private lib and ms must end up genuinely inlined, not just imported.
  console.log('\n▸ wiring function app (api) -> utils (private internal) + ms (real external dependency)')
  writeFileSync(path.join(workspace, 'apps/api/src/deps.ts'), 'import ms from \'ms\';\nimport { utils } from \'@demo/utils\';\n\nexport function apiDeps(): string {\n  return \'api uses \' + utils() + \' and \' + ms(60000);\n}\n')
  writeFileSync(path.join(workspace, 'apps/api/src/main.ts'), '// esbuild only includes what is reachable from here, so add one import per\n// function file you create under src/functions/.\nimport \'./functions/hello.js\';\nimport { apiDeps } from \'./deps.js\';\n\n// eslint-disable-next-line no-console -- proves apiDeps (and its private-lib +\n// external-dep imports) are reachable, so esbuild bundles them rather than\n// tree-shaking them away; never actually invoked (no Functions host here).\nconsole.log(apiDeps());\n')
  run('npx nx sync', workspace)
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

// A typo'd kind must be a clear, real failure -- not a silent "success" that
// creates nothing (the exact bug this check regression-tests: it used to
// print "Added totally-bogus-kind 'thing'." and exit 0).
enforce('add: an unrecognized kind is rejected up front, not a silent false "success"',
  !tryRun(`node ${CLI} add totally-bogus-kind thing`, workspace) && !existsSync(path.join(workspace, 'apps/thing')))

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

// A browser bundle inlines everything by default (no npm install step at
// runtime, unlike the published sdk) — prove BOTH the private lib and the
// real external dependency (ms) are genuinely inlined per environment, and
// that each environment's build bakes in only its own VITE_API_URL (proving
// the three builds are genuinely separate compiles, not one bundle copied
// three times).
for (const environment of ['dev', 'uat', 'prod']) {
  const assetsDirectory = path.join(workspace, `dist/apps/web-${environment}/assets`)
  const jsAsset = existsSync(assetsDirectory) ? readdirSync(assetsDirectory).find((file) => file.endsWith('.js')) : undefined
  const bundleText = jsAsset ? readFileSync(path.join(assetsDirectory, jsAsset), 'utf8') : ''
  enforce(`react app (${environment}) bundle inlines the private lib (utils) and the real external dependency (ms)`,
    bundleText.includes('utils') && bundleText.includes(MS_SOURCE_MARKER))
  const ownUrl = `https://api.${environment}.example.com`
  const otherUrls = ['dev', 'uat', 'prod'].filter((other) => other !== environment).map((other) => `https://api.${other}.example.com`)
  enforce(`react app (${environment}) bundle bakes in only its own VITE_API_URL`,
    bundleText.includes(ownUrl) && otherUrls.every((url) => !bundleText.includes(url)))
}

if (functionAppGenerated) {
  // The rewired function app bundles to ONE self-contained deployable folder
  // (the plugin's executors are bypassed — their shared prepare-build breaks
  // on Nx 23 workspaces).
  const bundleDirectory = path.join(workspace, 'dist/apps/api')
  enforce('function app bundles to a single main.cjs', existsSync(path.join(bundleDirectory, 'main.cjs')))
  enforce('bundle folder is a complete deployable (host.json + package.json)',
    existsSync(path.join(bundleDirectory, 'host.json')) && existsSync(path.join(bundleDirectory, 'package.json')))
  const bundle = readFileSync(path.join(bundleDirectory, 'main.cjs'), 'utf8')
  enforce('bundle inlines @azure/functions; only the host-injected functions-core stays external',
    bundle.includes('@azure/functions-core') && !/require\("@azure\/functions"\)/.test(bundle))
  // A function app's whole point is a self-contained deploy: the private lib
  // AND the real external dependency (ms) must both be genuinely inlined —
  // there is no npm install step at Azure deploy time to resolve either one.
  enforce('bundle inlines the private lib (@demo/utils) — no import of it remains', !bundle.includes('@demo/utils'))
  enforce('bundle inlines the real external dependency (ms), not left as a require',
    bundle.includes(MS_SOURCE_MARKER) && !/require\(["']ms["']\)/.test(bundle))
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
enforce('sdk bundle keeps the real external dependency (ms) external — not inlined',
  sdkBundle.includes('from \'ms\'') && !sdkBundle.includes(MS_SOURCE_MARKER))
enforce(
  'sdk bundle runs standalone under node, resolving the inlined private lib and the external dependency correctly',
  tryRun(`node --input-type=module -e "import { sdk } from './packages/sdk/dist/index.esm.js'; if (sdk() !== 'sdk uses utils and 1m') { throw new Error('wrong output: ' + sdk()) }"`, workspace),
  'see log above',
)
const publishedDependencies = JSON.parse(readFileSync(path.join(workspace, 'packages/sdk/package.json'), 'utf8')).dependencies ?? {}
enforce('sdk publishable manifest never mentions the private lib', !Object.hasOwn(publishedDependencies, '@demo/utils'))
enforce('sdk publishable manifest declares the real external dependency (ms) with a real version',
  typeof publishedDependencies.ms === 'string' && /^[~^]?\d+\.\d+\.\d+/.test(publishedDependencies.ms))

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
enforce('alt: oxlint set up (oxlint.config.mts + root lint = oxlint)',
  existsSync(path.join(altWorkspace, 'oxlint.config.mts')) && altManifest.scripts?.lint === 'oxlint')
enforce('alt: oxlint config extends the oxc-standard StandardJS preset',
  readFileSync(path.join(altWorkspace, 'oxlint.config.mts'), 'utf8').includes(`import standard from 'oxc-standard/.oxlintrc.json'`))
enforce('alt: oxfmt set up (oxfmt.config.mts + format/format:check scripts)',
  existsSync(path.join(altWorkspace, 'oxfmt.config.mts'))
  && altManifest.scripts?.format === 'oxfmt -c oxfmt.config.mts .'
  && altManifest.scripts?.['format:check'] === 'oxfmt -c oxfmt.config.mts --check .')

run(`node ${CLI} add npm-lib sdk`, altWorkspace)
run(`node ${CLI} add react-app web`, altWorkspace)
enforce('alt: npm-lib gets no per-lib eslint config under oxlint', !existsSync(path.join(altWorkspace, 'packages/sdk/eslint.config.mjs')))
// This coding-agent sandbox injects .agents/.opencode/.github/skills into every
// cwd; they are not part of a generated workspace, so drop them before the
// whole-repo oxlint (a real user never has them).
for (const injected of ['.agents', '.opencode', '.github/skills']) {
  rmSync(path.join(altWorkspace, injected), { recursive: true, force: true })
}
// Nx generators emit semicolon/double-quote code, so a fresh workspace is not
// yet Standard-formatted: `npm run format` normalises it, after which
// `format:check` must be clean (proves oxfmt + the config actually run).
enforce('alt: npm run format (oxfmt) then format:check round-trips green',
  tryRun('npm run format', altWorkspace) && tryRun('npm run format:check', altWorkspace), 'see log above')
enforce('alt: npm run lint (oxlint) runs green', tryRun('npm run lint', altWorkspace), 'see log above')
enforce('alt: test + build (vitest) runs green', tryRun('npx nx run-many -t test,build', altWorkspace), 'see log above')
enforce('alt: apps still pack per environment into the drop', tryRun('npx nx run-many -t package', altWorkspace)
&& ['dev', 'uat', 'prod'].every((environment) => existsSync(path.join(altWorkspace, `dist/drop/react-app-web-${environment}.zip`))))

/* ---------------------------------------------------------------------------
 * Python (@nxlv/python — uv + Ruff + pytest), added to the alt workspace so the
 * real toolchain (not just unit tests) proves the four Python kinds. uv, ruff
 * and python3 are present in this environment, so these are all enforced.
 * ------------------------------------------------------------------------- */

console.log('\n▸ mnci2 add python-app / python-function-app / python-lib / python-internal-lib')
run(`node ${CLI} add python-app pysvc`, altWorkspace)
run(`node ${CLI} add python-function-app pyfunc`, altWorkspace)
run(`node ${CLI} add python-lib pyshared`, altWorkspace)
run(`node ${CLI} add python-internal-lib pycore`, altWorkspace)

const altNxPython = JSON.parse(readFileSync(path.join(altWorkspace, 'nx.json'), 'utf8'))
enforce('python: @nxlv/python plugin registered with the uv package manager',
  (altNxPython.plugins ?? []).some((plugin) => typeof plugin === 'object' && plugin.plugin === '@nxlv/python' && plugin.options?.packageManager === 'uv'))
const pysharedProjectPath = path.join(altWorkspace, 'python-packages/pyshared/project.json')
const pysharedProject = existsSync(pysharedProjectPath) ? JSON.parse(readFileSync(pysharedProjectPath, 'utf8')) : {}
enforce('python: publishable lib lives under python-packages/ with the plugin release hooks',
  pysharedProject.targets?.['nx-release-publish']?.executor === '@nxlv/python:publish'
  && typeof pysharedProject.release?.version?.versionActions === 'string')
enforce('python: internal lib is a library under libs/ (never publishable)',
  existsSync(path.join(altWorkspace, 'libs/pycore/project.json')))
enforce('python: function app carries the Azure Functions v2 files',
  ['function_app.py', 'host.json', 'requirements.txt'].every((file) => existsSync(path.join(altWorkspace, 'apps/pyfunc', file))))
enforce('python: ruff lint runs green across the python projects',
  tryRun('npx nx run-many -t lint --projects=pysvc,pyfunc,pyshared,pycore', altWorkspace), 'see log above')
enforce('python: pytest runs green across the python projects',
  tryRun('npx nx run-many -t test --projects=pysvc,pyfunc,pyshared,pycore', altWorkspace), 'see log above')
enforce('python: build produces a wheel for the publishable lib, standardized to root dist/',
  tryRun('npx nx build pyshared', altWorkspace)
  && existsSync(path.join(altWorkspace, 'dist/python-packages/pyshared/pyshared-1.0.0-py3-none-any.whl')))
enforce('python: apps pack into the drop as <type>-<name>.zip (fits the existing CI)',
  tryRun('npx nx run-many -t package --projects=pysvc,pyfunc', altWorkspace)
  && existsSync(path.join(altWorkspace, 'dist/drop/python-app-pysvc.zip'))
  && existsSync(path.join(altWorkspace, 'dist/drop/python-function-app-pyfunc.zip')))
// Conventional-commit versioning reaches Python: `nx release` scopes
// python-packages/*, so a dry-run tags the publishable Python lib from git
// history (same mechanism as the npm packages). Needs a committed git repo.
run('git init -q -b main && git add -A', altWorkspace)
run('git -c user.email=e2e@test -c user.name=e2e commit -q -m "feat: initial python packages"', altWorkspace)
const altReleaseDryRun = tryRunCapture('npx nx release version --dry-run --verbose', altWorkspace)
enforce('python: nx release versions the publishable python lib from conventional commits',
  altReleaseDryRun.ok && /shared[^\n]*new version/i.test(altReleaseDryRun.output) && altReleaseDryRun.output.includes('pyproject.toml'),
  altReleaseDryRun.output)

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
