import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runNx, runShell } from '../../nx'
import { fileExists, readJson, toJson, writeFileEnsured } from '../../util/fsx'
import { logger } from '../../util/logger'
import { ensureAdmZip, hasPlugin } from './shared'

/**
 * Fails fast, with an install hint, when Go is not on the PATH.
 *
 * @remarks
 * Mirrors `ensurePython` in `add/python.ts`: probed before any install or
 * generator call so a missing toolchain surfaces as one clear sentence
 * rather than an opaque generator crash.
 *
 * @param workspaceRoot - Absolute path to the workspace (cwd for the probe).
 * @returns Nothing.
 * @throws Error when `go` cannot be run.
 * @typeParam None - this function has no generic type parameters.
 */
function ensureGo(workspaceRoot: string): void {
  if (runShell('go', ['version'], workspaceRoot) !== 0) {
    throw new Error('Go not found. Install Go 1.21+ first: https://go.dev/dl/')
  }
}

/**
 * Warns (without failing) when `golangci-lint` is not on the PATH.
 *
 * @remarks
 * Deliberately a warning, not an error: the generated `lint` target uses
 * `golangci-lint`, but a developer who only wants to build and test locally
 * should not be blocked at `add` time — CI installs it as its own step. Note
 * `@nx-go/nx-go`'s `lint` executor defaults to plain `go fmt` (formatting,
 * not linting), which is why mnci pins `golangci-lint` explicitly in the
 * target it writes.
 *
 * @param workspaceRoot - Absolute path to the workspace (cwd for the probe).
 * @returns Nothing.
 * @throws Never - a missing linter only produces a warning.
 * @typeParam None - this function has no generic type parameters.
 */
function warnIfNoGolangciLint(workspaceRoot: string): void {
  if (runShell('golangci-lint', ['--version'], workspaceRoot) !== 0) {
    logger.warn(
      'golangci-lint not found — the generated lint target needs it. Install: https://golangci-lint.run/welcome/install/'
    )
  }
}

/**
 * The `@nx-go/nx-go` package spec to install.
 *
 * @remarks
 * Reads `MNCI_NX_GO_SPEC` so the e2e suite can pin or redirect the plugin
 * (e.g. to a local tarball) without touching this code; the published
 * package is the default for every real `mnci add go-*` call.
 *
 * Pinned to no particular version on purpose: `4.1.1` declares
 * `@nx/devkit ">= 20 < 23"` while `4.1.0` declares `">= 20 < 24"`, but that
 * range is a plain dependency rather than a peer, so npm simply nests its
 * own devkit copy. Verified empirically against a real Nx 23.1.0 workspace:
 * generators, `build`, `test` and `lint` all work under 4.1.1.
 *
 * @returns The npm spec to install.
 * @throws Never - reads an environment variable.
 * @typeParam None - this function has no generic type parameters.
 */
function nxGoPluginSpec(): string {
  return process.env.MNCI_NX_GO_SPEC ?? '@nx-go/nx-go'
}

/**
 * Ensures the `@nx-go/nx-go` Nx plugin is installed.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Nothing.
 * @throws Error when the install exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
function ensureNxGoPlugin(workspaceRoot: string): void {
  if (hasPlugin(workspaceRoot, '@nx-go/nx-go')) {
    return
  }
  const spec = nxGoPluginSpec()
  logger.step(`Installing the Go toolchain plugin (${spec})`)
  if (
    runShell('npm', ['install', '--save-dev', spec, '--no-audit', '--no-fund'], workspaceRoot) !== 0
  ) {
    throw new Error('npm install of @nx-go/nx-go failed')
  }
}

/**
 * Idempotently bootstraps the workspace's single root `go.mod`.
 *
 * @remarks
 * This is the Go half of mnci's root-manifest model — the direct analogue of
 * the root `package.json` for TS and `requirements-dev.txt` for Python. Every
 * Go project in the workspace shares one module, so a library is imported as
 * `<module>/libs/<name>` with no per-project manifest and no replace
 * directives.
 *
 * The sequence is exact and order-sensitive, established empirically against
 * a real Nx 23.1.0 workspace:
 *
 * 1. `init` writes `go.work` and registers the plugin in `nx.json`.
 * 2. `convert-to-one-mod` deletes `go.work` and writes the root `go.mod`.
 *
 * Step 2 refuses to run once `go.work` contains any `use` line, so it must
 * happen before the first Go project exists — hence bootstrapping here, on
 * the first `mnci add go-*`, rather than lazily later. Skipped entirely once
 * `go.mod` exists, so repeat adds are cheap and a user's own edits (extra
 * `require` lines) survive.
 *
 * The multi-module `go.work` alternative was rejected deliberately: besides
 * splitting dependencies across per-project manifests, a single stale `use`
 * entry (a project directory removed by hand) makes `go list -m -json` fail,
 * which breaks the entire Nx project graph — not just the Go projects.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Nothing.
 * @throws Error when either generator exits non-zero.
 * @typeParam None - this function has no generic type parameters.
 */
