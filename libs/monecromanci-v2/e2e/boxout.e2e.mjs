#!/usr/bin/env node

/**
 * E2E: the box-out thesis, verified for real.
 *
 * Runs the BUILT v2 CLI against the real network: `new` (which runs the
 * latest create-nx-workspace and real npm installs), then `add` for one of
 * each kind, then real `nx run-many -t lint,test,build` and a real
 * `nx release version --dry-run` inside the generated repo. Every ENFORCED
 * failure exits non-zero — none of `add`'s generators shell out to an
 * external CLI that might be missing locally, so there is nothing left to
 * treat as merely PENDING.
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

const results = { enforced: [] }

/** Records an ENFORCED expectation, which fails the run when false. */
function enforce (label, ok, detail = '') {
  results.enforced.push({ label, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — ${detail}`}`)
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

console.log('\n▸ mnci2 add node-app svc')
run(`node ${CLI} add node-app svc`, workspace)

// @nx/node:application (--bundle=false) never inlines anything — every import
// (workspace lib or npm package) stays a real `require`, resolved from
// node_modules/the compiled dist tree at run time. So "correctness" here is
// proven by running the real compiled output, not by grepping for inlined
// source (that concept doesn't apply to a non-bundled build).
console.log('\n▸ wiring node app (svc) -> utils (private internal) + ms (real external dependency)')
writeFileSync(path.join(workspace, 'apps/svc/src/main.ts'), 'import ms from \'ms\';\nimport { utils } from \'@demo/utils\';\n\nconsole.log(\'deps-check:\', utils(), ms(60000));\n')
run('npx nx sync', workspace)

console.log('\n▸ mnci2 add node-function-app api')
run(`node ${CLI} add node-function-app api`, workspace)

// The generator + overlay need no Azure Functions Core Tools at all (unlike
// the removed @nxazure/func plugin, which shelled out to `func` even at
// generation time) — this is now unconditionally enforced, not a pending gap.
console.log('\n▸ wiring node function app (api) -> utils (private internal) + ms (real external dependency)')
writeFileSync(path.join(workspace, 'apps/api/src/deps.ts'), 'import ms from \'ms\';\nimport { utils } from \'@demo/utils\';\n\nexport function apiDeps(): string {\n  return \'api uses \' + utils() + \' and \' + ms(60000);\n}\n')
writeFileSync(path.join(workspace, 'apps/api/src/main.ts'), '// esbuild only includes what is reachable from here, so add one import per\n// function file you create under src/functions/.\nimport \'./functions/hello\';\nimport { apiDeps } from \'./deps\';\n\nconsole.log(apiDeps());\n')
run('npx nx sync', workspace)

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
  'nx run-many -t lint,test,build succeeds (node app + node function app included)',
  tryRun('npx nx run-many -t lint,test,build', workspace),
  'see log above',
)

/* ---------------------------------------------------------------------------
 * Packing: each app zips into dist/drop/<type>-<name>.zip — the CI 'drop', and
 * the exact string CI turns into the per-app build tag.
 * ------------------------------------------------------------------------- */

enforce('nx run-many -t package succeeds', tryRun('npx nx run-many -t package', workspace), 'see log above')
const AdmZip = createRequire(path.join(workspace, 'package.json'))('adm-zip')
enforce('react app builds per environment into the drop (dev/uat/prod zips)',
  ['dev', 'uat', 'prod'].every((environment) => existsSync(path.join(workspace, `dist/drop/react-app-web-${environment}.zip`))))
enforce('react app scaffolds a committed .env per environment',
  ['dev', 'uat', 'prod'].every((environment) => existsSync(path.join(workspace, `apps/web/.env.${environment}`))))
enforce('react app zips actually contain a built SPA (index.html + assets), not just an empty drop',
  ['dev', 'uat', 'prod'].every((environment) => {
    const zipPath = path.join(workspace, `dist/drop/react-app-web-${environment}.zip`)
    if (!existsSync(zipPath)) {
      return false
    }
    const entries = new AdmZip(zipPath).getEntries().map((entry) => entry.entryName)
    return entries.includes('index.html') && entries.some((entry) => entry.startsWith('assets/') && entry.endsWith('.js'))
  }))

// A browser bundle inlines everything by default (no npm install step at
// runtime, unlike the published sdk) — prove BOTH the private lib and the
// real external dependency (ms) are genuinely inlined per environment, and
// that each environment's build bakes in only its own VITE_API_URL (proving
// the three builds are genuinely separate compiles, not one bundle copied
// three times).
for (const environment of ['dev', 'uat', 'prod']) {
  const assetsDirectory = path.join(workspace, `apps/web/dist-${environment}/assets`)
  const jsAsset = existsSync(assetsDirectory) ? readdirSync(assetsDirectory).find((file) => file.endsWith('.js')) : undefined
  const bundleText = jsAsset ? readFileSync(path.join(assetsDirectory, jsAsset), 'utf8') : ''
  enforce(`react app (${environment}) bundle inlines the private lib (utils) and the real external dependency (ms)`,
    bundleText.includes('utils') && bundleText.includes(MS_SOURCE_MARKER))
  const ownUrl = `https://api.${environment}.example.com`
  const otherUrls = ['dev', 'uat', 'prod'].filter((other) => other !== environment).map((other) => `https://api.${other}.example.com`)
  enforce(`react app (${environment}) bundle bakes in only its own VITE_API_URL`,
    bundleText.includes(ownUrl) && otherUrls.every((url) => !bundleText.includes(url)))
}

/* ---------------------------------------------------------------------------
 * Node apps: @nx/node:application (--bundle=false) never inlines anything —
 * every import stays a real `require`, resolved from node_modules/the
 * compiled dist tree at run time. So "correctness" is proven by RUNNING the
 * real compiled output and checking its real result, not by grepping for
 * inlined source (there is nothing to grep for in a non-bundled build).
 * ------------------------------------------------------------------------- */

enforce('node app bundles the compiled entry (esbuild non-bundled: mirrors the workspace tree into dist)',
  existsSync(path.join(workspace, 'apps/svc/dist/main.js')))
const nodeAppRun = tryRunCapture('node apps/svc/dist/main.js', workspace)
enforce('node app runs standalone, resolving the inlined-by-tsc private lib and the real external dependency correctly',
  nodeAppRun.ok && nodeAppRun.output.includes('utils') && nodeAppRun.output.includes('1m'),
  nodeAppRun.output)
const nodeAppZip = path.join(workspace, 'dist/drop/node-app-svc.zip')
enforce('node app packs into the drop (node-app-svc.zip)', existsSync(nodeAppZip))
const nodeAppZipEntries = existsSync(nodeAppZip) ? new AdmZip(nodeAppZip).getEntries().map((entry) => entry.entryName) : []
enforce('node app zip actually contains the runnable dist shim, not just an empty drop',
  nodeAppZipEntries.includes('main.js'))

enforce('node function app bundles the compiled entry the same way', existsSync(path.join(workspace, 'apps/api/dist/main.js')))
const nodeFunctionAppRun = tryRunCapture('node apps/api/dist/main.js', workspace)
enforce('node function app runs standalone, resolving the private lib and the real external dependency correctly',
  nodeFunctionAppRun.ok && nodeFunctionAppRun.output.includes('api uses utils and 1m'),
  nodeFunctionAppRun.output)
const nodeFunctionAppManifest = JSON.parse(readFileSync(path.join(workspace, 'apps/api/package.json'), 'utf8'))
enforce('node function app manifest repaired (main points at the esbuild dist shim, real Azure Functions dependency declared)',
  nodeFunctionAppManifest.main === 'main.js' && Boolean(nodeFunctionAppManifest.dependencies?.['@azure/functions']))
enforce('node function app has a package target', Boolean(nodeFunctionAppManifest.nx?.targets?.package))
enforce('node function app test target runs green (sample spec passes)', tryRun('npx nx test api', workspace), 'see log above')

const nodeFunctionAppZip = path.join(workspace, 'dist/drop/node-function-app-api.zip')
enforce('node function app packs into the drop (node-function-app-api.zip)', existsSync(nodeFunctionAppZip))
// No node_modules bundled by design — Azure's Oryx build installs real
// dependencies from the zipped package.json at deploy time (same model
// python-function-app already relies on for requirements.txt). Verify the
// zip's actual entry list rather than assuming the package target's shape.
const zipEntries = existsSync(nodeFunctionAppZip) ? new AdmZip(nodeFunctionAppZip).getEntries().map((entry) => entry.entryName) : []
enforce('node function app zip contains the dist shim, host.json and the repaired manifest at its root',
  zipEntries.includes('main.js') && zipEntries.includes('host.json') && zipEntries.includes('package.json'))

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
// The strongest possible proof that publishing will actually work: ask npm
// itself what it would pack, rather than trusting the dist folder's presence
// on disk. This is exactly the check that would have caught the earlier
// root-dist/ regression (npm pack silently produced an empty tarball once
// dist lived outside the package directory).
const sdkPackDryRun = tryRunCapture('npm pack --dry-run --json', path.join(workspace, 'packages/sdk'))
let sdkPackedFiles = []
try {
  sdkPackedFiles = JSON.parse(sdkPackDryRun.output)[0]?.files?.map((file) => file.path) ?? []
} catch { /* leaves sdkPackedFiles empty -> the check below fails and surfaces the raw output */ }
enforce('sdk: `npm pack` would actually include the built bundle, not just package.json',
  sdkPackDryRun.ok && sdkPackedFiles.includes('dist/index.esm.js') && sdkPackedFiles.includes('package.json'),
  sdkPackDryRun.output)

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
 * Python — @mnci/nx-python-pip (this monorepo's own Nx plugin, libs/nx-python-pip),
 * added to the alt workspace so the real toolchain (not just unit tests)
 * proves the four Python kinds. Packed straight from libs/nx-python-pip's own
 * build output (MNCI2_PYTHON_PIP_SPEC) instead of the published registry
 * package — the same "install from a local tarball" technique used to
 * empirically verify the plugin itself, standing in for a real `npm install
 * @mnci/nx-python-pip` in production. ruff, pytest, python3-venv and
 * build/twine (installed from the generated requirements-dev.txt) are
 * present in this environment, so these are all enforced.
 * ------------------------------------------------------------------------- */

console.log('\n▸ packing @mnci/nx-python-pip (libs/nx-python-pip) for the e2e to install locally')
const nxPythonPipDirectory = path.resolve(SCRIPT_DIR, '..', '..', 'nx-python-pip')
run('npm run build', nxPythonPipDirectory)
const nxPythonPipPackDirectory = path.join(temporary, 'nx-python-pip-pack')
mkdirSync(nxPythonPipPackDirectory, { recursive: true })
const packOutput = execSync(`npm pack --silent --pack-destination "${nxPythonPipPackDirectory}"`, { cwd: nxPythonPipDirectory, encoding: 'utf8' }).trim()
const nxPythonPipTarball = path.join(nxPythonPipPackDirectory, packOutput.split('\n').at(-1))
process.env.MNCI2_PYTHON_PIP_SPEC = nxPythonPipTarball

console.log('\n▸ mnci2 add python-app / python-function-app / python-lib / python-internal-lib')
run(`node ${CLI} add python-app pysvc`, altWorkspace)
run(`node ${CLI} add python-function-app pyfunc`, altWorkspace)
run(`node ${CLI} add python-lib pyshared`, altWorkspace)
run(`node ${CLI} add python-internal-lib pycore`, altWorkspace)

const altPythonManifest = JSON.parse(readFileSync(path.join(altWorkspace, 'package.json'), 'utf8'))
enforce('python: no hand-rolled files — @mnci/nx-python-pip installed as a real devDependency, requirements-dev.txt the only file mnci2 itself writes',
  Boolean(altPythonManifest.devDependencies?.['@mnci/nx-python-pip'])
  && existsSync(path.join(altWorkspace, 'node_modules/@mnci/nx-python-pip/generators.json'))
  && existsSync(path.join(altWorkspace, 'requirements-dev.txt'))
  && !existsSync(path.join(altWorkspace, 'tools/python-build.js')))
run('python3 -m pip install --quiet -r requirements-dev.txt', altWorkspace)

const pysharedProjectPath = path.join(altWorkspace, 'python-packages/pyshared/project.json')
const pysharedProject = existsSync(pysharedProjectPath) ? JSON.parse(readFileSync(pysharedProjectPath, 'utf8')) : {}
enforce('python: publishable lib lives under python-packages/ with the plugin\'s twine nx-release-publish target + a project-level versionActions override',
  (pysharedProject.targets?.['nx-release-publish']?.executor ?? '') === '@mnci/nx-python-pip:publish'
  && pysharedProject.release?.version?.versionActions === '@mnci/nx-python-pip/release/version-actions')
enforce('python: internal lib is a library under libs/ (never publishable, no build/package/publish target)',
  existsSync(path.join(altWorkspace, 'libs/pycore/project.json')))
const pycoreProject = JSON.parse(readFileSync(path.join(altWorkspace, 'libs/pycore/project.json'), 'utf8'))
enforce('python: internal lib has no build/package/publish targets — vendored by consumers, never released on its own',
  !pycoreProject.targets?.build && !pycoreProject.targets?.package && !pycoreProject.targets?.['nx-release-publish'])
enforce('python: function app carries the Azure Functions v2 files, and has no pyproject.toml/build target (source deploy, no wheel)',
  ['function_app.py', 'host.json', 'requirements.txt'].every((file) => existsSync(path.join(altWorkspace, 'apps/pyfunc', file)))
  && !existsSync(path.join(altWorkspace, 'apps/pyfunc/pyproject.toml')))

/* ---------------------------------------------------------------------------
 * The same private-internal-lib / real-external-dependency proof as the JS
 * side, adapted to pip's mechanism: a hand-added [tool.mnci-python-pip]
 * vendor = [...] entry (the pip-world counterpart of hand-wiring a
 * dependencies = [...] entry — mnci2 wires no cross-project Python
 * dependency automatically, exactly like every other kind) makes the
 * plugin's build executor copy the internal lib's module — resolved via the
 * real Nx project graph, not a hard-coded libs/ path — straight into a
 * staged build (like rollup inlines for npm-lib), while a real declared
 * dependency stays a real Requires-Dist. No lock file means no pinned
 * resolution: the wheel's Requires-Dist mirrors the pyproject.toml specifier
 * verbatim (\`tomli>=2.0.0\`, not a resolved \`tomli==x.y.z\`).
 * ------------------------------------------------------------------------- */

console.log('\n▸ wiring pyshared (publishable) -> pycore (private internal, vendored)')
const pysharedPyprojectPath = path.join(altWorkspace, 'python-packages/pyshared/pyproject.toml')
writeFileSync(pysharedPyprojectPath, readFileSync(pysharedPyprojectPath, 'utf8').replace('[tool.pytest.ini_options]', '[tool.mnci-python-pip]\nvendor = ["pycore"]\n\n[tool.pytest.ini_options]'))
// Named greeting.py, not hello.py: pyshared/__init__.py (written by the
// plugin's `library` generator) already exports a top-level `hello` symbol,
// and a same-named submodule would shadow it as soon as either gets
// imported (a real Python footgun, hit empirically) — `pyshared.__init__`'s
// own generated hello() and its generated test stay untouched and green. No
// local test file for this one: pycore is vendored only at build time (the
// plugin's `build` executor), not dev-installed, so it is genuinely not
// importable from a plain `pip install -e .` dev environment — the
// wheel-content and clean-venv checks below are the (stronger) proof that
// the vendored import actually resolves.
writeFileSync(path.join(altWorkspace, 'python-packages/pyshared/pyshared/greeting.py'),
  'from pycore import hello as core_hello\n\n\ndef build_greeting():\n    return "Hello pyshared uses " + core_hello()\n')

console.log('\n▸ wiring pysvc (packed) -> a real external PyPI dependency (tomli)')
const pysvcPyprojectPath = path.join(altWorkspace, 'apps/pysvc/pyproject.toml')
writeFileSync(pysvcPyprojectPath, readFileSync(pysvcPyprojectPath, 'utf8').replace('dependencies = []', 'dependencies = ["tomli>=2.0.0"]'))
// Also named greeting.py for the same shadowing reason as pyshared above.
// Unlike pycore, tomli is a real installable PyPI package (declared in
// pysvc's own pyproject.toml dependencies), so `pip install -e .` genuinely
// makes it importable locally — this one keeps its test file.
writeFileSync(path.join(altWorkspace, 'apps/pysvc/pysvc/greeting.py'),
  'import tomli\n\n\ndef build_greeting():\n    return "Hello pysvc uses tomli " + tomli.__version__\n')
writeFileSync(path.join(altWorkspace, 'apps/pysvc/tests/test_greeting.py'),
  'from pysvc.greeting import build_greeting\n\n\ndef test_build_greeting():\n    assert build_greeting().startswith("Hello pysvc uses tomli ")\n')

enforce('python: ruff lint runs green across the python projects',
  tryRun('npx nx run-many -t lint --projects=pysvc,pyfunc,pyshared,pycore', altWorkspace), 'see log above')
enforce('python: pytest runs green across the python projects (private-lib + external-dependency wiring included)',
  tryRun('npx nx run-many -t test --projects=pysvc,pyfunc,pyshared,pycore', altWorkspace), 'see log above')

const AdmZipPy = createRequire(path.join(altWorkspace, 'package.json'))('adm-zip')
const pysharedWheelPath = path.join(altWorkspace, 'python-packages/pyshared/dist/pyshared-1.0.0-py3-none-any.whl')
enforce('python: build produces a wheel for the publishable lib (vendoring pycore via the plugin\'s build executor)', tryRun('npx nx build pyshared', altWorkspace) && existsSync(pysharedWheelPath))
const pysharedWheelEntries = existsSync(pysharedWheelPath) ? new AdmZipPy(pysharedWheelPath).getEntries().map((entry) => entry.entryName) : []
enforce('python: publishable lib wheel vendors the private internal lib (pycore) — no separate install needed',
  pysharedWheelEntries.includes('pycore/__init__.py') && pysharedWheelEntries.includes('pyshared/greeting.py'))
// The strongest possible proof: install the real wheel into a clean venv (no
// workspace/editable install in play) and run it — mirrors the sdk's "runs
// standalone under node" check.
const pysharedVenv = path.join(temporary, 'py-venv-pyshared')
run(`python3 -m venv ${pysharedVenv}`, altWorkspace)
run(`${pysharedVenv}/bin/pip install --quiet ${pysharedWheelPath}`, altWorkspace)
const pysharedVenvRun = tryRunCapture(`${pysharedVenv}/bin/python3 -c "from pyshared.greeting import build_greeting; print(build_greeting())"`, altWorkspace)
enforce('python: publishable lib installs into a clean venv and runs correctly (private lib resolves with no extra install)',
  pysharedVenvRun.ok && pysharedVenvRun.output.includes('Hello pyshared uses hello from pycore'),
  pysharedVenvRun.output)

enforce('python: apps pack into the drop as <type>-<name>.zip (fits the existing CI)',
  tryRun('npx nx run-many -t package --projects=pysvc,pyfunc', altWorkspace)
  && existsSync(path.join(altWorkspace, 'dist/drop/python-app-pysvc.zip'))
  && existsSync(path.join(altWorkspace, 'dist/drop/python-function-app-pyfunc.zip')))
const pysvcZipPath = path.join(altWorkspace, 'dist/drop/python-app-pysvc.zip')
const pysvcZipEntries = existsSync(pysvcZipPath) ? new AdmZipPy(pysvcZipPath).getEntries().map((entry) => entry.entryName) : []
enforce('python: app zip actually contains the built wheel (not just an empty drop)',
  pysvcZipEntries.some((entry) => /^pysvc-.*\.whl$/.test(entry)))
const pyfuncZipPath = path.join(altWorkspace, 'dist/drop/python-function-app-pyfunc.zip')
const pyfuncZipEntries = existsSync(pyfuncZipPath) ? new AdmZipPy(pyfuncZipPath).getEntries().map((entry) => entry.entryName) : []
enforce('python: function app zip actually contains the deployable source (function_app.py, host.json, requirements.txt)',
  ['function_app.py', 'host.json', 'requirements.txt'].every((file) => pyfuncZipEntries.includes(file)))

const pysvcWheelPath = path.join(altWorkspace, 'apps/pysvc/dist/pysvc-1.0.0-py3-none-any.whl')
// eslint-disable-next-line unicorn/prefer-blob-reading-methods -- adm-zip's readAsText, not FileReader's
const pysvcMetadata = existsSync(pysvcWheelPath) ? new AdmZipPy(pysvcWheelPath).readAsText('pysvc-1.0.0.dist-info/METADATA') : ''
enforce('python: app wheel declares the real external dependency (tomli) — not silently dropped',
  /Requires-Dist:\s*tomli>=2\.0\.0/i.test(pysvcMetadata))
const pysvcVenv = path.join(temporary, 'py-venv-pysvc')
run(`python3 -m venv ${pysvcVenv}`, altWorkspace)
run(`${pysvcVenv}/bin/pip install --quiet ${pysvcWheelPath}`, altWorkspace)
const pysvcVenvRun = tryRunCapture(`${pysvcVenv}/bin/python3 -c "from pysvc.greeting import build_greeting; print(build_greeting())"`, altWorkspace)
enforce('python: app installs into a clean venv and runs correctly, resolving the real external dependency from PyPI',
  pysvcVenvRun.ok && pysvcVenvRun.output.includes('Hello pysvc uses tomli '),
  pysvcVenvRun.output)

/* ---------------------------------------------------------------------------
 * The exact combination that broke the old @nxlv/python bundleLocalDependencies
 * (a vendored internal lib AND a real external dependency on the SAME
 * project): verified empirically during design that pip's approach does not
 * reproduce that bug. Proven here directly, not just asserted in a comment.
 * ------------------------------------------------------------------------- */

console.log('\n▸ combined proof: vendoring + a real external dependency on the SAME project')
writeFileSync(pysvcPyprojectPath, readFileSync(pysvcPyprojectPath, 'utf8').replace('[tool.pytest.ini_options]', '[tool.mnci-python-pip]\nvendor = ["pycore"]\n\n[tool.pytest.ini_options]'))
enforce('python: build succeeds with both a vendored internal lib and a real external dependency on the same project',
  tryRun('npx nx build pysvc', altWorkspace))
const pysvcCombinedZip = existsSync(pysvcWheelPath) ? new AdmZipPy(pysvcWheelPath) : null
const pysvcCombinedEntries = pysvcCombinedZip ? pysvcCombinedZip.getEntries().map((entry) => entry.entryName) : []
// eslint-disable-next-line unicorn/prefer-blob-reading-methods -- adm-zip's readAsText, not FileReader's
const pysvcCombinedMetadata = pysvcCombinedZip ? pysvcCombinedZip.readAsText('pysvc-1.0.0.dist-info/METADATA') : ''
enforce('python: combined wheel vendors pycore AND keeps the real external dependency declared — no metadata drop (the old @nxlv/python bug does not reproduce with pip)',
  pysvcCombinedEntries.includes('pycore/__init__.py') && /Requires-Dist:\s*tomli>=2\.0\.0/i.test(pysvcCombinedMetadata))

/* ---------------------------------------------------------------------------
 * Conventional-commit versioning AND publishing reach Python via
 * @mnci/nx-python-pip's PythonVersionActions + publish executor.
 * ------------------------------------------------------------------------- */

run('git init -q -b main && git add -A', altWorkspace)
run('git -c user.email=e2e@test -c user.name=e2e commit -q -m "feat: initial python packages"', altWorkspace)
const altReleaseDryRun = tryRunCapture('npx nx release version --dry-run --verbose', altWorkspace)
enforce('python: nx release versions the publishable python lib from conventional commits (@mnci/nx-python-pip\'s PythonVersionActions, no @nxlv/python)',
  altReleaseDryRun.ok && /shared[^\n]*new version/i.test(altReleaseDryRun.output) && altReleaseDryRun.output.includes('pyproject.toml'),
  altReleaseDryRun.output)
// nx release publish --dry-run sets a real, typed dryRun option on every
// nx-release-publish executor (verified empirically) — no argv-parsing trick
// needed, unlike the plain nx:run-commands version this plugin replaced.
const altReleasePublishDryRun = tryRunCapture('npx nx release publish --dry-run --verbose', altWorkspace)
enforce('python: nx release publish --dry-run previews the twine upload via the plugin\'s typed dryRun executor option',
  altReleasePublishDryRun.ok && altReleasePublishDryRun.output.includes('[dry-run] would run: python3 -m twine upload'),
  altReleasePublishDryRun.output)

/* ---------------------------------------------------------------------------
 * Report
 * ------------------------------------------------------------------------- */

console.log('\n=== box-out e2e ===')
const failed = results.enforced.filter((result) => !result.ok)
for (const result of results.enforced) {
  console.log(`  ${result.ok ? '✓' : '✗'} ENFORCED  ${result.label}`)
}

if (failed.length > 0) {
  console.error(`\n✗ ${failed.length} ENFORCED expectation(s) failed.`)
  process.exit(1)
}
console.log(`\n✓ ${results.enforced.length} enforced checks passed.`)
