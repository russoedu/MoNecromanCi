import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runNx, runShell } from '../nx-workspace'
import { fileExists, writeFileEnsured } from '../file-system'
import { logger } from '../terminal'
import { GO_CGO_TAG } from '../workspace-overlay'
import { makeGoAppReleasable } from './go-release.use-case'
import { assertWebApp, wireGoAppToWeb } from './go-web.use-case'
import { addProjectJsonTargets, ensureAdmZip, hasPlugin, registerProjectCommands } from './post-generation.use-case'

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
function ensureGo (workspaceRoot: string): void {
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
function warnIfNoGolangciLint (workspaceRoot: string): void {
  if (runShell('golangci-lint', ['--version'], workspaceRoot) !== 0) {
    logger.warn(
      'golangci-lint not found — the generated lint target needs it. Install: https://golangci-lint.run/welcome/install/',
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
function nxGoPluginSpec (): string {
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
function ensureNxGoPlugin (workspaceRoot: string): void {
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
function ensureGoModule (workspaceRoot: string): void {
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
function goModulePath (workspaceRoot: string): string | undefined {
  try {
    // go.mod is not JSON, so it is read directly rather than via readJson.
    const contents = readFileSync(join(workspaceRoot, 'go.mod'), 'utf8')

    return /^module\s+(\S+)/m.exec(contents)?.[1]
  } catch {
    return undefined
  }
}

/**
 * The `test` target every Go project gets (`go test`).
 *
 * @returns The nx target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function goTestTarget (): Record<string, unknown> {
  return { executor: '@nx-go/nx-go:test' }
}

/**
 * The `lint` target every Go project gets (`golangci-lint run`).
 *
 * @remarks
 * The executor's own default is `go fmt`, which only reformats — pinning
 * `linter` to `golangci-lint` is what makes this an actual linter.
 *
 * **`parallelism: false` is not a performance knob, it is a correctness fix.**
 * `golangci-lint` takes a machine-global lock and refuses to run beside another
 * copy of itself, exiting non-zero with `parallel golangci-lint is running`. Nx
 * runs `lint` across projects concurrently by default, so a workspace with two
 * or more Go projects failed `nx run-many -t lint` at random — one project
 * reporting `0 issues` while a sibling died on the lock. Nothing to do with the
 * Go code, and the failure moves between projects from run to run, which is what
 * makes it so unpleasant to diagnose from a CI log.
 *
 * Found the first time the e2e ever ran this assertion: `golangci-lint` had
 * never been installed on the runner, so the whole check reported SKIPPED and
 * this shipped unnoticed. Go lint is now serialised across projects; the other
 * targets are untouched and still run in parallel.
 *
 * @returns The nx target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function goLintTarget (): Record<string, unknown> {
  return {
    executor:    '@nx-go/nx-go:lint',
    parallelism: false,
    options:     { linter: 'golangci-lint', args: ['run'] },
  }
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
function goBuildTarget (name: string): Record<string, unknown> {
  return {
    executor: '@nx-go/nx-go:build',
    outputs:  [`{workspaceRoot}/dist/apps/${name}`],
    options:  { outputPath: `../../dist/apps/${name}/${name}` },
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
function goPackageTarget (tag: string, name: string): Record<string, unknown> {
  const zip = `dist/drop/${tag}-${name}.zip`
  const command = `node -e "const fs=require('node:fs');fs.mkdirSync('dist/drop',{recursive:true});const A=require('adm-zip');const z=new A();z.addLocalFolder('dist/apps/${name}');z.writeZip('${zip}')"`

  return {
    executor:  'nx:run-commands',
    dependsOn: ['build'],
    outputs:   [`{workspaceRoot}/${zip}`],
    options:   { command },
  }
}

/**
 * The platforms a Go app is cross-compiled for by its `build-all` target.
 *
 * @remarks
 * Every desktop OS on both CPU families, the set an editor extension or a CLI that
 * ships its own binary has to cover. Go builds all of them from one machine without
 * cgo, which is why the targets below need no matrix of CI agents.
 */
export const GO_PLATFORMS = [
  'windows/amd64', 'windows/arm64', 'linux/amd64', 'linux/arm64', 'darwin/amd64', 'darwin/arm64',
] as const

/**
 * The `build-all` target for a Go app: one static binary per {@link GO_PLATFORMS}.
 *
 * @remarks
 * Writes `dist/platforms/<name>/<goos>-<goarch>/<name>[.exe]` with `CGO_ENABLED=0`,
 * `-trimpath` and `-ldflags "-s -w -X main.version=<VERSION>"`, `VERSION` coming from
 * the environment (`dev` when unset), so a release stamps its tag without editing
 * anything.
 *
 * Deliberately NOT under `dist/apps/<name>/`, though that is where `build` writes: Nx
 * clears a target's declared outputs before restoring them from cache, so a cached
 * `build` would delete the cross-compiled binaries nested inside its directory.
 *
 * `VERSION` is an input, so a release never reuses a binary stamped `dev`; the root
 * `go.mod`/`go.sum` are inputs because a dependency bump changes every binary.
 *
 * @param name - The Go app's project name.
 * @returns The nx:run-commands target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function goBuildAllTarget (name: string): Record<string, unknown> {
  const platforms = JSON.stringify(GO_PLATFORMS).replaceAll('"', "'")
  const command = `node -e "const{spawnSync}=require('node:child_process');const v=process.env.VERSION||'dev';for(const p of ${platforms}){const[os,arch]=p.split('/');const out='../../dist/platforms/${name}/'+os+'-'+arch+'/${name}'+(os==='windows'?'.exe':'');const r=spawnSync('go',['build','-trimpath','-ldflags','-s -w -X main.version='+v,'-o',out,'.'],{cwd:'apps/${name}',stdio:'inherit',env:{...process.env,CGO_ENABLED:'0',GOOS:os,GOARCH:arch}});if(r.status!==0)process.exit(r.status??1)}"`

  return {
    executor: 'nx:run-commands',
    inputs:   ['default', '^default', '{workspaceRoot}/go.mod', '{workspaceRoot}/go.sum', { env: 'VERSION' }],
    outputs:  [`{workspaceRoot}/dist/platforms/${name}`],
    options:  { command },
  }
}

/**
 * The `package-all` target for a Go app: one zip per platform {@link goBuildAllTarget}
 * built.
 *
 * @remarks
 * `dist/drop/<tag>-<name>-<goos>-<goarch>.zip`, each holding that platform's binary,
 * the same `adm-zip` one-liner as {@link goPackageTarget}. The single-platform
 * `package` target keeps its name, so CI's drop handling is unchanged.
 *
 * @param tag - The drop basename prefix (`go-app` or `go-function-app`).
 * @param name - The Go app's project name.
 * @returns The nx:run-commands target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function goPackageAllTarget (tag: string, name: string): Record<string, unknown> {
  const command = `node -e "const fs=require('node:fs');const A=require('adm-zip');fs.mkdirSync('dist/drop',{recursive:true});for(const d of fs.readdirSync('dist/platforms/${name}')){const z=new A();z.addLocalFolder('dist/platforms/${name}/'+d);z.writeZip('dist/drop/${tag}-${name}-'+d+'.zip')}"`

  return {
    executor:  'nx:run-commands',
    dependsOn: ['build-all'],
    outputs:   [`{workspaceRoot}/dist/drop/${tag}-${name}-*.zip`],
    options:   { command },
  }
}

/**
 * The shell fragment that asks Go for this machine's `GOOS` and `GOARCH`.
 *
 * @remarks
 * Two calls rather than one `go env GOOS GOARCH`, so there is no newline to split on:
 * these commands pass through `cmd.exe` and POSIX `sh`, and a backslash is where they
 * disagree.
 */
const GO_HOST_PLATFORM = "const host=k=>spawnSync('go',['env',k],{encoding:'utf8'}).stdout.trim();const os=host('GOOS'),arch=host('GOARCH');"

/**
 * The `build-native` target of an app that needs a C toolchain: one binary, for this machine.
 *
 * @remarks
 * What {@link goBuildAllTarget} cannot do: with `CGO_ENABLED=1` the binary can only be
 * built where the C toolchain and the target OS's libraries are, so there is no cross-
 * compile, and CI runs this on a runner of each OS. The output path, the `VERSION`
 * stamp (`dev` when unset) and `-trimpath` are the same as `build-all`'s, so a platform's
 * binary sits where `package-all` would have put it and a release stamps it the same way.
 *
 * Named `build-native`, not `build`, so the generic verify, which runs `build` on one
 * agent, never reaches it.
 *
 * @param name - The Go app's project name.
 * @returns The nx:run-commands target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function goNativeBuildTarget (name: string): Record<string, unknown> {
  const command = `node -e "const{spawnSync}=require('node:child_process');${GO_HOST_PLATFORM}const v=process.env.VERSION||'dev';const out='../../dist/platforms/${name}/'+os+'-'+arch+'/${name}'+(os==='windows'?'.exe':'');const r=spawnSync('go',['build','-trimpath','-ldflags','-s -w -X main.version='+v,'-o',out,'.'],{cwd:'apps/${name}',stdio:'inherit',env:{...process.env,CGO_ENABLED:'1'}});process.exit(r.status??1)"`

  return {
    executor: 'nx:run-commands',
    inputs:   ['default', '^default', '{workspaceRoot}/go.mod', '{workspaceRoot}/go.sum', { env: 'VERSION' }],
    outputs:  [`{workspaceRoot}/dist/platforms/${name}`],
    options:  { command },
  }
}

/**
 * The `package-native` target of an app that needs a C toolchain: this machine's zip.
 *
 * @remarks
 * `dist/drop/go-app-<name>-<goos>-<goarch>.zip`, the name `package-all` gives each
 * platform's zip, so a release attaches the legs' zips the way it attaches the six.
 *
 * @param name - The Go app's project name.
 * @returns The nx:run-commands target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function goNativePackageTarget (name: string): Record<string, unknown> {
  const command = `node -e "const fs=require('node:fs');const{spawnSync}=require('node:child_process');const A=require('adm-zip');${GO_HOST_PLATFORM}const d=os+'-'+arch;fs.mkdirSync('dist/drop',{recursive:true});const z=new A();z.addLocalFolder('dist/platforms/${name}/'+d);z.writeZip('dist/drop/go-app-${name}-'+d+'.zip')"`

  return {
    executor:  'nx:run-commands',
    dependsOn: ['build-native'],
    outputs:   [`{workspaceRoot}/dist/drop/go-app-${name}-*.zip`],
    options:   { command },
  }
}

/**
 * Gives every Go app in the workspace its `build-all` and `package-all` targets when it
 * lacks them: the `mnci upgrade` path for apps added before the targets existed.
 *
 * @remarks
 * Only adds; a target the user already has, under either name, is never touched.
 * Idempotent, so a repeat upgrade is a no-op. An app that needs a C toolchain is
 * skipped: it cannot be cross-compiled, and a `build-all` that silently built it
 * without cgo would ship a binary missing the very thing it exists for.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The `project.json` files it changed, workspace-relative.
 * @throws Error when a Go app's `project.json` is not valid JSON.
 * @typeParam None - this function has no generic type parameters.
 */
export function addGoPlatformTargets (workspaceRoot: string): string[] {
  const changed: string[] = []
  const apps = join(workspaceRoot, 'apps')
  if (!fileExists(apps)) {
    return changed
  }
  for (const name of readdirSync(apps)) {
    const projectJsonPath = join(apps, name, 'project.json')
    if (!fileExists(projectJsonPath)) {
      continue
    }
    const project = JSON.parse(readFileSync(projectJsonPath, 'utf8')) as { tags?: string[], targets?: Record<string, unknown> }
    const tag = (project.tags ?? []).find(each => each === 'type:go-app' || each === 'type:go-function-app')?.slice('type:'.length)
    if (tag === undefined || (project.tags ?? []).includes(GO_CGO_TAG)) {
      continue
    }
    const missing: Record<string, unknown> = {}
    if (project.targets?.['build-all'] === undefined) {
      missing['build-all'] = goBuildAllTarget(name)
    }
    if (project.targets?.['package-all'] === undefined) {
      missing['package-all'] = goPackageAllTarget(tag, name)
    }
    if (Object.keys(missing).length > 0) {
      addProjectJsonTargets(projectJsonPath, missing)
      changed.push(`apps/${name}/project.json`)
    }
  }

  return changed
}

/**
 * The `start` target for a Go app: `go run .`, locally.
 *
 * @remarks
 * `go run` compiles and runs from source in one step — unlike
 * {@link goBuildTarget}, no separate build/`dependsOn` is needed.
 * `continuous: true` marks it as a long-running dev task, the same shape
 * every other kind's custom `start` target uses.
 *
 * @param name - The Go app's project name.
 * @returns The nx:run-commands target object.
 * @throws Never - pure object construction.
 * @typeParam None - this function has no generic type parameters.
 */
function goStartTarget (name: string): Record<string, unknown> {
  return {
    executor:   'nx:run-commands',
    continuous: true,
    options:    { command: 'go run .', cwd: `apps/${name}` },
  }
}

/**
 * The Go identifiers `@nx-go/nx-go:library` derives from a project name.
 *
 * @remarks
 * Matches the plugin's own `normalizeOptions` for hyphenated names: the
 * package clause is `names(projectName).propertyName.toLowerCase()` and the
 * sample function is `names(projectName).className`. Re-derived here rather
 * than imported because `@nx/devkit` is not a runtime dependency of the CLI.
 * Project names are validated to lowercase letters, digits, `-` and `.`
 * (`project-name.validator.ts`), and splitting on every non-alphanumeric
 * character also covers the dotted names the plugin leaves as an invalid
 * package clause (`my.lib` → `mylib`, not `my.lib`).
 *
 * `fileStem` is the snake-case form used for the role-suffixed file names
 * (`markdown-workspace` → `markdown_workspace`), the Go spelling of the
 * `<kebab>.<role>.ts` convention.
 *
 * @param projectName - The validated project name.
 * @returns The package name, the exported function name and the file stem.
 * @throws Never - pure string computation.
 * @typeParam None - this function has no generic type parameters.
 */
export function goLibraryIdentifiers (projectName: string): {
  packageName:  string
  functionName: string
  fileStem:     string
} {
  const words = projectName.split(/[^a-z0-9]+/i).filter(word => word.length > 0)

  return {
    packageName:  words.join('').toLowerCase(),
    functionName: words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(''),
    fileStem:     words.join('_').toLowerCase(),
  }
}

/**
 * Reshapes a freshly generated Go library into a capability with one slice.
 *
 * @remarks
 * `@nx-go/nx-go:library` writes `<projectName>.go` and `<projectName>_test.go`
 * at the project root, so the root package IS the library. That contradicts
 * the vertical-slice shape mnci follows everywhere else (capability → flat
 * slice → role-suffixed files, with only an entry point at the root), and a
 * library that grows from it grows as one flat package that never splits.
 * Found while bootstrapping Lore Master, whose three Go libraries are each
 * several slice packages (russoedu/MoNecromanCi#227).
 *
 * After this runs, the root holds only `doc.go` (the capability's package
 * comment) and the generator's sample code lives in one starter slice:
 *
 * ```
 * libs/markdown-workspace/
 * ├── doc.go                                   package markdownworkspace
 * ├── project.json
 * └── markdownworkspace/
 *     ├── doc.go
 *     ├── markdown_workspace_use_case.go       func MarkdownWorkspace(name string) string
 *     └── markdown_workspace_use_case_test.go
 * ```
 *
 * `use_case` is the role for the same reason the TypeScript placeholder is
 * renamed to `.use-case.ts` (`renameScaffoldPlaceholder`): it is the generic
 * role for a library's public behaviour. Unconditional for the same reason
 * too — whether a workspace "uses" slices is not knowable from the files, and
 * the shape costs nothing when ignored.
 *
 * The project's `test` and `lint` targets need no change: the plugin's
 * executors run `go test ./...` and `<linter> run ./...` from the project
 * root, so the slice package below it is covered (russoedu/MoNecromanCi#233).
 *
 * Idempotent: the root placeholders are removed with `force`, and the slice
 * files are only written when absent, so a user's edits survive a re-run.
 *
 * @param projectRoot - Absolute path to the generated library.
 * @param projectName - The project name the generator used for its files.
 * @returns The import path suffix of the starter slice, relative to the module.
 * @throws Propagates any `fs` error writing the new files.
 * @typeParam None - this function has no generic type parameters.
 */
export function reshapeGoLibraryScaffold (projectRoot: string, projectName: string): string {
  const { packageName, functionName, fileStem } = goLibraryIdentifiers(projectName)

  rmSync(join(projectRoot, `${projectName}.go`), { force: true })
  rmSync(join(projectRoot, `${projectName}_test.go`), { force: true })

  const files: ReadonlyArray<readonly [string, string]> = [
    [
      'doc.go',
      `// Package ${packageName} is the ${projectName} capability. Its code lives in the\n` +
        '// slice packages below this directory, one package per outcome.\n' +
        `package ${packageName}\n`,
    ],
    [
      join(packageName, 'doc.go'),
      `// Package ${packageName} is the starter slice of ${projectName}: rename it after\n` +
        '// the outcome it delivers, and add one package per further outcome.\n' +
        `package ${packageName}\n`,
    ],
    [
      join(packageName, `${fileStem}_use_case.go`),
      `package ${packageName}\n\n` +
        `// ${functionName} is the generator's sample behaviour, kept so the slice builds and tests.\n` +
        `func ${functionName}(name string) string {\n` +
        `\treturn "${functionName} " + name\n` +
        '}\n',
    ],
    [
      join(packageName, `${fileStem}_use_case_test.go`),
      `package ${packageName}\n\n` +
        'import "testing"\n\n' +
        `func Test${functionName}(t *testing.T) {\n` +
        `\tif got := ${functionName}("works"); got != "${functionName} works" {\n` +
        '\t\tt.Fatalf("got %q", got)\n' +
        '\t}\n' +
        '}\n',
    ],
  ]
  for (const [relativePath, content] of files) {
    const path = join(projectRoot, relativePath)
    if (!fileExists(path)) {
      writeFileEnsured(path, content)
    }
  }

  return packageName
}

/** Shared preflight for every Go kind: toolchain, plugin and root module. */
function prepareGo (workspaceRoot: string): void {
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
 * mnci's own `package` zip convention. With `release`, the app also joins
 * `nx release` (see {@link makeGoAppReleasable}); without it, it is never released.
 *
 * With `cgo`, the app needs a C toolchain (a tray icon, a native GUI, a cgo
 * database driver), so it cannot be cross-compiled from one machine. It is tagged
 * {@link GO_CGO_TAG} and gets `build-native` and `package-native`, for the machine
 * they run on, instead of `package`, `build-all` and `package-all`: the single-agent
 * pack step would otherwise try to build it on a runner that lacks its libraries.
 * CI builds it on a runner of every OS (the pipelines gain a `native` job on the next
 * `mnci upgrade`).
 *
 * With `web`, the app embeds and serves the React app of that name (see
 * {@link wireGoAppToWeb}), which has to exist already.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @param options - `release`: release the app, versioned from its git tag. `cgo`: it needs a C toolchain. `web`: the React app it serves.
 * @returns Nothing.
 * @throws Error when Go is missing, `web` is not a React app, or the generator/install fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addGoApp (workspaceRoot: string, name: string, options: { release?: boolean, cgo?: boolean, web?: string } = {}): void {
  const cgo = options.cgo === true
  // Before anything is generated or installed, like the toolchain probe below it.
  if (options.web !== undefined) {
    assertWebApp(workspaceRoot, options.web)
  }
  prepareGo(workspaceRoot)
  ensureAdmZip(workspaceRoot)

  runNx(
    [
      'g',
      '@nx-go/nx-go:application',
      `apps/${name}`,
      `--name=${name}`,
      cgo ? `--tags=type:go-app,${GO_CGO_TAG}` : '--tags=type:go-app',
      '--no-interactive',
    ],
    workspaceRoot,
  )
  addProjectJsonTargets(join(workspaceRoot, 'apps', name, 'project.json'), {
    build: goBuildTarget(name),
    test:  goTestTarget(),
    lint:  goLintTarget(),
    ...(cgo
      ? { 'build-native': goNativeBuildTarget(name), 'package-native': goNativePackageTarget(name) }
      : {
          'package':     goPackageTarget('go-app', name),
          'build-all':   goBuildAllTarget(name),
          'package-all': goPackageAllTarget('go-app', name),
        }),
    start: goStartTarget(name),
  })
  if (options.release === true) {
    makeGoAppReleasable(workspaceRoot, name)
  }
  if (options.web !== undefined) {
    wireGoAppToWeb(workspaceRoot, name, options.web)
  }
  registerProjectCommands(workspaceRoot, name, { build: true, start: `nx run ${name}:start` })
  if (cgo) {
    logger.warn(
      `${name} needs a C toolchain, so CI builds it on a runner of each OS. Run \`mnci upgrade\` to add the native job to your pipeline, and add the -dev packages it links to the Linux prerequisites step.`,
    )
  }
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
 * No `start` target, unlike `node-function-app`/`python-function-app`:
 * `func start` needs a `host.json` (and, for the custom-handler model Go
 * would use, a matching `customHandler` config), and this kind writes
 * neither — an honest known gap, not an oversight papered over with a
 * command that would just fail. `go-app`'s `go run .` doesn't apply either,
 * since there is no Functions host to dispatch triggers to it.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @param name - The project name (already validated).
 * @returns Nothing.
 * @throws Error when Go is missing, or the generator/install fails.
 * @typeParam None - this function has no generic type parameters.
 */
export function addGoFunctionApp (workspaceRoot: string, name: string): void {
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
    workspaceRoot,
  )
  addProjectJsonTargets(join(workspaceRoot, 'apps', name, 'project.json'), {
    'build':       goBuildTarget(name),
    'test':        goTestTarget(),
    'lint':        goLintTarget(),
    'package':     goPackageTarget('go-function-app', name),
    'build-all':   goBuildAllTarget(name),
    'package-all': goPackageAllTarget('go-function-app', name),
  })
  registerProjectCommands(workspaceRoot, name, { build: true })
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
export function addGoLib (workspaceRoot: string, name: string): void {
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
    workspaceRoot,
  )
  addProjectJsonTargets(join(workspaceRoot, 'packages', name, 'project.json'), {
    test: goTestTarget(),
    lint: goLintTarget(),
  })
  const slice = reshapeGoLibraryScaffold(join(workspaceRoot, 'packages', name), name)
  registerProjectCommands(workspaceRoot, name, { build: false })

  const module = goModulePath(workspaceRoot)
  if (module) {
    logger.step(`Import its starter slice as ${module}/packages/${name}/${slice}`)
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
export function addGoInternalLib (workspaceRoot: string, name: string): void {
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
    workspaceRoot,
  )
  addProjectJsonTargets(join(workspaceRoot, 'libs', name, 'project.json'), {
    test: goTestTarget(),
    lint: goLintTarget(),
  })
  const slice = reshapeGoLibraryScaffold(join(workspaceRoot, 'libs', name), name)
  registerProjectCommands(workspaceRoot, name, { build: false })

  const module = goModulePath(workspaceRoot)
  if (module) {
    logger.step(`Import its starter slice as ${module}/libs/${name}/${slice}`)
  }
}