function ensureGoModule(workspaceRoot: string): void {
  if (fileExists(join(workspaceRoot, 'go.mod'))) {
    return
  }
  logger.step('Bootstrapping the workspace Go module (single root go.mod)')
  runNx(['g', '@nx-go/nx-go:init', '--no-interactive'], workspaceRoot)
  runNx(['g', '@nx-go/nx-go:convert-to-one-mod', '--no-interactive'], workspaceRoot)
}

/**
 * The workspace's Go module path, read from the root `go.mod`.
 *
 * @remarks
 * Needed to tell a user the import path of a library that was just added.
 * `convert-to-one-mod` derives it from the root package.json name.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The module path, or `undefined` when `go.mod` is unreadable.
 * @throws Never - returns `undefined` rather than propagating a read error.
 * @typeParam None - this function has no generic type parameters.
 */
function goModulePath(workspaceRoot: string): string | undefined {
  try {
    // go.mod is not JSON, so it is read directly rather than via readJson.
    const contents = readFileSync(join(workspaceRoot, 'go.mod'), 'utf8')
    return /^module\s+(\S+)/m.exec(contents)?.[1]
  } catch {
    return undefined
  }
}

/**
 * Merges extra targets into a plugin-written `project.json`.
 *
 * @remarks
 * `@nx-go/nx-go`'s generators write a real `project.json`, but with an empty
 * `targets` map: the plugin supplies targets by inference, and inference is
 * keyed on a per-project `go.mod`. In mnci's single-root-module layout there
 * are no per-project manifests, so nothing is inferred and mnci writes the
 * targets explicitly — the same thing every other mnci kind does anyway.
 *
 * @param projectJsonPath - Absolute path to the project's `project.json`.
 * @param newTargets - The targets to merge in.
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the file.
 * @typeParam None - this function has no generic type parameters.
 */
function addProjectJsonTargets(projectJsonPath: string, newTargets: Record<string, unknown>): void {
  const project = readJson<Record<string, unknown>>(projectJsonPath)
  const targets = (project.targets as Record<string, unknown> | undefined) ?? {}
  writeFileEnsured(projectJsonPath, toJson({ ...project, targets: { ...targets, ...newTargets } }))
}

/**
 * The `test` target every Go project gets (`go test`).
 *
 * @returns The nx target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function goTestTarget(): Record<string, unknown> {
  return { executor: '@nx-go/nx-go:test' }
}

/**
 * The `lint` target every Go project gets (`golangci-lint run`).
 *
 * @remarks
 * The executor's own default is `go fmt`, which only reformats — pinning
 * `linter` to `golangci-lint` is what makes this an actual linter.
 *
 * @returns The nx target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function goLintTarget(): Record<string, unknown> {
  return { executor: '@nx-go/nx-go:lint', options: { linter: 'golangci-lint', args: ['run'] } }
}

/**
 * The `build` target for a Go executable (`go build`).
 *
 * @remarks
 * Builds to the workspace-root `dist/apps/<name>/` **directory**, with the
 * binary inside it, rather than to the executor's own default of a bare file
 * at `dist/apps/<name>`. That default cannot be declared as an Nx `outputs`
 * entry: Nx scans each declared output to cache it, and scanning a file
 * raises `ENOTDIR`. Building into a directory keeps the root-`dist`
 * convention, makes the output cacheable, and gives `package` a folder to
 * zip — verified end-to-end against a real workspace.
 *
 * `outputPath` is resolved relative to the executor's cwd (the project root),
 * hence the `../../` offset back to the workspace root.
 *
 * @param name - The project name, used for the project root in `outputs`.
 * @returns The nx target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function goBuildTarget(name: string): Record<string, unknown> {
  return {
    executor: '@nx-go/nx-go:build',
    // eslint-disable-next-line unicorn/no-incorrect-template-string-interpolation -- {workspaceRoot} is an Nx output token
    outputs: [`{workspaceRoot}/dist/apps/${name}`],
    options: { outputPath: `../../dist/apps/${name}/${name}` },
  }
}

/**
 * The `package` target for a Go app: zip its built binary into the drop.
 *
 * @remarks
 * Same cross-platform `adm-zip` one-liner used by every other packaged kind,
 * writing `dist/drop/<tag>-<name>.zip` — basename exactly `<tag>-<name>`,
 * the string CI turns into the per-app build tag. A Go binary is statically
 * linked, so unlike the Python kinds there is nothing else to inject.
 *
 * Zips the whole `dist/apps/<name>/` directory {@link goBuildTarget} writes,
 * so the same one-liner works whether the binary inside is `<name>` or
 * `<name>.exe` on a Windows agent.
 *
 * @param tag - The drop basename prefix (`go-app` or `go-function-app`).
 * @param name - The Go app's project name.
 * @returns The nx:run-commands target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function goPackageTarget(tag: string, name: string): Record<string, unknown> {
  const zip = `dist/drop/${tag}-${name}.zip`
  const command = `node -e "const fs=require('node:fs');fs.mkdirSync('dist/drop',{recursive:true});const A=require('adm-zip');const z=new A();z.addLocalFolder('dist/apps/${name}');z.writeZip('${zip}')"`
  return {
    executor: 'nx:run-commands',
    dependsOn: ['build'],
    // eslint-disable-next-line unicorn/no-incorrect-template-string-interpolation -- {workspaceRoot} is an Nx output token
    outputs: [`{workspaceRoot}/${zip}`],
    options: { command },
  }
}

/** Shared preflight for every Go kind: toolchain, plugin and root module. */
function prepareGo(workspaceRoot: string): void {
  ensureGo(workspaceRoot)
  warnIfNoGolangciLint(workspaceRoot)
  ensureNxGoPlugin(workspaceRoot)
  ensureGoModule(workspaceRoot)
}

