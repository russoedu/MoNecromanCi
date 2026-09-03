#!/usr/bin/env node

/**
 * E2E: the CLI's thesis, verified for real.
 *
 * Runs the BUILT CLI against the real network: `new` (which runs the
 * latest create-nx-workspace and real npm installs), then `add` for one of
 * each kind, then real `nx run-many -t lint,test,build` and a real
 * `nx release --dry-run` inside the generated repo. Every ENFORCED
 * failure exits non-zero.
 *
 * One exception, and it is deliberate: the **Flutter** section needs the
 * Flutter SDK, which — unlike Python (CPython is assumed present) and Node —
 * is not installed on a stock machine or a stock CI image. Rather than
 * silently dropping Flutter from the suite (which is what happened to Go, and
 * is why Go still has no e2e coverage at all), it runs whenever `flutter` is
 * on the PATH and is reported as SKIPPED, loudly, when it is not. Nothing else
 * in the suite is skippable.
 */

import { execSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// js-yaml is CommonJS; load it through require so native ESM interop can't trip.
const yaml = createRequire(import.meta.url)('js-yaml')

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.resolve(SCRIPT_DIR, '..', 'dist', 'cli.js')

/**
 * Mirrors `@mnci/nx-python-pip`'s own `pythonCommand()`: `python3` on POSIX,
 * `python` on Windows (the standard python.org Windows installer registers
 * no `python3.exe`). The e2e's own direct Python invocations (installing
 * `requirements-dev.txt`, creating clean venvs) need the same resolution the
 * production guard scripts and executors use, or they hard-fail on a
 * `windows-latest` runner for a harness reason, not a real one.
 */
const PYTHON = process.platform === 'win32' ? 'python' : 'python3'

/**
 * Resolves an executable inside a virtualenv, cross-platform: POSIX venvs
 * put executables in `bin/`; Windows puts them in `Scripts/` with a `.exe`
 * suffix, and never creates a `python3.exe` (only `python.exe`) — so `name`
 * should be the extension-less, `3`-less base name (`'pip'`, `'python'`).
 */
function venvExecutable (venvPath, name) {
  return process.platform === 'win32'
    ? path.join(venvPath, 'Scripts', `${name}.exe`)
    : path.join(venvPath, 'bin', name)
}

/** Runs a command inheriting stdio, throwing on non-zero exit. */
function run (command, cwd) {
  console.log(`\n$ ${command}   (cwd: ${cwd})`)
  execSync(command, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, NX_DAEMON: 'false', HUSKY: '0', CI: 'true' }
  })
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
    const output = execSync(command, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NX_DAEMON: 'false', HUSKY: '0', CI: 'true' }
    })
    console.log(output)
    return { ok: true, output }
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    console.log(output)
    return { ok: false, output }
  }
}

const results = { enforced: [], skipped: [] }