/**
 * Adds a Go executable app under `apps/`.
 *
 * @remarks
 * Delegates project generation to `@nx-go/nx-go:application`, then writes the
 * build/test/lint targets (nothing is inferred in single-module mode) plus
 * mnci's own `package` zip convention.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @returns Nothing.
 * @throws Error when Go is missing, or the generator/install fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addGoApp(workspaceRoot: string, name: string): void {
  prepareGo(workspaceRoot)
  ensureAdmZip(workspaceRoot)

  runNx(
    [
      'g',
      '@nx-go/nx-go:application',
      `apps/${name}`,
      `--name=${name}`,
      '--tags=type:go-app',
      '--no-interactive',
    ],
    workspaceRoot
  )
  addProjectJsonTargets(join(workspaceRoot, 'apps', name, 'project.json'), {
    build: goBuildTarget(name),
    test: goTestTarget(),
    lint: goLintTarget(),
    package: goPackageTarget('go-app', name),
  })
}

/**
 * Adds a Go serverless function app under `apps/`.
 *
 * @remarks
 * Structurally the same as {@link addGoApp} — a Go function app is an
 * ordinary executable whose `main` is the platform's handler entry point —
 * so this shares the generator and targets, differing only in its tag and
 * its drop basename (`go-function-app-<name>`). The handler body itself is
 * left to the user: AWS Lambda, Google Cloud Functions and Azure each want a
 * different signature, and mnci does not pick one for you.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @returns Nothing.
 * @throws Error when Go is missing, or the generator/install fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addGoFunctionApp(workspaceRoot: string, name: string): void {
  prepareGo(workspaceRoot)
  ensureAdmZip(workspaceRoot)

  runNx(
    [
      'g',
      '@nx-go/nx-go:application',
      `apps/${name}`,
      `--name=${name}`,
      '--tags=type:go-function-app',
      '--no-interactive',
    ],
    workspaceRoot
  )
  addProjectJsonTargets(join(workspaceRoot, 'apps', name, 'project.json'), {
    build: goBuildTarget(name),
    test: goTestTarget(),
    lint: goLintTarget(),
    package: goPackageTarget('go-function-app', name),
  })
}

/**
 * Adds a publishable Go library under `packages/`.
 *
 * @remarks
 * "Publishable" means something different in Go than in npm or PyPI, and it
 * is worth being precise: there is no registry upload step. The whole
 * repository is one module, so consumers depend on this library by its
 * import path at a repo-level version tag —
 * `go get <module>/packages/<name>@v1.2.3`. Publishing is therefore the git
 * tag `nx release` already creates; no `nx-release-publish` target is
 * written, because there is nothing to push. The only real difference from
 * an internal library is intent, recorded in the `type:go-lib` tag and the
 * `packages/` location.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @returns Nothing.
 * @throws Error when Go is missing, or the generator/install fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addGoLib(workspaceRoot: string, name: string): void {
  prepareGo(workspaceRoot)

  runNx(
    [
      'g',
      '@nx-go/nx-go:library',
      `packages/${name}`,
      `--name=${name}`,
      '--tags=type:go-lib',
      '--no-interactive',
    ],
    workspaceRoot
  )
  addProjectJsonTargets(join(workspaceRoot, 'packages', name, 'project.json'), {
    test: goTestTarget(),
    lint: goLintTarget(),
  })

  const module = goModulePath(workspaceRoot)
  if (module) {
    logger.step(`Import it as ${module}/packages/${name}`)
  }
}

/**
 * Adds a private Go library under `libs/`.
 *
 * @remarks
 * Identical machinery to {@link addGoLib} minus the publishable intent: same
 * single root module, imported as `<module>/libs/<name>`. Test and lint
 * targets only — a Go package that is not `main` produces no binary, so
 * there is no build target to write.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @returns Nothing.
 * @throws Error when Go is missing, or the generator/install fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addGoInternalLib(workspaceRoot: string, name: string): void {
  prepareGo(workspaceRoot)

  runNx(
    [
      'g',
      '@nx-go/nx-go:library',
      `libs/${name}`,
      `--name=${name}`,
      '--tags=type:go-internal-lib',
      '--no-interactive',
    ],
    workspaceRoot
  )
  addProjectJsonTargets(join(workspaceRoot, 'libs', name, 'project.json'), {
    test: goTestTarget(),
    lint: goLintTarget(),
  })

  const module = goModulePath(workspaceRoot)
  if (module) {
    logger.step(`Import it as ${module}/libs/${name}`)
  }
}