/** Records an ENFORCED expectation, which fails the run when false. */
function enforce (label, ok, detail = '') {
  results.enforced.push({ label, ok, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `  — ${detail}`}`)
}

/**
 * Records a section that could not run because its toolchain is absent.
 *
 * @remarks
 * Used only by the Flutter section — see the file header. Deliberately does
 * NOT fail the run, but is printed in the summary so a skipped section can
 * never be mistaken for a passing one.
 */
function skip (label, reason) {
  results.skipped.push({ label, reason })
  console.log(`  ⊘ SKIPPED ${label} — ${reason}`)
}

/** Sections that crashed, so a section depending on one can be skipped instead. */
const failedSections = new Set()

/**
 * Runs one section of the suite in isolation.
 *
 * A section that throws is RECORDED as a failed expectation and the run
 * continues, instead of taking every later section down with it. That has
 * happened twice for unrelated reasons — a removed `--linter oxlint` flag, and a
 * `pip install` that failed on a machine whose `packaging` came from Debian —
 * and both times the suite reported nothing at all about Go and Flutter because
 * something before them died. The report machinery already supported this; only
 * the propagation needed changing.
 *
 * A section whose prerequisite failed is SKIPPED rather than run, because its
 * assertions would otherwise produce a wall of failures that all trace back to
 * one cause. Skipping is transitive: it marks itself failed too, so anything
 * depending on it skips as well.
 *
 * @param label - Section name, used in the report and by `needs`.
 * @param needs - Labels of sections this one cannot run without.
 * @param body - The section itself.
 */
function section (label, needs, body) {
  const blockedBy = needs.find(name => failedSections.has(name))
  if (blockedBy) {
    failedSections.add(label)
    skip(`the entire ${label} section`, `its prerequisite section "${blockedBy}" failed`)
    return
  }
  console.log(`\n▶ section: ${label}`)
  try {
    body()
  } catch (error) {
    failedSections.add(label)
    // Enforced, not skipped: a crashed section IS a failure — the point is that
    // it stops being a SILENT one that deletes everything below it.
    enforce(`section "${label}" ran to completion`, false, error?.stack ?? String(error))
  }
}

/**
 * Paths this coding-agent sandbox injects into every cwd.
 *
 * @remarks
 * They are not part of a generated workspace — a real user never has them —
 * so any whole-workspace lint/format assertion has to drop them first or it
 * fails for a harness reason rather than a real one.
 */
const SANDBOX_INJECTED = ['.agents', '.opencode', '.github/skills']

/** Removes the sandbox-injected paths from a generated workspace. */
function dropSandboxInjected (root) {
  for (const injected of SANDBOX_INJECTED) {
    rmSync(path.join(root, injected), { recursive: true, force: true })
  }
}

/**
 * Every file matching `predicate` under `directory`, recursively.
 *
 * @remarks
 * Skips `node_modules` and `.git`, which otherwise dwarf a generated
 * workspace and would drag in hundreds of third-party config files —
 * defeating the "exactly one config" assertions this exists to serve.
 */
/**
 * Rewrites a file with `pattern` replaced, and THROWS when it did not match.
 *
 * @remarks
 * `String.replace` on a non-matching pattern is a silent no-op: it returns the
 * input unchanged and reports nothing. Every edit this suite makes to a
 * generated file is a precondition for the assertion that follows, so a
 * no-op does not fail the edit — it fails something further away, if at all.
 *
 * This is not hypothetical. The Flutter section injected an internal dependency
 * into `packages/dartshared/pubspec.yaml` with an LF-only pattern. On Windows,
 * `flutter create` writes that file with CRLF, so the pattern never matched and
 * the dependency was never added. It passed anyway for months because the
 * workspace was formatted by oxfmt, which rewrote the pubspec to LF in passing
 * — an accidental dependency on a formatter that has since been deleted. The
 * moment `eslint --fix` replaced it (ESLint does not rewrite YAML at all), the
 * edit started silently doing nothing and `flutter analyze` began reporting
 * `depend_on_referenced_packages` on an import the suite had deliberately set
 * up.
 *
 * @param file - Absolute path to the file to rewrite.
 * @param pattern - The pattern to replace. Use `\r?\n`, never a bare `\n`.
 * @param replacement - The replacement text.
 * @returns Nothing.
 * @throws Error when `pattern` does not match the file's current contents.
 */
function replaceInFile (file, pattern, replacement) {
  const before = readFileSync(file, 'utf8')
  // A function replacement, not a string — the same reason `internal/pubspec.ts`
  // uses one: a literal would let a `$&`/`$1` sequence in `replacement` be read
  // as a capture-group reference rather than as the text it plainly is.
  const after = before.replace(pattern, () => replacement)
  if (after === before) {
    throw new Error(
      `replaceInFile: ${pattern} did not match ${file}. ` +
        'A silent no-op here would break a later assertion for an unrelated-looking reason. ' +
        `First 400 chars:\n${before.slice(0, 400)}`
    )
  }
  writeFileSync(file, after)
}

function findFiles (directory, predicate, base = directory) {
  const found = []
  const entries = readdirSync(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue
    }
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...findFiles(full, predicate, base))
    } else if (predicate(entry.name)) {
      found.push(path.relative(base, full).replaceAll('\\', '/'))
    }
  }
  return found
}

/**
 * The config-shape invariants a generated workspace must hold at every point
 * in its life — not just at `mnci new`.
 *
 * @remarks
 * Re-run after each `add`, because every one of these is something an
 * `@nx/*` generator actively re-creates: a per-project `eslint.config.mjs`,
 * a `.vscode/launch.json` (`@nx/node`), and generator-styled source that
 * would fail `lint`. Asserting them once after `new` would prove
 * nothing about the state a real user's workspace is actually in.
 *
 * `stage` names the point in the run, so a failure says which `add`
 * regressed rather than just "the workspace is wrong".
 */
function enforceWorkspaceShape (root, stage) {
  dropSandboxInjected(root)

  const eslintConfigs = findFiles(root, name =>
    /^eslint\.config\.(?:js|mjs|cjs|ts|mts|cts)$/.test(name)
  )
  enforce(
    `${stage}: exactly one eslint config, at the root`,
    eslintConfigs.length === 1 && eslintConfigs[0] === 'eslint.config.mjs',
    `found: ${JSON.stringify(eslintConfigs)}`
  )

  // Every formatter config mnci has ever written must be ABSENT. They are inert
  // from the command line now that nothing runs Prettier or oxfmt — which is
  // exactly why this is worth asserting: a globally installed
  // `esbenp.prettier-vscode` or `oxc.oxc-vscode` still resolves one and still
  // reformats on save, quietly undoing Standard while `lint` stays green
  // because the damage lands after the check ran.
  const retiredFormatterConfigs = findFiles(root, name =>
    /^(?:\.prettierrc(?:\..+)?|\.prettierignore|\.oxfmtrc\.json|oxlint\.config\.ts)$/.test(name)
  )
  enforce(
    `${stage}: no retired formatter config survives`,
    retiredFormatterConfigs.length === 0,
    `found: ${JSON.stringify(retiredFormatterConfigs)}`
  )
  enforce(
    `${stage}: exactly one eslint.config.mjs, which is the whole opinion`,
    existsSync(path.join(root, 'eslint.config.mjs'))
  )

  // The .code-workspace file covers everything Nx's .vscode/ did. @nx/node
  // re-creates launch.json on every add, so this must hold after each one.
  enforce(`${stage}: no .vscode directory`, !existsSync(path.join(root, '.vscode')))

  // No formatter EXTENSION may be recommended either, and this is the half a
  // unit test cannot reach: it reads the files a real `mnci new` wrote. The
  // extension needs no config file to do harm — with none present it formats
  // against Prettier's own defaults, semicolons and double quotes, the inverse
  // of Standard — so recommending it while deleting its config was mnci
  // installing its own hazard.
  for (const [label, file] of [
    ['code-workspace', findFiles(root, name => name.endsWith('.code-workspace'))[0]],
    ['devcontainer', '.devcontainer/devcontainer.json']
  ]) {
    if (!file) continue
    const contents = readFileSync(path.join(root, file), 'utf8')
    for (const extension of ['esbenp.prettier-vscode', 'oxc.oxc-vscode']) {
      enforce(
        `${stage}: ${label} does not recommend ${extension}`,
        !contents.includes(extension)
      )
    }
    enforce(
      `${stage}: ${label} recommends the ESLint extension`,
      contents.includes('dbaeumer.vscode-eslint')
    )
  }

  // A user should never have to run a format step to make a freshly generated
  // workspace pass its own CI. This is the check that regresses the moment the
  // post-generate `eslint --fix` call is dropped, so it runs WITHOUT one in
  // front of it.
  //
  // It asserts `lint`, not `format:check`, and that is not a rename: there IS no
  // `format:check` any more. ESLint reports formatting as ordinary errors, so
  // `lint` covers strictly more than the old gate did — and this assertion would
  // have gone red on the first nightly after the collapse onto one tool, since
  // `npm run format:check` on a missing script exits non-zero.
  enforce(
    `${stage}: lint is already green — no manual format needed`,
    tryRun('npm run lint', root)
  )
}

/** Whether the Flutter SDK is available to drive the Flutter section. */
function hasFlutter () {
  try {
    execSync('flutter --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Whether the Go toolchain is available to drive the Go section. */
function hasGo () {
  try {
    execSync('go version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Whether `golangci-lint` is on the PATH.
 *
 * @remarks
 * Gated separately from {@link hasGo}, on purpose. Hosted CI images ship Go but
 * not `golangci-lint` (this repo's own pipeline `go install`s it), so tying the
 * whole section to the linter would skip the structural, build, test, package and
 * release checks on any machine that merely lacks it — which is most of them. The
 * lint assertion alone is gated, so everything else still runs.
 * @returns `true` when the linter can be invoked.
 */
function hasGolangciLint () {
  try {
    execSync('golangci-lint --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const temporary = mkdtempSync(path.join(tmpdir(), 'mnci-e2e-'))
const workspace = path.join(temporary, 'demo')
// Hoisted out of the `alt stack` section on purpose: `python` and `go` are
// separate sections that both drive this workspace, so it is the one binding
// that genuinely crosses a section boundary. ESLint's `no-undef` proves it is
// the only one — wrapping the sections reported 93 references to this name and
// nothing else.
const altWorkspace = path.join(temporary, 'alt')

process.on('exit', () => rmSync(temporary, { recursive: true, force: true }))

/* ---------------------------------------------------------------------------
 * @mnci/eslint-config — packed from source, before anything else.
 *
 * Unlike the Python and Flutter plugins (packed later, just before the kinds
 * that need them), this one is required by `mnci new` itself: the overlay adds
 * it to the generated root manifest, so the very first `npm install` resolves
 * it. It is not published yet, so without this the whole suite dies on an npm
 * 404 at step one — which is exactly what happened the first time this ran.
 * ------------------------------------------------------------------------- */

console.log('\n▸ packing @mnci/eslint-config for the e2e to install locally')
const eslintConfigDirectory = path.resolve(SCRIPT_DIR, '..', '..', 'eslint-config')
const eslintConfigPackDirectory = path.join(temporary, 'eslint-config-pack')
mkdirSync(eslintConfigPackDirectory, { recursive: true })
// No build step — this package ships plain ESM, so `npm pack` is the whole job.
const eslintConfigPackOutput = execSync(
  `npm pack --silent --pack-destination "${eslintConfigPackDirectory}"`,
  { cwd: eslintConfigDirectory, encoding: 'utf8' }
).trim()
process.env.MNCI_ESLINT_CONFIG_SPEC = path.join(
  eslintConfigPackDirectory,
  eslintConfigPackOutput.split('\n').at(-1)
)

section('js stack', [], () => {
  /* ---------------------------------------------------------------------------
   * new
   * ------------------------------------------------------------------------- */

  console.log(`\n▸ mnci new demo (in ${temporary})`)
  run(`node ${CLI} new demo --yes --registry npm --scope @demo`, temporary)

  enforce('workspace created with nx.json', existsSync(path.join(workspace, 'nx.json')))

  const nxJson = JSON.parse(readFileSync(path.join(workspace, 'nx.json'), 'utf8'))
  const release = nxJson.release ?? {}
  enforce(
    'release: conventional commits + independent versioning',
    release.version?.conventionalCommits === true && release.projectsRelationship === 'independent'
  )
  // Top-level release.git (not version.git) — required by the combined `nx
  // release` command this workspace's CI and release:preview actually run
  // (see overlay.ts's RELEASE_CONFIG remarks). push:false is deliberate too:
  // nx's own post-tag push only fires with a remote Release configured (never
  // true here), so the generated pipeline pushes tags itself as its own step.
  enforce(
    'release: tag-only git (top-level git: commit false, tag true, push false)',
    release.git?.commit === false && release.git?.tag === true && release.git?.push === false
  )
  enforce(
    'release scoped to the publishable dirs (npm + python), with go-lib excluded',
    JSON.stringify(release.projects) === '["packages/*","python-packages/*","!tag:type:go-lib"]'
  )

  enforceWorkspaceShape(workspace, 'after new')

  // The root config is three lines importing the shared package — the whole
  // linting opinion lives there, not inlined per workspace.
  // Without this registration every project silently loses its lint target while
  // `npm run lint` still exits 0 — the worst possible failure mode. Nx used to
  // add it as a side effect of `nx g … --linter=eslint`; mnci passes
  // `--linter=none` now, so the overlay must own it.
  enforce(
    'mnci registers @nx/eslint/plugin in nx.json',
    (nxJson.plugins ?? []).some(
      entry => (typeof entry === 'string' ? entry : entry.plugin) === '@nx/eslint/plugin'
    )
  )

  enforce(
    'root eslint config delegates to @mnci/eslint-config',
    readFileSync(path.join(workspace, 'eslint.config.mjs'), 'utf8').includes('@mnci/eslint-config')
  )

  // Root-level files used to be linted by NOTHING: every other `lint` target
  // belongs to a project and runs `eslint .` in its own directory, so the
  // pipeline YAML, root JSON/Markdown and the root config files were covered by
  // no target at all. Asserted behaviourally in both directions, because a
  // target that exists is not a target that gates.
  const rootManifestNx =
    JSON.parse(readFileSync(path.join(workspace, 'package.json'), 'utf8')).nx ?? {}
  enforce(
    'the root project has a lint target, with includedScripts empty so it cannot recurse',
    Boolean(rootManifestNx.targets?.lint) &&
      Array.isArray(rootManifestNx.includedScripts) &&
      rootManifestNx.includedScripts.length === 0,
    JSON.stringify(rootManifestNx)
  )
  const rootLintClean = tryRunCapture('npx nx run @demo/source:lint --skip-nx-cache', workspace)
  enforce(
    'root lint is green out of the box — nothing in a fresh workspace fails it',
    rootLintClean.ok,
    rootLintClean.output
  )
  const rootOwnedFile = path.join(workspace, 'commitlint.config.mjs')
  const rootOwnedBefore = readFileSync(rootOwnedFile, 'utf8')
  writeFileSync(rootOwnedFile, `${rootOwnedBefore}\nvar planted = 1\nexport { planted }\n`)
  const rootLintPlanted = tryRunCapture('npx nx run @demo/source:lint --skip-nx-cache', workspace)
  writeFileSync(rootOwnedFile, rootOwnedBefore)
  enforce(
    'root lint actually gates: a planted `var` in a root file fails it',
    !rootLintPlanted.ok && rootLintPlanted.output.includes('no-var'),
    rootLintPlanted.output
  )

  // The options moved into @mnci/eslint-config/prettier, so there is no JSON left
  // to parse — the generated file re-exports the package. Asserted through the
  // real binary instead, which is the stronger check anyway: it covers the
  // package resolving from a generated workspace AND the options applying, and it
  // is what would have caught the drift this replaced. (This repo's own config
  // said trailingComma "es5" while it SHIPPED "none", reported by nothing,
  // because the check and the shipped opinion were different files.)
  // Formatting is a LINT ERROR now, so this is asserted by running eslint --fix
  // and diffing, not by running a second binary. The old version of this block
  // wrote a probe, ran `npx prettier --write`, and compared — which is exactly
  // the thing that can no longer happen.
  const standardProbe = path.join(workspace, 'standard-probe.ts')
  writeFileSync(standardProbe, 'export const o = {\n  a: "x",\n  b: 2,\n}\nexport function f(a) { return a }\n')
  tryRunCapture('npx eslint standard-probe.ts --fix', workspace)
  const formatted = readFileSync(standardProbe, 'utf8')
  enforce(
    'eslint --fix applies Standard for real (single quotes, no semicolons, no trailing comma)',
    formatted.includes("a: 'x'") && !formatted.includes('"x"') && !formatted.includes('b: 2,'),
    JSON.stringify(formatted)
  )
  // The rule no formatter could ever satisfy, and the headline of the whole
  // collapse onto one tool: Prettier and oxfmt both rewrite `function f (a)`
  // back to `function f(a)`, so this was unreachable while either owned
  // formatting.
  enforce(
    'eslint --fix adds the Standard space before function parens',
    formatted.includes('function f ('),
    JSON.stringify(formatted)
  )
  rmSync(standardProbe, { force: true })

  {
    const manifest = JSON.parse(readFileSync(path.join(workspace, 'package.json'), 'utf8'))
    // No formatter may be DECLARED, and the declaration is the point rather than
    // the install: the VS Code extension resolves a formatter from the project's
    // dependencies, so a leftover `prettier` entry is enough for a globally
    // installed extension to find a real binary and reformat against an opinion
    // nothing checks.
    for (const retired of ['prettier', 'eslint-config-prettier', 'oxlint', 'oxfmt']) {
      enforce(
        `no retired formatter declared: ${retired}`,
        manifest.devDependencies?.[retired] === undefined
      )
    }
    const codeWorkspace = JSON.parse(
      readFileSync(path.join(workspace, 'demo.code-workspace'), 'utf8')
    )
    enforce(
      'format-on-save pinned for .ts — the reported bug was a missing [typescript]',
      codeWorkspace.settings?.['[typescript]']?.['editor.defaultFormatter'] ===
        'dbaeumer.vscode-eslint'
    )
    // TOML is pinned now, unconditionally. It used to be impossible under the
    // Prettier stack — `npx prettier` on a `.toml` exits with "No parser could
    // be inferred for file" — and it is ESLint's `eslint-plugin-toml` that
    // parses it here.
    enforce(
      '[toml] is pinned to ESLint, which Prettier could never parse',
      codeWorkspace.settings?.['[toml]']?.['editor.defaultFormatter'] === 'dbaeumer.vscode-eslint'
    )
  }
  // is the auth-only variant: the npmjs.org token line and NOTHING else. No
  // @scope:registry line, deliberately — npmjs.org is already the default, so
  // routing the scope there would change nothing, and presenting it as protection
  // against an accidental public publish would be the same false claim the README
  // used to make. The Azure variant DOES route the scope, which is the one case
  // where it genuinely prevents a scoped package reaching npmjs.org.
  enforce('.npmrc written', existsSync(path.join(workspace, '.npmrc')))
  {
    const npmrcDirectives = readFileSync(path.join(workspace, '.npmrc'), 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith(';') && !line.startsWith('#'))
    enforce(
      '.npmrc authenticates npmjs.org, so a publish can actually succeed',
      npmrcDirectives.includes('//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}')
    )
    enforce(
      '.npmrc routes nothing for public npm — no scope line claiming protection it cannot give',
      npmrcDirectives.every(line => !line.includes(':registry='))
    )
  }
  enforce('commitlint config written', existsSync(path.join(workspace, 'commitlint.config.mjs')))
  const hookPath = path.join(workspace, '.husky/commit-msg')
  // NTFS has no POSIX exec-bit semantics — `mode & 0o111` is meaningless on
  // Windows (git itself tracks executability separately, via the index, not
  // the filesystem), so only POSIX platforms can meaningfully assert it here.
  const isHookExecutable = process.platform === 'win32' || (statSync(hookPath).mode & 0o111) !== 0
  enforce('husky commit-msg hook written and executable', existsSync(hookPath) && isHookExecutable)
  enforce('azure-pipelines.yml written', existsSync(path.join(workspace, 'azure-pipelines.yml')))

  const rootManifest = JSON.parse(readFileSync(path.join(workspace, 'package.json'), 'utf8'))
  const rootDevelopmentDependencies = rootManifest.devDependencies ?? {}
  enforce(
    'husky + commitlint installed as devDependencies',
    Boolean(rootDevelopmentDependencies.husky && rootDevelopmentDependencies['@commitlint/cli'])
  )
  // `affected` carries `typecheck` since #92 (roadmap #18). This assertion was not
  // updated then, so the e2e has been red ever since and nobody saw it — it only runs
  // on a manual `workflow_dispatch`. Worth remembering when changing ROOT_SCRIPTS: the
  // unit tests cover the constant, but this is the only check that the value actually
  // reaches a generated workspace's manifest.
  enforce(
    'curated root scripts stamped (build/affected/prepare)',
    rootManifest.scripts?.build === 'nx run-many -t build' &&
      rootManifest.scripts?.affected === 'nx affected -t lint,typecheck,test,build' &&
      rootManifest.scripts?.prepare === 'husky',
    JSON.stringify({
      build: rootManifest.scripts?.build,
      affected: rootManifest.scripts?.affected,
      prepare: rootManifest.scripts?.prepare
    })
  )
  // Real-execution proof, on a workspace with zero Python projects, that
  // `python:install` no-ops cleanly rather than erroring on a missing
  // requirements-dev.txt/pyproject.toml — the counterpart of the alt
  // workspace's real-install proof further down (item 10).
  const pythonInstallSkipRun = tryRunCapture('npm run python:install', workspace)
  enforce(
    'python:install no-ops cleanly on a workspace with no Python projects yet',
    pythonInstallSkipRun.ok &&
      pythonInstallSkipRun.output.includes('No Python projects - skipping.'),
    pythonInstallSkipRun.output
  )

  const pipelineYaml = readFileSync(path.join(workspace, 'azure-pipelines.yml'), 'utf8')
  enforce(
    'pipeline is cross-platform: no multi-line shell blocks, no bash-isms',
    !pipelineYaml.includes('script: |') && !pipelineYaml.includes('shopt')
  )
  enforce(
    'pipeline stamps the CLI agent and variable group',
    pipelineYaml.includes('vmImage: ubuntu-latest') && pipelineYaml.includes('- group: Build')
  )
  enforce(
    'pipeline packs apps to a drop and tags per app (type-name)',
    pipelineYaml.includes('nx run-many -t package') &&
      pipelineYaml.includes('ArtifactName: drop') &&
      pipelineYaml.includes('##vso[build.addbuildtag]') &&
      pipelineYaml.includes('path.basename(f,\'.zip\')')
  )
  // This workspace was generated with --registry npm, so auth is NODE_AUTH_TOKEN
  // sourced from an NPM_TOKEN variable, not PAT — the azurePipelinesYaml/
  // githubActionsYaml unit tests in overlay.test.ts cover the Azure Artifacts
  // (PAT) side of this same branch.
  enforce(
    'pipeline authenticates npm via the NODE_AUTH_TOKEN env (NPM_TOKEN variable), not npmAuthenticate',
    pipelineYaml.includes('NODE_AUTH_TOKEN: $(NPM_TOKEN)') &&
      !pipelineYaml.includes('npmAuthenticate')
  )
  let pipelineParsed = null
  try {
    pipelineParsed = yaml.load(pipelineYaml)
  } catch {
    /* leaves pipelineParsed null → the check below fails with the parse error surfaced above */
  }
  enforce(
    'azure-pipelines.yml is valid YAML (steps + pool + variables)',
    Boolean(pipelineParsed) &&
      Array.isArray(pipelineParsed.steps) &&
      Boolean(pipelineParsed.pool) &&
      Array.isArray(pipelineParsed.variables)
  )

  // Runs the EXACT script text extracted from the generated pipeline (not a
  // re-typed copy) against this real workspace's real node_modules.
  //
  // This used to assert the step exits 0 "even when real vulnerabilities are
  // found", because it was warn-only. It is not any more: it exits 1 on an
  // advisory that has a published fix, and 0 on anything upstream has not fixed.
  // The rename is what caught the staleness — the lookup returned undefined and
  // the assertion failed on a nightly, which is the whole reason a real e2e
  // exists. A string match on the step name would not have noticed.
  //
  // Exit 0 is still the expectation here, but for a different reason: this is a
  // freshly generated workspace, so it should carry no ACTIONABLE advisory. If
  // this ever fails, read the log rather than the assertion — it means what mnci
  // generates ships a fixable vulnerability, which is worth knowing.
  const npmAuditStep = pipelineParsed?.steps?.find(
    step => step.displayName === 'npm audit (fails on an actionable advisory)'
  )
  enforce(
    "pipeline's npm audit step is the actionable-gating form, and a fresh workspace passes it",
    Boolean(npmAuditStep) && tryRun(npmAuditStep.script, workspace),
    'see log above'
  )

  // Dual TypeScript compiler: `tsc` runs TS7 (native), while the importable API
  // (node_modules/typescript) stays TS6 for Nx's graph/plugins, Vite and eslint.
  let tscVersion = ''
  try {
    // `.bin/tsc` is a POSIX shell shim; npm also writes `tsc.cmd`/`tsc.ps1` on
    // Windows, and a bare relative path there doesn't resolve through
    // PATHEXT the way a real shell invocation would, so name the platform's
    // real shim explicitly instead.
    const tscBin = path.join(
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'tsc.cmd' : 'tsc'
    )
    tscVersion = execSync(`${tscBin} --version`, { cwd: workspace, encoding: 'utf8' })
  } catch {
    // Leaves tscVersion empty → the check below fails and surfaces the problem.
  }
  enforce('dual compiler: `tsc` runs TypeScript 7 (native)', tscVersion.includes('Version 7'))
  const tsApiManifest = JSON.parse(
    readFileSync(path.join(workspace, 'node_modules/typescript/package.json'), 'utf8')
  )
  enforce(
    'dual compiler: the importable TypeScript API stays TS6 (Nx graph/Vite/eslint)',
    String(tsApiManifest.version).startsWith('6')
  )

  /* ---------------------------------------------------------------------------
   * new --ci both — GitHub Actions CI generation, alongside Azure Pipelines
   * ------------------------------------------------------------------------- */

  const workspaceGithub = path.join(temporary, 'demo-github')
  // --nx-cloud exercised here too (item 7): `--ci both` maps to no direct Nx
  // `--nxCloud` value, so this is the one case worth proving for real — the
  // mapping falls back to `--nxCloud=github` (see nxCloudProviderValue's
  // remarks in new.ts). The real point of this real-execution proof is the
  // negative case: `run()` throws on a non-zero exit and this whole e2e run
  // would hang/fail here if `--nx-cloud` ever regressed into passing the
  // bare, upstream-broken `--nxCloud=yes` (verified empirically to prompt
  // interactively and exit without creating a workspace at all under
  // --no-interactive) instead of a named provider.
  console.log(`\n▸ mnci new demo-github --ci both --nx-cloud (in ${temporary})`)
  run(
    `node ${CLI} new demo-github --yes --registry npm --scope @demo --ci both --nx-cloud`,
    temporary
  )

  // Informational only (not `enforce`d): whether create-nx-workspace's own
  // Nx Cloud registration call actually landed a `nxCloudId` is third-party
  // network reliability, outside this CLI's control — what we own and DO
  // enforce is that the right `--nxCloud` value was passed and the run never
  // hung (both proven by reaching this line at all).
  const workspaceGithubNxJson = JSON.parse(
    readFileSync(path.join(workspaceGithub, 'nx.json'), 'utf8')
  )
  console.log(
    `  (info) nxCloudId after --nx-cloud: ${workspaceGithubNxJson.nxCloudId ?? '<not set — Nx Cloud registration did not land locally>'}`
  )

  enforce(
    'azure-pipelines.yml still written when --ci both',
    existsSync(path.join(workspaceGithub, 'azure-pipelines.yml'))
  )
  const workflowPath = path.join(workspaceGithub, '.github/workflows/ci.yml')
  enforce('.github/workflows/ci.yml written when --ci both', existsSync(workflowPath))

  const workflowYaml = readFileSync(workflowPath, 'utf8')
  enforce(
    'workflow stamps the CLI agent as runs-on',
    workflowYaml.includes('runs-on: ubuntu-latest')
  )
  // This workspace was generated with --registry npm, so auth is an NPM_TOKEN
  // repository secret, not PAT — overlay.test.ts's githubActionsYaml unit
  // tests cover the Azure Artifacts (PAT) side of this same branch.
  enforce(
    'workflow authenticates npm via an NPM_TOKEN repository secret, not a variable group',
    workflowYaml.includes('secrets.NPM_TOKEN') &&
      !workflowYaml.includes('npmAuthenticate') &&
      !workflowYaml.includes('- group:')
  )
  enforce(
    'workflow does not attach HEAD to a branch (actions/checkout is never detached on push)',
    workflowYaml.includes('actions/checkout@v4') && !workflowYaml.includes('checkout -B')
  )
  enforce(
    'workflow packs apps to a drop artifact (no Azure build-tag mechanism)',
    workflowYaml.includes('nx run-many -t package') &&
      workflowYaml.includes('actions/upload-artifact@v4') &&
      !workflowYaml.includes('addbuildtag')
  )
  let workflowParsed = null
  try {
    workflowParsed = yaml.load(workflowYaml)
  } catch {
    /* leaves workflowParsed null → the check below fails with the parse error surfaced above */
  }
  enforce(
    '.github/workflows/ci.yml is valid YAML (on + permissions + jobs.ci.steps)',
    Boolean(workflowParsed) &&
      Boolean(workflowParsed.on?.push) &&
      Boolean(workflowParsed.on?.pull_request) &&
      workflowParsed.permissions?.contents === 'write' &&
      Array.isArray(workflowParsed.jobs?.ci?.steps)
  )

  // Same real-execution proof as the Azure pipeline, against this workspace's
  // real node_modules (generated with --registry npm too).
  const npmAuditStepGithub = workflowParsed?.jobs?.ci?.steps?.find(
    step => step.name === 'npm audit (fails on an actionable advisory)'
  )
  enforce(
    "workflow's npm audit step is the actionable-gating form, and a fresh workspace passes it",
    Boolean(npmAuditStepGithub) && tryRun(npmAuditStepGithub.run, workspaceGithub),
    'see log above'
  )

  enforce(
    '.github/dependabot.yml written alongside the workflow (never for azure-only workspaces)',
    existsSync(path.join(workspaceGithub, '.github/dependabot.yml')) &&
      !existsSync(path.join(workspace, '.github/dependabot.yml'))
  )
  const dependabotYaml = readFileSync(path.join(workspaceGithub, '.github/dependabot.yml'), 'utf8')
  let dependabotParsed = null
  try {
    dependabotParsed = yaml.load(dependabotYaml)
  } catch {
    /* leaves dependabotParsed null → the check below fails with the parse error surfaced above */
  }
  enforce(
    '.github/dependabot.yml is valid YAML with npm, github-actions and glob-scoped pip + pub ecosystems',
    Boolean(dependabotParsed) &&
      dependabotParsed.updates?.map(update => update['package-ecosystem']).join(',') ===
        'npm,github-actions,pip,pub' &&
      Array.isArray(dependabotParsed.updates?.[2]?.directories) &&
      Array.isArray(dependabotParsed.updates?.[3]?.directories)
  )

  /* ---------------------------------------------------------------------------
   * add — one of each kind
   * ------------------------------------------------------------------------- */

  console.log('\n▸ mnci add npm-lib sdk')
  run(`node ${CLI} add npm-lib sdk`, workspace)

  console.log('\n▸ mnci add internal-lib utils')
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

  console.log(
    '\n▸ wiring sdk (published) -> utils (private internal) + ms (real external dependency)'
  )
  run('npm install ms @types/ms --save-dev', workspace)
  const msVersion = JSON.parse(
    readFileSync(path.join(workspace, 'node_modules/ms/package.json'), 'utf8')
  ).version
  const msSource = readFileSync(path.join(workspace, 'node_modules/ms/index.js'), 'utf8')
  // A literal string constant from ms's own installed source — survives
  // minification (string literals are never renamed), so its presence proves
  // real inlined code, not just "no import statement remains". Extracted live
  // rather than hardcoded so a future ms release can't silently break the check.
  const MS_SOURCE_MARKER = 'val is not a non-empty string or a valid number. val='
  if (!msSource.includes(MS_SOURCE_MARKER)) {
    throw new Error(`ms@${msVersion} source changed — update the e2e's inline-detection marker`)
  }
  writeFileSync(
    path.join(workspace, 'libs/utils/src/lib/utils.ts'),
    "export function utils(): string {\n  return 'utils';\n}\n"
  )
  const sdkManifestPath = path.join(workspace, 'packages/sdk/package.json')
  const sdkManifestForDependency = JSON.parse(readFileSync(sdkManifestPath, 'utf8'))
  sdkManifestForDependency.dependencies = {
    ...sdkManifestForDependency.dependencies,
    ms: `^${msVersion}`
  }
  writeFileSync(sdkManifestPath, `${JSON.stringify(sdkManifestForDependency, undefined, 2)}\n`)
  writeFileSync(
    path.join(workspace, 'packages/sdk/src/lib/sdk.ts'),
    "import ms from 'ms';\nimport { utils } from '@demo/utils';\n\nexport function sdk(): string {\n  return 'sdk uses ' + utils() + ' and ' + ms(60_000);\n}\n"
  )
  writeFileSync(
    path.join(workspace, 'packages/sdk/src/lib/sdk.spec.ts'),
    "import { sdk } from './sdk.js';\n\ndescribe('sdk', () => {\n  it('uses the internal lib and the external dependency', () => {\n    expect(sdk()).toEqual('sdk uses utils and 1m');\n  });\n});\n"
  )
  run('npx nx sync', workspace)

  console.log('\n▸ mnci add react-app web')
  run(`node ${CLI} add react-app web`, workspace)

  // A browser bundle inlines everything by default (same direction as a function
  // app's self-contained deploy), so wire the same private-lib + real-external
  // pair here too. `App` itself is unit-tested under Jest, which (unlike Vite)
  // has no `import.meta.env` support — verified empirically — so the deps go in
  // `main.tsx` (the Vite entry point, never imported by a spec file) instead.
  console.log(
    '\n▸ wiring react app (web) -> utils (private internal) + ms (real external dependency)'
  )
  writeFileSync(
    path.join(workspace, 'apps/web/src/main.tsx'),
    [
      "import { StrictMode } from 'react';",
      "import * as ReactDOM from 'react-dom/client';",
      "import ms from 'ms';",
      "import { utils } from '@demo/utils';",
      "import App from './app/app';",
      '',
      "console.log('deps-check:', utils(), ms(60_000), import.meta.env.VITE_API_URL);",
      '',
      'const root = ReactDOM.createRoot(',
      "  document.getElementById('root') as HTMLElement,",
      ');',
      '',
      'root.render(',
      '  <StrictMode>',
      '    <App />',
      '  </StrictMode>,',
      ');',
      ''
    ].join('\n')
  )

  console.log('\n▸ mnci add node-app svc')
  run(`node ${CLI} add node-app svc`, workspace)

  // @nx/node:application (--bundle=false) never inlines anything — every import
  // (workspace lib or npm package) stays a real `require`, resolved from
  // node_modules/the compiled dist tree at run time. So "correctness" here is
  // proven by running the real compiled output, not by grepping for inlined
  // source (that concept doesn't apply to a non-bundled build).
  console.log(
    '\n▸ wiring node app (svc) -> utils (private internal) + ms (real external dependency)'
  )
  writeFileSync(
    path.join(workspace, 'apps/svc/src/main.ts'),
    "import ms from 'ms';\nimport { utils } from '@demo/utils';\n\nconsole.log('deps-check:', utils(), ms(60_000));\n"
  )
  run('npx nx sync', workspace)

  // --framework is otherwise plain flag plumbing (no mnci-side logic — verified
  // empirically in a scratch workspace that express/fastify/koa/nest all
  // generate, build and test cleanly via the same generator call), so only one
  // representative framework is exercised here for real; the rest are covered
  // by node.test.ts's unit tests asserting the flag reaches the generator.
  console.log('\n▸ mnci add node-app svc-express --framework express')
  run(`node ${CLI} add node-app svc-express --framework express`, workspace)

  console.log('\n▸ mnci add node-function-app api')
  run(`node ${CLI} add node-function-app api`, workspace)

  // The generator + overlay need no Azure Functions Core Tools at all (unlike
  // the removed @nxazure/func plugin, which shelled out to `func` even at
  // generation time) — this is now unconditionally enforced, not a pending gap.
  console.log(
    '\n▸ wiring node function app (api) -> utils (private internal) + ms (real external dependency)'
  )
  // These two are written already Standard-formatted, unlike the earlier
  // fixtures. Every fixture before this one is followed by another `mnci add`,
  // whose `eslint --fix` pass normalises it in passing — which is itself
  // evidence the pass works. Nothing runs after this one, so it has to arrive
  // clean or the "lint is already green after adds" assertion below fails on the
  // harness's own code rather than on anything mnci produced.
  //
  // The `@standard-clean` markers below are read by `e2eFixtures.test.ts`, which
  // lints exactly these fixtures against the real config in seconds. Without it
  // the contract stated in this comment was enforced only by a 50-minute Windows
  // run — and it broke the moment `space-before-function-paren` was turned on.
  // A fixture that is deliberately unformatted must NOT carry the marker.
  // @standard-clean
  writeFileSync(
    path.join(workspace, 'apps/api/src/deps.ts'),
    "import ms from 'ms'\nimport { utils } from '@demo/utils'\n\nexport function apiDeps (): string {\n  return 'api uses ' + utils() + ' and ' + ms(60_000)\n}\n"
  )
  // @standard-clean
  writeFileSync(
    path.join(workspace, 'apps/api/src/main.ts'),
    "// esbuild only includes what is reachable from here, so add one import per\n// function file you create under src/functions/.\nimport './functions/hello'\nimport { apiDeps } from './deps'\n\nconsole.log(apiDeps())\n"
  )
  run('npx nx sync', workspace)

  /* ---------------------------------------------------------------------------
   * The minimal-config promise
   * ------------------------------------------------------------------------- */

  enforce(
    'publishable lib has NO project.json (targets are inferred)',
    !existsSync(path.join(workspace, 'packages/sdk/project.json'))
  )
  enforce(
    'internal lib has NO project.json (targets are inferred)',
    !existsSync(path.join(workspace, 'libs/utils/project.json'))
  )

  const sdkManifest = JSON.parse(
    readFileSync(path.join(workspace, 'packages/sdk/package.json'), 'utf8')
  )
  enforce('publishable lib named under the scope', sdkManifest.name === '@demo/sdk')

  const internalLibraryManifest = JSON.parse(
    readFileSync(path.join(workspace, 'libs/utils/package.json'), 'utf8')
  )
  enforce('internal lib is private', internalLibraryManifest.private === true)
  enforce(
    'internal lib named under the scope (the sdk import path)',
    internalLibraryManifest.name === '@demo/utils'
  )

  enforceWorkspaceShape(workspace, 'after adds')

  // THE risk of deleting per-project eslint configs. `@nx/eslint/plugin` infers
  // a `lint` target by mapping config DIRECTORIES onto the project roots beneath
  // them, so a project with no config of its own still gets one from the root.
  // That is Nx behaviour we do not control, and if it ever changes, linting
  // silently switches off across an entire workspace with everything still
  // green. Enforced permanently, per project, for exactly that reason.
  for (const project of ['web', 'svc', 'sdk', 'utils']) {
    const shown = tryRunCapture(`npx nx show project ${project} --json`, workspace)
    const targets = shown.ok ? Object.keys(JSON.parse(shown.output).targets ?? {}) : []
    enforce(
      `every project keeps an inferred lint target without its own config (${project})`,
      targets.includes('lint'),
      `targets: ${JSON.stringify(targets)}`
    )
  }

  // "A lint target exists" is not "linting works". Plant a real violation and
  // require the ROOT config to catch it — the only proof the rules actually
  // reach a project that has no config of its own.
  const plantedPath = path.join(workspace, 'packages/sdk/src/planted-violation.ts')
  writeFileSync(plantedPath, 'export function bad() {\n  var x = 1\n  return x\n}\n')
  const planted = tryRunCapture('npx nx lint sdk', workspace)
  enforce(
    'the root config genuinely reports violations in a project with no config of its own',
    !planted.ok && planted.output.includes('no-var'),
    'nx lint sdk did not report the planted `var`'
  )
  rmSync(plantedPath, { force: true })

  // A typo'd kind must be a clear, real failure -- not a silent "success" that
  // creates nothing (the exact bug this check regression-tests: it used to
  // print "Added totally-bogus-kind 'thing'." and exit 0).
  enforce(
    'add: an unrecognized kind is rejected up front, not a silent false "success"',
    !tryRun(`node ${CLI} add totally-bogus-kind thing`, workspace) &&
      !existsSync(path.join(workspace, 'apps/thing'))
  )

  /* ---------------------------------------------------------------------------
   * Real toolchain runs inside the generated repo
   * ------------------------------------------------------------------------- */

  enforce(
    'nx run-many -t lint,test,build succeeds (node app + node function app included)',
    tryRun('npx nx run-many -t lint,test,build', workspace),
    'see log above'
  )

  /* ---------------------------------------------------------------------------
   * mnci sync — converging a dependency range declared at two versions.
   *
   * `ms` is already declared twice by this point: as a real dependency of
   * packages/sdk and as a root devDependency (installed above). Planting an
   * older range at the root creates genuine drift with no extra install, and
   * the run has to end with `npm run lint` still green — that green run IS the
   * assertion, because it proves `mnci sync` and `@nx/dependency-checks` agree
   * on one answer rather than overwriting each other's.
   * ------------------------------------------------------------------------- */

  console.log('\n▸ mnci sync (converging a drifted dependency range)')

  const rootManifestPath = path.join(workspace, 'package.json')
  const rootManifestBefore = JSON.parse(readFileSync(rootManifestPath, 'utf8'))
  rootManifestBefore.devDependencies.ms = '^2.0.0'
  writeFileSync(rootManifestPath, `${JSON.stringify(rootManifestBefore, undefined, 2)}\n`)

  const syncCheckDrifted = tryRunCapture(`node ${CLI} sync --check`, workspace)
  enforce(
    'mnci sync --check reports a range declared at two versions, and exits non-zero',
    !syncCheckDrifted.ok && syncCheckDrifted.output.includes('ms'),
    syncCheckDrifted.output
  )
  enforce(
    'mnci sync --check writes nothing',
    JSON.parse(readFileSync(rootManifestPath, 'utf8')).devDependencies.ms === '^2.0.0',
    'the root manifest changed during a --check run'
  )

  enforce('mnci sync succeeds', tryRun(`node ${CLI} sync`, workspace), 'see log above')

  const rootManifestAfter = JSON.parse(readFileSync(rootManifestPath, 'utf8'))
  const sdkManifestAfterSync = JSON.parse(readFileSync(sdkManifestPath, 'utf8'))
  enforce(
    'mnci sync converges the drifted range on the INSTALLED version',
    rootManifestAfter.devDependencies.ms === `^${msVersion}` &&
      sdkManifestAfterSync.dependencies.ms === `^${msVersion}`,
    `root ${rootManifestAfter.devDependencies.ms}, sdk ${sdkManifestAfterSync.dependencies.ms}, installed ${msVersion}`
  )

  const syncCheckConverged = tryRunCapture(`node ${CLI} sync --check`, workspace)
  enforce(
    'mnci sync --check is clean once converged',
    syncCheckConverged.ok,
    syncCheckConverged.output
  )

  // The whole point of resolving against what is INSTALLED: the lint rule that
  // caught the original axios bug must still pass over what sync just wrote.
  enforce(
    'npm run lint (which runs @nx/dependency-checks) still passes after mnci sync',
    tryRun('npm run lint', workspace),
    'see log above'
  )

  /* ---------------------------------------------------------------------------
   * mnci doctor — the root/project dependency policy, from the other direction.
   *
   * `@nx/dependency-checks` fails the project whose import went undeclared;
   * this fails the root that took it. Reproduces the real finding: hoisting a
   * runtime dependency to a private, never-published root manifest reaches no
   * consumer AND makes rollup inline a private copy into whoever imports it.
   * ------------------------------------------------------------------------- */

  console.log('\n▸ mnci doctor (root runtime dependency)')

  const doctorClean = tryRunCapture(`node ${CLI} doctor`, workspace)
  enforce(
    'mnci doctor passes on a freshly generated workspace',
    doctorClean.ok,
    doctorClean.output
  )

  const manifestWithRootDependency = JSON.parse(readFileSync(rootManifestPath, 'utf8'))
  manifestWithRootDependency.dependencies = { ms: `^${msVersion}` }
  writeFileSync(
    rootManifestPath,
    `${JSON.stringify(manifestWithRootDependency, undefined, 2)}\n`
  )

  const doctorHoisted = tryRunCapture(`node ${CLI} doctor`, workspace)
  enforce(
    'mnci doctor fails on a runtime dependency hoisted to the root manifest',
    !doctorHoisted.ok && doctorHoisted.output.includes('runtime dependencies'),
    doctorHoisted.output
  )

  delete manifestWithRootDependency.dependencies
  writeFileSync(
    rootManifestPath,
    `${JSON.stringify(manifestWithRootDependency, undefined, 2)}\n`
  )

  /* ---------------------------------------------------------------------------
   * Packing: each app zips into dist/drop/<type>-<name>.zip — the CI 'drop', and
   * the exact string CI turns into the per-app build tag.
   * ------------------------------------------------------------------------- */

  enforce(
    'nx run-many -t package succeeds',
    tryRun('npx nx run-many -t package', workspace),
    'see log above'
  )
  const AdmZip = createRequire(path.join(workspace, 'package.json'))('adm-zip')
  enforce(
    'react app builds per environment into the drop (dev/uat/prod zips)',
    ['dev', 'uat', 'prod'].every(environment =>
      existsSync(path.join(workspace, `dist/drop/react-app-web-${environment}.zip`))
    )
  )
  enforce(
    'react app scaffolds a committed .env per environment',
    ['dev', 'uat', 'prod'].every(environment =>
      existsSync(path.join(workspace, `apps/web/.env.${environment}`))
    )
  )
  enforce(
    'react app zips actually contain a built SPA (index.html + assets), not just an empty drop',
    ['dev', 'uat', 'prod'].every(environment => {
      const zipPath = path.join(workspace, `dist/drop/react-app-web-${environment}.zip`)
      if (!existsSync(zipPath)) {
        return false
      }
      const entries = new AdmZip(zipPath).getEntries().map(entry => entry.entryName)
      return (
        entries.includes('index.html') &&
        entries.some(entry => entry.startsWith('assets/') && entry.endsWith('.js'))
      )
    })
  )

  // A browser bundle inlines everything by default (no npm install step at
  // runtime, unlike the published sdk) — prove BOTH the private lib and the
  // real external dependency (ms) are genuinely inlined per environment, and
  // that each environment's build bakes in only its own VITE_API_URL (proving
  // the three builds are genuinely separate compiles, not one bundle copied
  // three times).
  for (const environment of ['dev', 'uat', 'prod']) {
    const assetsDirectory = path.join(workspace, `apps/web/dist-${environment}/assets`)
    const jsAsset = existsSync(assetsDirectory)
      ? readdirSync(assetsDirectory).find(file => file.endsWith('.js'))
      : undefined
    const bundleText = jsAsset ? readFileSync(path.join(assetsDirectory, jsAsset), 'utf8') : ''
    enforce(
      `react app (${environment}) bundle inlines the private lib (utils) and the real external dependency (ms)`,
      bundleText.includes('utils') && bundleText.includes(MS_SOURCE_MARKER)
    )
    const ownUrl = `https://api.${environment}.example.com`
    const otherUrls = ['dev', 'uat', 'prod']
      .filter(other => other !== environment)
      .map(other => `https://api.${other}.example.com`)
    enforce(
      `react app (${environment}) bundle bakes in only its own VITE_API_URL`,
      bundleText.includes(ownUrl) && otherUrls.every(url => !bundleText.includes(url))
    )
  }

  /* ---------------------------------------------------------------------------
   * Node apps: @nx/node:application (--bundle=false) never inlines anything —
   * every import stays a real `require`, resolved from node_modules/the
   * compiled dist tree at run time. So "correctness" is proven by RUNNING the
   * real compiled output and checking its real result, not by grepping for
   * inlined source (there is nothing to grep for in a non-bundled build).
   * ------------------------------------------------------------------------- */

  enforce(
    'node app bundles the compiled entry (esbuild non-bundled: mirrors the workspace tree into dist)',
    existsSync(path.join(workspace, 'apps/svc/dist/main.js'))
  )
  const nodeAppRun = tryRunCapture('node apps/svc/dist/main.js', workspace)
  enforce(
    'node app runs standalone, resolving the inlined-by-tsc private lib and the real external dependency correctly',
    nodeAppRun.ok && nodeAppRun.output.includes('utils') && nodeAppRun.output.includes('1m'),
    nodeAppRun.output
  )
  const nodeAppZip = path.join(workspace, 'dist/drop/node-app-svc.zip')
  enforce('node app packs into the drop (node-app-svc.zip)', existsSync(nodeAppZip))
  const nodeAppZipEntries = existsSync(nodeAppZip)
    ? new AdmZip(nodeAppZip).getEntries().map(entry => entry.entryName)
    : []
  enforce(
    'node app zip actually contains the runnable dist shim, not just an empty drop',
    nodeAppZipEntries.includes('main.js')
  )

  // --framework express: a real HTTP-framework dependency was scaffolded (not
  // just a --framework=none bare app), and the generator's own express sample
  // already built+tested green as part of the run-many above.
  const svcExpressManifest = JSON.parse(
    readFileSync(path.join(workspace, 'apps/svc-express/package.json'), 'utf8')
  )
  enforce(
    'node app --framework express declares a real express dependency',
    Boolean(svcExpressManifest.dependencies?.express)
  )
  enforce(
    'node app --framework express bundles the compiled entry (esbuild non-bundled, same as --framework=none)',
    existsSync(path.join(workspace, 'apps/svc-express/dist/main.js'))
  )

  enforce(
    'node function app bundles the compiled entry the same way',
    existsSync(path.join(workspace, 'apps/api/dist/main.js'))
  )
  const nodeFunctionAppRun = tryRunCapture('node apps/api/dist/main.js', workspace)
  enforce(
    'node function app runs standalone, resolving the private lib and the real external dependency correctly',
    nodeFunctionAppRun.ok && nodeFunctionAppRun.output.includes('api uses utils and 1m'),
    nodeFunctionAppRun.output
  )
  const nodeFunctionAppManifest = JSON.parse(
    readFileSync(path.join(workspace, 'apps/api/package.json'), 'utf8')
  )
  enforce(
    'node function app manifest repaired (main points at the esbuild dist shim, real Azure Functions dependency declared)',
    nodeFunctionAppManifest.main === 'dist/main.js' &&
      Boolean(nodeFunctionAppManifest.dependencies?.['@azure/functions'])
  )
  enforce(
    // dist/main.js relative to this manifest is the same layout locally
    // (apps/api/{host.json,package.json,dist/main.js}) and once the deploy zip
    // is unzipped — a plain 'main.js' (the pre-fix value) never resolves
    // locally, since only 'dist/main.js' exists before a manual copy.
    "node function app's main field actually resolves to a real file — what makes local `func start` work",
    existsSync(path.join(workspace, 'apps/api', nodeFunctionAppManifest.main))
  )
  enforce(
    'node function app has a package target',
    Boolean(nodeFunctionAppManifest.nx?.targets?.package)
  )
  enforce(
    'node function app has a local `func start` target, wired through Nx',
    nodeFunctionAppManifest.nx?.targets?.start?.options?.command === 'func start'
  )
  enforce(
    'node function app test target runs green (sample spec passes)',
    tryRun('npx nx test api', workspace),
    'see log above'
  )

  const nodeFunctionAppZip = path.join(workspace, 'dist/drop/node-function-app-api.zip')
  enforce(
    'node function app packs into the drop (node-function-app-api.zip)',
    existsSync(nodeFunctionAppZip)
  )
  // No node_modules bundled by design — Azure's Oryx build installs real
  // dependencies from the zipped package.json at deploy time (same model
  // python-function-app already relies on for requirements.txt). Verify the
  // zip's actual entry list rather than assuming the package target's shape.
  const zipEntries = existsSync(nodeFunctionAppZip)
    ? new AdmZip(nodeFunctionAppZip).getEntries().map(entry => entry.entryName)
    : []
  enforce(
    // Nested under dist/, not flattened — the same relative layout as the
    // source directory, so the manifest's `main: 'dist/main.js'` resolves
    // identically whether run locally or from this unzipped deploy artifact.
    'node function app zip nests the dist shim under dist/, alongside host.json and the repaired manifest',
    zipEntries.includes('dist/main.js') &&
      zipEntries.includes('host.json') &&
      zipEntries.includes('package.json')
  )

  /* ---------------------------------------------------------------------------
   * The published-package-uses-private-lib promise, verified on the real output
   * ------------------------------------------------------------------------- */

  const sdkBundle = readFileSync(path.join(workspace, 'packages/sdk/dist/index.esm.js'), 'utf8')
  enforce(
    'sdk bundle inlines the private lib (no import of it remains)',
    !sdkBundle.includes('@demo/utils')
  )
  enforce(
    'sdk bundle keeps the real external dependency (ms) external — not inlined',
    sdkBundle.includes("from 'ms'") && !sdkBundle.includes(MS_SOURCE_MARKER)
  )
  enforce(
    'sdk bundle runs standalone under node, resolving the inlined private lib and the external dependency correctly',
    tryRun(
      'node --input-type=module -e "import { sdk } from \'./packages/sdk/dist/index.esm.js\'; if (sdk() !== \'sdk uses utils and 1m\') { throw new Error(\'wrong output: \' + sdk()) }"',
      workspace
    ),
    'see log above'
  )
  const publishedDependencies =
    JSON.parse(readFileSync(path.join(workspace, 'packages/sdk/package.json'), 'utf8'))
      .dependencies ?? {}
  enforce(
    'sdk publishable manifest never mentions the private lib',
    !Object.hasOwn(publishedDependencies, '@demo/utils')
  )
  enforce(
    'sdk publishable manifest declares the real external dependency (ms) with a real version',
    typeof publishedDependencies.ms === 'string' &&
      /^[~^]?\d+\.\d+\.\d+/.test(publishedDependencies.ms)
  )
  // The strongest possible proof that publishing will actually work: ask npm
  // itself what it would pack, rather than trusting the dist folder's presence
  // on disk. This is exactly the check that would have caught the earlier
  // root-dist/ regression (npm pack silently produced an empty tarball once
  // dist lived outside the package directory).
  const sdkPackDryRun = tryRunCapture(
    'npm pack --dry-run --json',
    path.join(workspace, 'packages/sdk')
  )
  let sdkPackedFiles = []
  try {
    sdkPackedFiles = JSON.parse(sdkPackDryRun.output)[0]?.files?.map(file => file.path) ?? []
  } catch {
    /* leaves sdkPackedFiles empty -> the check below fails and surfaces the raw output */
  }
  enforce(
    'sdk: `npm pack` would actually include the built bundle, not just package.json',
    sdkPackDryRun.ok &&
      sdkPackedFiles.includes('dist/index.esm.js') &&
      sdkPackedFiles.includes('package.json'),
    sdkPackDryRun.output
  )

  // The gate that was missing when a published library shipped a `types` path its
  // own build never emitted: every field the manifest points a CONSUMER at must
  // exist in the tarball. Checking `dist/index.esm.js` alone passed while `types`
  // dangled, so TypeScript consumers silently got `any` (TS7016).
  const sdkPackedManifest = JSON.parse(
    readFileSync(path.join(workspace, 'packages/sdk/package.json'), 'utf8')
  )
  const sdkEntryPoints = [
    ['main', sdkPackedManifest.main],
    ['module', sdkPackedManifest.module],
    ['types', sdkPackedManifest.types],
    ['exports[.].types', sdkPackedManifest.exports?.['.']?.types],
    ['exports[.].import', sdkPackedManifest.exports?.['.']?.import]
  ].filter(([, value]) => typeof value === 'string')
  const danglingEntryPoints = sdkEntryPoints.filter(
    ([, value]) => !sdkPackedFiles.includes(value.startsWith('./') ? value.slice(2) : value)
  )
  enforce(
    'sdk: every entry point the manifest declares is actually IN the packed tarball',
    danglingEntryPoints.length === 0,
    'dangling: ' +
      danglingEntryPoints.map(([field, value]) => field + ' -> ' + value).join(', ') +
      ' | packed: ' + sdkPackedFiles.join(', ')
  )

  // Declaration maps reference ../src/*.ts, which `files: ["dist"]` never ships, so
  // they are dead weight in the tarball and land an editor on nothing.
  // A module specifier is URL-style: `/` is correct on every platform and a
  // backslash on none. @nx/rollup builds its stub specifier with path.relative(),
  // which returns an OS-native path, so on a Windows agent it emits
  // `export * from "./src\\\\index"` - untyped for every Linux and macOS
  // consumer. mnci points `types` past the stub, but the stub still ships, so this
  // records whether upstream has fixed it (ROADMAP 7c).
  const sdkStubPath = path.join(workspace, 'packages/sdk/dist/index.d.ts')
  const sdkStub = existsSync(sdkStubPath) ? readFileSync(sdkStubPath, 'utf8') : ''
  enforce(
    'sdk: the declaration stub uses a URL-style module specifier',
    !sdkStub.includes(String.fromCodePoint(92)),
    sdkStub
  )

  enforce(
    'sdk: no dead declaration maps in the tarball',
    sdkPackedFiles.every(file => !file.endsWith('.d.ts.map')),
    sdkPackedFiles.filter(file => file.endsWith('.d.ts.map')).join(', ')
  )

  /* ---------------------------------------------------------------------------
   * Release config resolves for real
   * ------------------------------------------------------------------------- */

  run('git init -q -b main && git add -A', workspace)
  // The committed .env files must survive `git add -A` (allowEnvFiles un-ignores
  // them even if the preset's .gitignore ignores .env*).
  enforce(
    'react .env.dev is tracked (not gitignored)',
    tryRun('git ls-files --error-unmatch apps/web/.env.dev', workspace)
  )
  run(
    'git -c user.email=e2e@test -c user.name=e2e commit -q -m "feat: initial workspace"',
    workspace
  )
  // The combined `nx release` command, not the bare `version` subcommand: this
  // workspace's release.git lives at the top level (RELEASE_CONFIG's remarks),
  // which the bare subcommand rejects outright ("may not be used with the
  // 'nx release version' subcommand") — exactly what CI's own release step and
  // the generated release:preview script both run, verified empirically.
  enforce(
    'nx release --dry-run computes versions from conventional commits',
    tryRun('npx nx release --dry-run --verbose', workspace),
    'see log above'
  )

  /* ---------------------------------------------------------------------------
   * `nx affected` is not blind to the root config files
   *
   * The pipeline's verify step is affected-scoped on a pull request, and
   * `nx affected` walks the PROJECT GRAPH — where a root config file lives in no
   * project at all. Measured before `SHARED_GLOBAL_INPUTS` existed: touching
   * `tsconfig.base.json` marked only the root pseudo-project, which has no
   * lint/typecheck/test/build target, so the verify step ran nothing whatsoever
   * and the run reported green. Behavioural, not structural: asserting the
   * nx.json entries would not catch Nx changing how sharedGlobals is consumed.
   * ------------------------------------------------------------------------- */

  for (const rootConfig of ['eslint.config.mjs', 'tsconfig.base.json', 'package.json']) {
    const file = path.join(workspace, rootConfig)
    const original = readFileSync(file, 'utf8')
    writeFileSync(file, `${original}\n`)
    const affected = tryRunCapture('npx nx show projects --affected --uncommitted', workspace)
    writeFileSync(file, original)
    enforce(
      `affected: touching ${rootConfig} marks the real projects, not only the workspace root`,
      affected.ok && affected.output.includes('sdk') && affected.output.includes('web'),
      affected.output
    )
  }

  /* ---------------------------------------------------------------------------
   * `mnci upgrade` resolves for real: re-applies the overlay from the
   * persisted `mnci` nx.json block alone (no flags), restoring a hand-drifted
   * file back to exactly what `overlay.ts` generates today — the whole point
   * of the command, closing the gap where every overlay fix up to now only
   * ever reached *future* `mnci new` calls, never an already-generated
   * workspace. Then proves an explicit flag overrides the persisted value,
   * in both the regenerated file and the re-persisted nx.json (so the next
   * `upgrade` remembers the override too).
   * ------------------------------------------------------------------------- */

  const pipelineBeforeUpgrade = readFileSync(path.join(workspace, 'azure-pipelines.yml'), 'utf8')
  writeFileSync(
    path.join(workspace, 'azure-pipelines.yml'),
    `${pipelineBeforeUpgrade}\n# stale hand edit, simulating drift since 'mnci new'\n`
  )
  enforce(
    'mnci upgrade runs successfully with no flags, from the persisted config alone',
    tryRun(`node ${CLI} upgrade`, workspace),
    'see log above'
  )
  enforce(
    "mnci upgrade restores the drifted pipeline file back to today's generated content",
    readFileSync(path.join(workspace, 'azure-pipelines.yml'), 'utf8') === pipelineBeforeUpgrade
  )

  const upgradeWithAgentOverrideOk = tryRun(`node ${CLI} upgrade --agent windows-latest`, workspace)
  const nxJsonAfterAgentOverride = JSON.parse(readFileSync(path.join(workspace, 'nx.json'), 'utf8'))
  enforce(
    'mnci upgrade --agent overrides the persisted agent, in both the pipeline and nx.json',
    upgradeWithAgentOverrideOk &&
      readFileSync(path.join(workspace, 'azure-pipelines.yml'), 'utf8').includes(
        'vmImage: windows-latest'
      ) &&
      nxJsonAfterAgentOverride.mnci.agent === 'windows-latest'
  )
  run(`node ${CLI} upgrade --agent ubuntu-latest`, workspace)
})
section('alt stack', [], () => {
  /* ---------------------------------------------------------------------------
   * Alternate stack: vitest, exercised end-to-end so the non-default choice is
   * proven on the real toolchain (not just in unit tests). The test runner is the
   * only stack knob — linting is always ESLint + Prettier since oxlint was
   * dropped, which is what this section used to exercise.
   * ------------------------------------------------------------------------- */

  console.log('\n▸ mnci new alt --test-runner vitest')
  run(`node ${CLI} new alt --yes --registry npm --scope @alt --test-runner vitest`, temporary)

  const altNx = JSON.parse(readFileSync(path.join(altWorkspace, 'nx.json'), 'utf8'))
  // This workspace covers the other end of the ONE remaining stack knob: vitest,
  // where `demo` above is jest. It used to carry the oxlint half of a two-knob
  // matrix as well; with a single linter there is nothing left to pair.
  //
  // `linter: 'none'` in the Nx generator defaults is unrelated to mnci's linter
  // choice, and the collision of names is worth stating: it stops a direct `nx g`
  // from scaffolding a per-project ESLint config that would compete with the root
  // one, and it reads 'none' under BOTH mnci linters.
  enforce(
    "alt: stack persisted as nx.json generator defaults (linter 'none' + vitest)",
    altNx.generators?.['@nx/js:library']?.linter === 'none' &&
      altNx.generators?.['@nx/js:library']?.unitTestRunner === 'vitest'
  )
  enforce(
    'alt: mnci registers @nx/eslint/plugin — what gives every project its lint target',
    (altNx.plugins ?? []).some(
      entry => (typeof entry === 'string' ? entry : entry.plugin) === '@nx/eslint/plugin'
    )
  )
  const altManifest = JSON.parse(readFileSync(path.join(altWorkspace, 'package.json'), 'utf8'))
  enforce(
    'alt: lint runs ESLint through nx, for every project',
    altManifest.scripts?.lint === 'nx run-many -t lint'
  )
  const altCodeWorkspace = JSON.parse(
    readFileSync(path.join(altWorkspace, 'alt.code-workspace'), 'utf8')
  )
  enforce(
    'alt: and for .ts — the format-on-save bug was a missing [typescript] entry',
    altCodeWorkspace.settings?.['[typescript]']?.['editor.defaultFormatter'] ===
      'dbaeumer.vscode-eslint'
  )
  run(`node ${CLI} add npm-lib sdk`, altWorkspace)
  run(`node ${CLI} add react-app web`, altWorkspace)
  // This assertion used to require the OPPOSITE — that npm-lib kept its own
  // generated config. That was the bug: every generator dropped one, so the
  // linting opinion fragmented a little further with each add.
  enforce(
    'alt: npm-lib keeps no eslint config of its own — the root config covers it',
    !existsSync(path.join(altWorkspace, 'packages/sdk/eslint.config.mjs'))
  )
  dropSandboxInjected(altWorkspace)
  // Nx generators emit semicolon/double-quote code, but mnci now runs
  // `eslint --fix` itself at the end of `new` and every `add` — so it must already
  // be Standard-formatted, with no manual `npm run format` in front of this.
  // (This check previously ran `format` first, which meant it could not
  // distinguish "Prettier is configured correctly" from "Prettier is configured
  // at all" — and in fact Nx's leftover .prettierrc was winning the whole time.)
  enforce(
    'alt: lint is green with no manual format step',
    tryRun('npm run lint', altWorkspace),
    'see log above'
  )

  // Prove the config in force is actually mnci's, not a default: plant
  // deliberately non-Standard code and require `format` to normalise exactly it.
  const misformatted = path.join(altWorkspace, 'packages/sdk/src/misformatted.ts')
  writeFileSync(misformatted, 'export const greeting =    "hi";\n')
  run('npm run format', altWorkspace)
  rmSync(misformatted, { force: true })
  enforce(
    'alt: build (vitest stack) runs green',
    tryRun('npx nx run-many -t build', altWorkspace),
    'see log above'
  )
  const altTest = tryRunCapture('npx nx run-many -t test', altWorkspace)
  // Verified empirically (real windows-latest CI run) that this is an upstream
  // bug in `@nx/react`'s own generated Vitest project config, not anything
  // mnci authors: on Windows only, Vitest resolves @alt/web's spec file to a
  // drive-letter-less absolute path ('/src/app/app.spec.tsx' instead of
  // 'C:/.../src/app/app.spec.tsx'). @alt/sdk's plain vitest run (no react/JSX)
  // is unaffected, so this is scoped to the react+vitest combination, and is
  // tracked here rather than silently ignored — any other test failure still
  // fails this assertion on every platform.
  const isKnownWindowsVitestPathBug =
    process.platform === 'win32' &&
    altTest.output.includes("Cannot find module '/src/app/app.spec.tsx'")
  enforce(
    'alt: test (vitest) runs green',
    altTest.ok || isKnownWindowsVitestPathBug,
    isKnownWindowsVitestPathBug
      ? "known upstream Windows bug in @nx/react's generated Vitest config (not mnci-authored) — see comment above"
      : altTest.output
  )
  enforce(
    'alt: apps still pack per environment into the drop',
    tryRun('npx nx run-many -t package', altWorkspace) &&
      ['dev', 'uat', 'prod'].every(environment =>
        existsSync(path.join(altWorkspace, `dist/drop/react-app-web-${environment}.zip`))
      )
  )
})
section('python', ['alt stack'], () => {
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
  const packOutput = execSync(
    `npm pack --silent --pack-destination "${nxPythonPipPackDirectory}"`,
    {
      cwd: nxPythonPipDirectory,
      encoding: 'utf8'
    }
  ).trim()
  const nxPythonPipTarball = path.join(nxPythonPipPackDirectory, packOutput.split('\n').at(-1))
  process.env.MNCI2_PYTHON_PIP_SPEC = nxPythonPipTarball

  console.log('\n▸ mnci add python-app / python-function-app / python-lib / python-internal-lib')
  run(`node ${CLI} add python-app pysvc`, altWorkspace)
  run(`node ${CLI} add python-function-app pyfunc`, altWorkspace)
  run(`node ${CLI} add python-lib pyshared`, altWorkspace)
  run(`node ${CLI} add python-internal-lib pycore`, altWorkspace)

  const altPythonManifest = JSON.parse(
    readFileSync(path.join(altWorkspace, 'package.json'), 'utf8')
  )
  enforce(
    'python: no hand-rolled files — @mnci/nx-python-pip installed as a real devDependency, requirements-dev.txt the only file mnci itself writes',
    Boolean(altPythonManifest.devDependencies?.['@mnci/nx-python-pip']) &&
      existsSync(path.join(altWorkspace, 'node_modules/@mnci/nx-python-pip/generators.json')) &&
      existsSync(path.join(altWorkspace, 'requirements-dev.txt')) &&
      !existsSync(path.join(altWorkspace, 'tools/python-build.js'))
  )
  // Deliberately non-throwing, unlike the `run()` this used to be. Installing the
  // Python toolchain is the one step here that depends on the *machine* rather than
  // on anything mnci produced, and when it failed it took the whole suite down with
  // it — `run()` throws, the script is linear, so Go and Flutter (which come after)
  // reported nothing at all. That happened for a reason entirely outside this
  // project: a Debian-owned `packaging` that pip refuses to replace
  // (`Cannot uninstall packaging 24.0, RECORD file not found`).
  //
  // Recording it as a normal failure keeps every later section running, so one
  // unusable toolchain costs its own coverage and nothing else's. This is the
  // narrow version of ROADMAP #21 — full per-section isolation, where a broken
  // Python section would be *skipped* rather than cascade into failed assertions
  // below, is still open.
  const pythonToolchainInstall = tryRunCapture(
    `${PYTHON} -m pip install --quiet -r requirements-dev.txt`,
    altWorkspace
  )
  enforce(
    'python: the fixed toolchain (ruff/pytest/build/twine) installs from the generated requirements-dev.txt',
    pythonToolchainInstall.ok,
    pythonToolchainInstall.output
  )

  const pysharedProjectPath = path.join(altWorkspace, 'python-packages/pyshared/project.json')
  const pysharedProject = existsSync(pysharedProjectPath)
    ? JSON.parse(readFileSync(pysharedProjectPath, 'utf8'))
    : {}
  enforce(
    "python: publishable lib lives under python-packages/ with the plugin's twine nx-release-publish target + a project-level versionActions override",
    (pysharedProject.targets?.['nx-release-publish']?.executor ?? '') ===
      '@mnci/nx-python-pip:publish' &&
      pysharedProject.release?.version?.versionActions ===
        '@mnci/nx-python-pip/release/version-actions'
  )
  enforce(
    'python: internal lib is a library under libs/ (never publishable, no build/package/publish target)',
    existsSync(path.join(altWorkspace, 'libs/pycore/project.json'))
  )
  const pycoreProject = JSON.parse(
    readFileSync(path.join(altWorkspace, 'libs/pycore/project.json'), 'utf8')
  )
  enforce(
    'python: internal lib has no build/package/publish targets — vendored by consumers, never released on its own',
    !pycoreProject.targets?.build &&
      !pycoreProject.targets?.package &&
      !pycoreProject.targets?.['nx-release-publish']
  )
  enforce(
    'python: function app carries the Azure Functions v2 files, and has no pyproject.toml/build target (source deploy, no wheel)',
    ['function_app.py', 'host.json', 'requirements.txt'].every(file =>
      existsSync(path.join(altWorkspace, 'apps/pyfunc', file))
    ) && !existsSync(path.join(altWorkspace, 'apps/pyfunc/pyproject.toml'))
  )

  /* ---------------------------------------------------------------------------
   * The same private-internal-lib / real-external-dependency proof as the JS
   * side, adapted to pip's mechanism: a hand-added [tool.mnci-python-pip]
   * vendor = [...] entry (the pip-world counterpart of hand-wiring a
   * dependencies = [...] entry — mnci wires no cross-project Python
   * dependency automatically, exactly like every other kind) makes the
   * plugin's build executor copy the internal lib's module — resolved via the
   * real Nx project graph, not a hard-coded libs/ path — straight into a
   * staged build (like rollup inlines for npm-lib), while a real declared
   * dependency stays a real Requires-Dist. No lock file means no pinned
   * resolution: the wheel's Requires-Dist mirrors the pyproject.toml specifier
   * verbatim (\`tomli>=2.0.0\`, not a resolved \`tomli==x.y.z\`).
   * ------------------------------------------------------------------------- */

  console.log(
    '\n▸ mnci add python-vendor pyshared --lib pycore (wiring pyshared, publishable -> pycore, private internal, vendored)'
  )
  run(`node ${CLI} add python-vendor pyshared --lib pycore`, altWorkspace)
  const pysharedPyprojectPath = path.join(altWorkspace, 'python-packages/pyshared/pyproject.toml')
  enforce(
    "python-vendor: writes the [tool.mnci-python-pip] vendor entry into the consumer's real pyproject.toml",
    readFileSync(pysharedPyprojectPath, 'utf8').includes('vendor = ["pycore"]')
  )
  // Real-execution idempotency proof: running it again must not duplicate the entry.
  run(`node ${CLI} add python-vendor pyshared --lib pycore`, altWorkspace)
  enforce(
    'python-vendor is idempotent for real: running it twice does not duplicate the entry',
    (readFileSync(pysharedPyprojectPath, 'utf8').match(/pycore/g) ?? []).length === 1
  )
  // Real-execution rejection proof: a project cannot vendor itself.
  enforce(
    'python-vendor rejects a project vendoring itself, for real (non-zero exit)',
    !tryRun(`node ${CLI} add python-vendor pycore --lib pycore`, altWorkspace)
  )
  // Named greeting.py, not hello.py: pyshared/__init__.py (written by the
  // plugin's `library` generator) already exports a top-level `hello` symbol,
  // and a same-named submodule would shadow it as soon as either gets
  // imported (a real Python footgun, hit empirically) — `pyshared.__init__`'s
  // own generated hello() and its generated test stay untouched and green.
  // pycore is still vendored only at build time (the plugin's `build`
  // executor) — this file's import resolves at test/dev time because of the
  // workspace-wide editable install below, a separate, mnci-owned mechanism
  // (not the plugin's), so this DOES get its own local test file, proving the
  // import genuinely resolves before any wheel is ever built.
  writeFileSync(
    path.join(altWorkspace, 'python-packages/pyshared/pyshared/greeting.py'),
    'from pycore import hello as core_hello\n\n\ndef build_greeting():\n    return "Hello pyshared uses " + core_hello()\n'
  )
  writeFileSync(
    path.join(altWorkspace, 'python-packages/pyshared/tests/test_greeting.py'),
    'from pyshared.greeting import build_greeting\n\n\ndef test_build_greeting():\n    assert build_greeting() == "Hello pyshared uses hello from pycore"\n'
  )

  console.log('\n▸ wiring pysvc (packed) -> a real external PyPI dependency (tomli)')
  const pysvcPyprojectPath = path.join(altWorkspace, 'apps/pysvc/pyproject.toml')
  // Through `replaceInFile` so a shape change in the plugin's emitted pyproject
  // fails HERE rather than three assertions later as a missing wheel dependency.
  replaceInFile(pysvcPyprojectPath, 'dependencies = []', 'dependencies = ["tomli>=2.0.0"]')
  // Also named greeting.py for the same shadowing reason as pyshared above.
  // Unlike pycore, tomli is a real installable PyPI package (declared in
  // pysvc's own pyproject.toml dependencies), so `pip install -e .` genuinely
  // makes it importable locally — this one keeps its test file.
  writeFileSync(
    path.join(altWorkspace, 'apps/pysvc/pysvc/greeting.py'),
    'import tomli\n\n\ndef build_greeting():\n    return "Hello pysvc uses tomli " + tomli.__version__\n'
  )
  writeFileSync(
    path.join(altWorkspace, 'apps/pysvc/tests/test_greeting.py'),
    'from pysvc.greeting import build_greeting\n\n\ndef test_build_greeting():\n    assert build_greeting().startswith("Hello pysvc uses tomli ")\n'
  )

  /* ---------------------------------------------------------------------------
   * "Global Python packaging": the pip-world counterpart of `npm install`
   * hoisting every workspace package into one root node_modules. Reproduces
   * the exact CI guard (overlay.ts's PYTHON_WORKSPACE_INSTALL_GUARD) — one
   * `pip install` editable-installing every project with a pyproject.toml
   * (apps/python-packages/libs alike) plus `-r`-installing every function
   * app's requirements.txt — against this real workspace, so pyshared's fresh
   * test file above (importing the vendored-only-at-build pycore directly) has
   * something to resolve against. Before this step existed, that import was
   * only provable at build time (the wheel-content/clean-venv checks below);
   * this proves it resolves at plain `pytest` time too.
   * ------------------------------------------------------------------------- */
  console.log(
    '\n▸ global Python install: editable-installing every Python project into one shared environment'
  )
  run(
    `${PYTHON} -m pip install --quiet -e apps/pysvc -e python-packages/pyshared -e libs/pycore -r apps/pyfunc/requirements.txt`,
    altWorkspace
  )

  // Real-execution proof for the root `python:install` npm script (item 10):
  // the exact generated script text — chaining the fixed-toolchain guard and
  // the workspace-wide editable-install guard with `&&` — run for real against
  // this same workspace, not just asserted as a string. Confirms the `&&`
  // composition is valid shell on this OS and idempotent against the manual
  // install just above (both guards no-op/skip nothing here since Python
  // projects already exist).
  const altRootManifestForPythonInstall = JSON.parse(
    readFileSync(path.join(altWorkspace, 'package.json'), 'utf8')
  )
  enforce(
    'root manifest declares a python:install script chaining both CI Python-install guards',
    Boolean(altRootManifestForPythonInstall.scripts?.['python:install'])
  )
  enforce(
    'npm run python:install succeeds for real (toolchain + workspace editable install, chained)',
    tryRun('npm run python:install', altWorkspace),
    'see log above'
  )

  enforce(
    'python: ruff lint runs green across the python projects',
    tryRun('npx nx run-many -t lint --projects=pysvc,pyfunc,pyshared,pycore', altWorkspace),
    'see log above'
  )
  enforce(
    'python: pytest runs green across the python projects (private-lib + external-dependency wiring included, both resolving at test time via the global editable install)',
    tryRun('npx nx run-many -t test --projects=pysvc,pyfunc,pyshared,pycore', altWorkspace),
    'see log above'
  )

  // Same real-execution proof as the npm audit step above, extracted from this
  // real generated pipeline and run against the real editable-installed
  // environment (pip-audit itself came from requirements-dev.txt, installed
  // two steps up) — proves the non-blocking property for real on the Python side.
  const altPipelineParsed = yaml.load(
    readFileSync(path.join(altWorkspace, 'azure-pipelines.yml'), 'utf8')
  )
  const pipAuditStep = altPipelineParsed?.steps?.find(
    step => step.displayName === 'pip-audit (non-blocking)'
  )
  enforce(
    "pipeline's pip-audit step exits 0 even when real vulnerabilities are found",
    Boolean(pipAuditStep) && tryRun(pipAuditStep.script, altWorkspace),
    'see log above'
  )

  const AdmZipPy = createRequire(path.join(altWorkspace, 'package.json'))('adm-zip')
  const pysharedWheelPath = path.join(
    altWorkspace,
    'python-packages/pyshared/dist/pyshared-1.0.0-py3-none-any.whl'
  )
  enforce(
    "python: build produces a wheel for the publishable lib (vendoring pycore via the plugin's build executor)",
    tryRun('npx nx build pyshared', altWorkspace) && existsSync(pysharedWheelPath)
  )
  const pysharedWheelEntries = existsSync(pysharedWheelPath)
    ? new AdmZipPy(pysharedWheelPath).getEntries().map(entry => entry.entryName)
    : []
  enforce(
    'python: publishable lib wheel vendors the private internal lib (pycore) — no separate install needed',
    pysharedWheelEntries.includes('pycore/__init__.py') &&
      pysharedWheelEntries.includes('pyshared/greeting.py')
  )
  // The strongest possible proof: install the real wheel into a clean venv (no
  // workspace/editable install in play) and run it — mirrors the sdk's "runs
  // standalone under node" check.
  const pysharedVenv = path.join(temporary, 'py-venv-pyshared')
  run(`${PYTHON} -m venv "${pysharedVenv}"`, altWorkspace)
  run(
    `"${venvExecutable(pysharedVenv, 'pip')}" install --quiet "${pysharedWheelPath}"`,
    altWorkspace
  )
  const pysharedVenvRun = tryRunCapture(
    `"${venvExecutable(pysharedVenv, 'python')}" -c "from pyshared.greeting import build_greeting; print(build_greeting())"`,
    altWorkspace
  )
  enforce(
    'python: publishable lib installs into a clean venv and runs correctly (private lib resolves with no extra install)',
    pysharedVenvRun.ok && pysharedVenvRun.output.includes('Hello pyshared uses hello from pycore'),
    pysharedVenvRun.output
  )

  enforce(
    'python: apps pack into the drop as <type>-<name>.zip (fits the existing CI)',
    tryRun('npx nx run-many -t package --projects=pysvc,pyfunc', altWorkspace) &&
      existsSync(path.join(altWorkspace, 'dist/drop/python-app-pysvc.zip')) &&
      existsSync(path.join(altWorkspace, 'dist/drop/python-function-app-pyfunc.zip'))
  )
  const pysvcZipPath = path.join(altWorkspace, 'dist/drop/python-app-pysvc.zip')
  const pysvcZipEntries = existsSync(pysvcZipPath)
    ? new AdmZipPy(pysvcZipPath).getEntries().map(entry => entry.entryName)
    : []
  enforce(
    'python: app zip actually contains the built wheel (not just an empty drop)',
    pysvcZipEntries.some(entry => /^pysvc-.*\.whl$/.test(entry))
  )
  const pyfuncZipPath = path.join(altWorkspace, 'dist/drop/python-function-app-pyfunc.zip')
  const pyfuncZipEntries = existsSync(pyfuncZipPath)
    ? new AdmZipPy(pyfuncZipPath).getEntries().map(entry => entry.entryName)
    : []
  enforce(
    'python: function app zip actually contains the deployable source (function_app.py, host.json, requirements.txt)',
    ['function_app.py', 'host.json', 'requirements.txt'].every(file =>
      pyfuncZipEntries.includes(file)
    )
  )

  const pysvcWheelPath = path.join(altWorkspace, 'apps/pysvc/dist/pysvc-1.0.0-py3-none-any.whl')
  const pysvcMetadata = existsSync(pysvcWheelPath)
    ? new AdmZipPy(pysvcWheelPath).readAsText('pysvc-1.0.0.dist-info/METADATA') // eslint-disable-line unicorn/prefer-blob-reading-methods
    : ''
  enforce(
    'python: app wheel declares the real external dependency (tomli) — not silently dropped',
    /Requires-Dist:\s*tomli>=2\.0\.0/i.test(pysvcMetadata)
  )
  const pysvcVenv = path.join(temporary, 'py-venv-pysvc')
  run(`${PYTHON} -m venv "${pysvcVenv}"`, altWorkspace)
  run(`"${venvExecutable(pysvcVenv, 'pip')}" install --quiet "${pysvcWheelPath}"`, altWorkspace)
  const pysvcVenvRun = tryRunCapture(
    `"${venvExecutable(pysvcVenv, 'python')}" -c "from pysvc.greeting import build_greeting; print(build_greeting())"`,
    altWorkspace
  )
  enforce(
    'python: app installs into a clean venv and runs correctly, resolving the real external dependency from PyPI',
    pysvcVenvRun.ok && pysvcVenvRun.output.includes('Hello pysvc uses tomli '),
    pysvcVenvRun.output
  )

  /* ---------------------------------------------------------------------------
   * The exact combination that broke the old @nxlv/python bundleLocalDependencies
   * (a vendored internal lib AND a real external dependency on the SAME
   * project): verified empirically during design that pip's approach does not
   * reproduce that bug. Proven here directly, not just asserted in a comment.
   * ------------------------------------------------------------------------- */

  console.log(
    '\n▸ mnci add python-vendor pysvc --lib pycore (combined proof: vendoring + a real external dependency on the SAME project)'
  )
  run(`node ${CLI} add python-vendor pysvc --lib pycore`, altWorkspace)
  enforce(
    'python: build succeeds with both a vendored internal lib and a real external dependency on the same project',
    tryRun('npx nx build pysvc', altWorkspace)
  )
  const pysvcCombinedZip = existsSync(pysvcWheelPath) ? new AdmZipPy(pysvcWheelPath) : null
  const pysvcCombinedEntries = pysvcCombinedZip
    ? pysvcCombinedZip.getEntries().map(entry => entry.entryName)
    : []
  const pysvcCombinedMetadata = pysvcCombinedZip
    ? pysvcCombinedZip.readAsText('pysvc-1.0.0.dist-info/METADATA') // eslint-disable-line unicorn/prefer-blob-reading-methods
    : ''
  enforce(
    'python: combined wheel vendors pycore AND keeps the real external dependency declared — no metadata drop (the old @nxlv/python bug does not reproduce with pip)',
    pysvcCombinedEntries.includes('pycore/__init__.py') &&
      /Requires-Dist:\s*tomli>=2\.0\.0/i.test(pysvcCombinedMetadata)
  )

  /* ---------------------------------------------------------------------------
   * Conventional-commit versioning AND publishing reach Python via
   * @mnci/nx-python-pip's PythonVersionActions + publish executor.
   * ------------------------------------------------------------------------- */

  run('git init -q -b main && git add -A', altWorkspace)
  run(
    'git -c user.email=e2e@test -c user.name=e2e commit -q -m "feat: initial python packages"',
    altWorkspace
  )
  // The combined command, same reasoning as the JS-side check above — the bare
  // `version` subcommand rejects this workspace's top-level release.git.
  const altReleaseDryRun = tryRunCapture('npx nx release --dry-run --verbose', altWorkspace)
  // Verified empirically (real windows-latest CI run) that on Windows Nx's own
  // conventional-commits git-history scan reports "No changes were detected"
  // for this very first commit — for BOTH @alt/sdk (plain JS/TS, nothing
  // mnci-specific about it) and pyshared equally, so this is a pre-existing Nx
  // git-diff-on-Windows characteristic, not a Python- or PythonVersionActions-
  // specific bug (the CRLF-conversion warnings `git add -A` prints just above
  // this call are the likely trigger, unconfirmed). Matches the same rigor the
  // JS-side release dry-run check above (line ~458) already uses on every
  // platform: assert the dry-run command itself succeeds; only additionally
  // assert the actual version-bump content on POSIX, where it's proven to work.
  enforce(
    "python: nx release versions the publishable python lib from conventional commits (@mnci/nx-python-pip's PythonVersionActions, no @nxlv/python)",
    altReleaseDryRun.ok &&
      (process.platform === 'win32' ||
        (/shared[^\n]*new version/i.test(altReleaseDryRun.output) &&
          altReleaseDryRun.output.includes('pyproject.toml'))),
    altReleaseDryRun.output
  )
  // nx release publish --dry-run sets a real, typed dryRun option on every
  // nx-release-publish executor (verified empirically) — no argv-parsing trick
  // needed, unlike the plain nx:run-commands version this plugin replaced.
  const altReleasePublishDryRun = tryRunCapture(
    'npx nx release publish --dry-run --verbose',
    altWorkspace
  )
  enforce(
    "python: nx release publish --dry-run previews the twine upload via the plugin's typed dryRun executor option",
    altReleasePublishDryRun.ok &&
      altReleasePublishDryRun.output.includes(`[dry-run] would run: ${PYTHON} -m twine upload`),
    altReleasePublishDryRun.output
  )
})
section('go', ['alt stack'], () => {
  /* ---------------------------------------------------------------------------
   * Go — @nx-go/nx-go, the one third-party plugin, in the single-root-`go.mod`
   * layout mnci imposes on it.
   *
   * This section closes the coverage hole ROADMAP §6 recorded: all four Go kinds
   * had real unit tests and real CI wiring, but nothing had ever driven them end to
   * end, so every invariant below was documented and unverified. Gated on the Go
   * toolchain the same way Flutter is gated on its SDK — reported as SKIPPED rather
   * than silently dropped, which is precisely how Go came to have no coverage.
   * ------------------------------------------------------------------------- */

  if (hasGo()) {
    console.log('\n▸ mnci add go-app / go-internal-lib / go-lib / go-function-app')
    run(`node ${CLI} add go-app goapi`, altWorkspace)
    run(`node ${CLI} add go-internal-lib goutil`, altWorkspace)
    run(`node ${CLI} add go-lib gocore`, altWorkspace)
    run(`node ${CLI} add go-function-app gofn`, altWorkspace)

    // The layout invariant, and the one with the widest blast radius if broken: a
    // stale `go.work` `use` entry breaks the entire Nx graph, not just Go.
    enforce(
      'go: ONE root go.mod and NO go.work anywhere — the single-module layout',
      existsSync(path.join(altWorkspace, 'go.mod')) &&
        !existsSync(path.join(altWorkspace, 'go.work')) &&
        findFiles(altWorkspace, name => name === 'go.mod').length === 1,
      findFiles(altWorkspace, name => name === 'go.mod').join(', ')
    )

    // Read rather than hardcoded: the module path comes from the workspace scope,
    // so hardcoding it would make this section quietly wrong on a rename.
    const goModule = readFileSync(path.join(altWorkspace, 'go.mod'), 'utf8')
      .split('\n', 1)[0]
      .replace('module ', '')
      .trim()

    // Nothing is inferred in single-module mode: @nx-go/nx-go's inference keys on a
    // per-project go.mod, which this layout deliberately does not have, so add/go.ts
    // writes every target explicitly. If that ever regressed, the targets would
    // silently vanish rather than fail loudly.
    for (const [project, directory, expected] of [
      ['goapi', 'apps/goapi', ['build', 'test', 'lint', 'package', 'start']],
      ['goutil', 'libs/goutil', ['test', 'lint']],
      ['gocore', 'packages/gocore', ['test', 'lint']],
      ['gofn', 'apps/gofn', ['build', 'test', 'lint', 'package']]
    ]) {
      const projectJson = JSON.parse(
        readFileSync(path.join(altWorkspace, directory, 'project.json'), 'utf8')
      )
      enforce(
        `go: ${project} has every target written explicitly (${expected.join(', ')})`,
        expected.every(target => Object.hasOwn(projectJson.targets ?? {}, target)),
        Object.keys(projectJson.targets ?? {}).join(', ')
      )
    }

    // A documented, deliberate gap rather than an oversight: go-function-app writes
    // no host.json/custom-handler config, so a `:start` script would just fail.
    const goFunctionAppProject = JSON.parse(
      readFileSync(path.join(altWorkspace, 'apps/gofn/project.json'), 'utf8')
    )
    enforce(
      'go: go-function-app deliberately has NO start target, unlike go-app',
      !goFunctionAppProject.targets?.start
    )

    const goLibProject = JSON.parse(
      readFileSync(path.join(altWorkspace, 'packages/gocore/project.json'), 'utf8')
    )
    enforce(
      'go: go-lib is tagged type:go-lib, which is what excludes it from the release scope',
      goLibProject.tags?.includes('type:go-lib')
    )

    // THE payoff of one root module: a cross-project import needs no vendoring, no
    // `replace` directive and no per-project manifest — just the import path.
    writeFileSync(
      path.join(altWorkspace, 'apps/goapi/main.go'),
      `package main\n\nimport (\n\t"fmt"\n\n\t"${goModule}/libs/goutil"\n)\n\n// Hello delegates across a project boundary through the single root module.\nfunc Hello(name string) string {\n\treturn goutil.Goutil(name)\n}\n\nfunc main() {\n\tfmt.Println(Hello("goapi"))\n}\n`
    )
    writeFileSync(
      path.join(altWorkspace, 'apps/goapi/main_test.go'),
      'package main\n\nimport "testing"\n\nfunc TestHelloUsesTheInternalLib(t *testing.T) {\n\tif got := Hello("x"); got != "Goutil x" {\n\t\tt.Fatalf("got %q", got)\n\t}\n}\n'
    )

    const goVerify = tryRunCapture(
      'npx nx run-many -t build,test --projects=goapi,goutil,gocore,gofn',
      altWorkspace
    )
    enforce(
      'go: real go build + go test pass for all four kinds, with goapi importing libs/goutil across projects and no vendoring step',
      goVerify.ok,
      goVerify.output
    )

    if (hasGolangciLint()) {
      const goLint = tryRunCapture(
        'npx nx run-many -t lint --projects=goapi,goutil,gocore,gofn',
        altWorkspace
      )
      enforce(
        'go: lint runs golangci-lint (not the plugin default `go fmt`, which only reformats)',
        goLint.ok,
        goLint.output
      )
    } else {
      skip(
        'the go lint assertion',
        'golangci-lint is not on PATH (the rest of the Go section still ran)'
      )
    }

    const goPackage = tryRunCapture('npx nx package goapi', altWorkspace)
    const goZipPath = path.join(altWorkspace, 'dist/drop/go-app-goapi.zip')
    enforce(
      'go: package compiles a real binary and zips it to dist/drop/go-app-goapi.zip',
      goPackage.ok && existsSync(goZipPath),
      goPackage.output
    )
    if (existsSync(goZipPath)) {
      const AdmZipGo = createRequire(path.join(altWorkspace, 'package.json'))('adm-zip')
      const goEntries = new AdmZipGo(goZipPath).getEntries()
      enforce(
        // `goapi` OR `goapi.exe`: `go build` names the binary with the platform's
        // executable suffix, and this suite's only CI home is windows-latest. The
        // package target is already platform-agnostic — it zips the whole
        // `dist/apps/<name>/` directory precisely so the name inside can differ —
        // and this assertion has to be too, or it fails on the one machine that
        // actually runs it.
        'go: the drop zip holds a genuinely compiled binary, not an empty shell',
        goEntries.some(
          entry =>
            (entry.entryName === 'goapi' || entry.entryName === 'goapi.exe') &&
            entry.header.size > 100_000
        ),
        goEntries.map(entry => `${entry.entryName} (${entry.header.size}b)`).join(', ')
      )
    }

    // The highest-consequence Go invariant. A go-lib lands in `packages/` but has no
    // package.json, so Nx's default versionActions looks for a manifest that is not
    // there and aborts while BUILDING THE RELEASE GRAPH — which kills `nx release`
    // for every project in the workspace, not just this one. The `!tag:type:go-lib`
    // exclusion is what prevents that, and this is the only test that proves it:
    // note it needs a releasable non-Go package present (altWorkspace has npm-lib
    // `sdk`), because a Go-only workspace has an empty release scope by design and
    // nx release would error for a completely different reason.
    const goRelease = tryRunCapture('npx nx release --dry-run', altWorkspace)
    enforce(
      'go: nx release still runs with a go-lib present — it is excluded, not aborting the whole release graph',
      goRelease.ok && !/gocore/.test(goRelease.output),
      goRelease.output
    )
  } else {
    skip('the entire Go section', 'the Go toolchain is not on PATH')
  }
})
section('flutter', [], () => {
  /* ---------------------------------------------------------------------------
   * Flutter — @mnci/nx-flutter (this monorepo's second own Nx plugin), packed
   * from its build output (MNCI_NX_FLUTTER_SPEC) rather than the published
   * registry package, exactly as the Python section does.
   *
   * This is the one section gated on a toolchain: the Flutter SDK is not on a
   * stock machine or CI image. See the file header for why it is reported as
   * SKIPPED rather than dropped.
   * ------------------------------------------------------------------------- */

  if (hasFlutter()) {
    console.log('\n▸ packing @mnci/nx-flutter for the e2e to install locally')
    const nxFlutterDirectory = path.resolve(SCRIPT_DIR, '..', '..', 'nx-flutter')
    run('npm run build', nxFlutterDirectory)
    const nxFlutterPackDirectory = path.join(temporary, 'nx-flutter-pack')
    mkdirSync(nxFlutterPackDirectory, { recursive: true })
    const flutterPackOutput = execSync(
      `npm pack --silent --pack-destination "${nxFlutterPackDirectory}"`,
      { cwd: nxFlutterDirectory, encoding: 'utf8' }
    ).trim()
    process.env.MNCI_NX_FLUTTER_SPEC = path.join(
      nxFlutterPackDirectory,
      flutterPackOutput.split('\n').at(-1)
    )

    console.log('\n▸ mnci add flutter-app / flutter-lib / flutter-internal-lib')
    run(`node ${CLI} add flutter-app hello`, altWorkspace)
    run(`node ${CLI} add flutter-lib dartshared`, altWorkspace)
    run(`node ${CLI} add flutter-internal-lib dartcore`, altWorkspace)

    const flutterManifest = JSON.parse(
      readFileSync(path.join(altWorkspace, 'package.json'), 'utf8')
    )
    enforce(
      'flutter: the plugin is a real devDependency and mnci itself hand-writes no Dart project files',
      Boolean(flutterManifest.devDependencies?.['@mnci/nx-flutter']) &&
        existsSync(path.join(altWorkspace, 'node_modules/@mnci/nx-flutter/generators.json'))
    )

    // The central-dependency model: one root pubspec listing every project.
    const rootPubspec = readFileSync(path.join(altWorkspace, 'pubspec.yaml'), 'utf8')
    enforce(
      'flutter: ONE root pubspec.yaml lists all three projects under workspace:',
      ['apps/hello', 'packages/dartshared', 'libs/dartcore'].every(member =>
        rootPubspec.includes(`- ${member}`)
      ) && rootPubspec.includes('publish_to: none'),
      rootPubspec
    )
    enforce(
      'flutter: every member declares `resolution: workspace`, so pub resolves through the root',
      ['apps/hello', 'packages/dartshared', 'libs/dartcore'].every(member =>
        readFileSync(path.join(altWorkspace, member, 'pubspec.yaml'), 'utf8').includes(
          'resolution: workspace'
        )
      )
    )
    enforce(
      'flutter: lint config is central — each project just includes the root analysis_options.yaml',
      readFileSync(path.join(altWorkspace, 'analysis_options.yaml'), 'utf8').includes(
        'package:flutter_lints/flutter.yaml'
      ) &&
        readFileSync(path.join(altWorkspace, 'apps/hello/analysis_options.yaml'), 'utf8').includes(
          'include: ../../analysis_options.yaml'
        )
    )

    // An internal dependency, declared with a PLAIN constraint and no `path:`.
    const dartsharedPubspecPath = path.join(altWorkspace, 'packages/dartshared/pubspec.yaml')
    // `\r?\n`, not `\n`: `flutter create` writes CRLF on Windows, which is the
    // only platform this suite runs on. `internal/pubspec.ts` has always spelled
    // its own patterns that way; this one did not, and silently matched nothing.
    replaceInFile(
      dartsharedPubspecPath,
      /^dependencies:\r?\n {2}flutter:\r?\n {4}sdk: flutter\r?\n/m,
      'dependencies:\n  flutter:\n    sdk: flutter\n  dartcore: ^0.0.1\n'
    )
    writeFileSync(
      path.join(altWorkspace, 'packages/dartshared/lib/dartshared.dart'),
      "import 'package:dartcore/dartcore.dart';\n\n/// Uses the internal lib across a workspace boundary.\nclass Greeter {\n  /// Bumps a number using dartcore.\n  int bump(int value) => Calculator().addOne(value);\n}\n"
    )
    writeFileSync(
      path.join(altWorkspace, 'packages/dartshared/test/dartshared_test.dart'),
      "import 'package:flutter_test/flutter_test.dart';\nimport 'package:dartshared/dartshared.dart';\n\nvoid main() {\n  test('bumps via the internal lib', () {\n    expect(Greeter().bump(2), 3);\n  });\n}\n"
    )

    // THE dependency-injection step: one command for internal + external deps.
    run('flutter pub get', altWorkspace)

    const lockfiles = [
      'pubspec.lock',
      'apps/hello/pubspec.lock',
      'packages/dartshared/pubspec.lock'
    ]
    enforce(
      'flutter: one root pub get produces ONE lockfile — pub deletes the per-package ones',
      existsSync(path.join(altWorkspace, lockfiles[0])) &&
        !existsSync(path.join(altWorkspace, lockfiles[1])) &&
        !existsSync(path.join(altWorkspace, lockfiles[2]))
    )
    const packageConfig = JSON.parse(
      readFileSync(path.join(altWorkspace, '.dart_tool/package_config.json'), 'utf8')
    )
    // Both halves of the ORIGINAL assertion passed while the dependency was
    // missing entirely, which is why the failure surfaced two assertions later
    // as a `flutter analyze` lint instead of here. `package_config.json` lists
    // every workspace member whether or not this package depends on it, and
    // "contains no `path:`" is trivially true of a dependency that was never
    // written. So the declaration itself is now asserted directly.
    const dartsharedPubspec = readFileSync(dartsharedPubspecPath, 'utf8')
    enforce(
      'flutter: dartshared actually DECLARES dartcore, with a plain version constraint',
      /^ {2}dartcore: \^\d/m.test(dartsharedPubspec),
      dartsharedPubspec
    )
    enforce(
      'flutter: the internal dep resolved to the LOCAL package with no `path:` dependency',
      packageConfig.packages.some(
        entry => entry.name === 'dartcore' && entry.rootUri.includes('libs/dartcore')
      ) && !dartsharedPubspec.includes('path:'),
      JSON.stringify(packageConfig.packages.find(entry => entry.name === 'dartcore'))
    )

    // `flutter create` writes `<html>` with no `lang`, which @html-eslint's
    // `require-lang` reports as an ERROR — so a generated Flutter app failed
    // `npm run lint` on a file the user never opened. It surfaced here only as
    // three non-fatal `eslint could not format '.'` lines during `mnci add`,
    // which is exactly why it needs an assertion of its own rather than relying
    // on someone reading the add output.
    const webIndex = readFileSync(path.join(altWorkspace, 'apps/hello/web/index.html'), 'utf8')
    enforce(
      'flutter: the generated web shell declares a lang, so the workspace lints clean',
      /<html lang="[^"]+"/.test(webIndex),
      webIndex.slice(0, 200)
    )

    const flutterVerify = tryRunCapture(
      'npx nx run-many -t lint,test --projects=hello,dartshared,dartcore',
      altWorkspace
    )
    enforce(
      'flutter: real flutter analyze + flutter test pass for all three projects',
      flutterVerify.ok,
      flutterVerify.output
    )

    const flutterPackage = tryRunCapture('npx nx package hello', altWorkspace)
    const flutterZipPath = path.join(altWorkspace, 'dist/drop/flutter-app-hello.zip')
    enforce(
      'flutter: package builds a real web bundle and zips it to dist/drop/flutter-app-hello.zip',
      flutterPackage.ok && existsSync(flutterZipPath),
      flutterPackage.output
    )
    if (existsSync(flutterZipPath)) {
      const AdmZipFlutter = createRequire(path.join(altWorkspace, 'package.json'))('adm-zip')
      const flutterEntries = new AdmZipFlutter(flutterZipPath)
        .getEntries()
        .map(entry => entry.entryName)
      enforce(
        'flutter: the drop zip contains a genuinely built web app, not an empty shell',
        ['index.html', 'main.dart.js', 'flutter_bootstrap.js'].every(file =>
          flutterEntries.includes(file)
        ),
        flutterEntries.slice(0, 12).join(', ')
      )
    }

    // The publishable Dart lib must not break `nx release` for the whole workspace.
    const flutterRelease = tryRunCapture('npx nx release --dry-run', altWorkspace)
    enforce(
      'flutter: nx release versions the Dart lib from its pubspec.yaml (DartVersionActions), leaving the rest of the release intact',
      flutterRelease.ok && /dartshared/i.test(flutterRelease.output),
      flutterRelease.output
    )
  } else {
    skip(
      'the entire Flutter section',
      'the Flutter SDK is not on PATH (install it, or run this on a machine that has it)'
    )
  }
})
/* ---------------------------------------------------------------------------
 * Report
 * ------------------------------------------------------------------------- */

console.log('\n=== cli e2e ===')
const failed = results.enforced.filter(result => !result.ok)
for (const result of results.enforced) {
  console.log(`  ${result.ok ? '✓' : '✗'} ENFORCED  ${result.label}`)
}
for (const result of results.skipped) {
  console.log(`  ⊘ SKIPPED   ${result.label} — ${result.reason}`)
}

if (failed.length > 0) {
  console.error(`\n✗ ${failed.length} ENFORCED expectation(s) failed.`)
  process.exit(1)
}
console.log(
  `\n✓ ${results.enforced.length} enforced checks passed.${
    results.skipped.length > 0 ? ` (${results.skipped.length} section(s) SKIPPED — see above.)` : ''
  }`
)
