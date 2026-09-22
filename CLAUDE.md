# MoNecromanCI — Claude Code Project Guide

## Overview

**MoNecromanCI** (mnci) is an opinionated Nx monorepo scaffold CLI built on two core principles:

1. **Thin layer over Nx** — delegates to official generators (`@nx/react`, `@nx/node`, etc.) rather than hand-rolling templates
2. **Conventional commits drive releases** — `nx release` tags and publishes from git history alone, no manual versioning

This monorepo is itself an Nx monorepo, built and maintained by the CLI it ships.

## Repository Structure

```
packages/
├── cli/                  # @mnci/cli — the CLI binary (mnci new/add/upgrade)
├── eslint-config/        # @mnci/eslint-config — the whole opinion: quality, types AND formatting
├── nx-python-pip/        # @mnci/nx-python-pip — Nx plugin for pip-native Python projects
├── nx-flutter/           # @mnci/nx-flutter — Nx plugin for Flutter/Dart pub workspaces
└── az-durable/           # @mnci/az-durable — typed Azure Durable Functions boundary

tsconfig.base.json        # shared TypeScript configuration

libs/                     # empty (.gitkeep only) — internal libs would live here
(apps/)                   # If this repo had apps, they'd go here; currently it doesn't

.github/
├── workflows/ci.yml      # GitHub Actions CI (if --ci=github|both during initial setup)
└── dependabot.yml        # Weekly dependency update PRs (if --ci=github|both)

azure-pipelines.yml       # Azure Pipelines CI (if --ci=azure|both during initial setup)

nx.json                   # Nx workspace config with release, sync, generators, sharedGlobals
eslint.config.mjs         # ESLint flat config — mnci-owned; one import from @mnci/eslint-config,
                          #   plus a named inventory of every block and how to override it
                          #   (there is NO formatter config: ESLint is the formatter)
commitlint.config.mjs     # Conventional commit enforcement (via husky hook)
.husky/commit-msg         # commitlint hook
.npmrc                    # publish auth (azure also routes @scope to the feed)
<workspace-name>.code-workspace  # single-file VS Code workspace (folders, extensions, settings)
.devcontainer/devcontainer.json   # Node/Python/Go/Flutter/.NET toolchain matching CI
package.json              # Root scripts (build, lint, test, format, release:preview, etc)
```

Every file above is mnci-owned — written (and, on `mnci upgrade`, rewritten) by
`applyOverlay()` in `workspace-overlay/overlay.use-case.ts`. That includes `eslint.config.mjs`, which it did **not**
until recently: it used to come from `create-nx-workspace`, which is exactly why the rich
config this repo had never reached a single generated workspace.

`applyOverlay()` also **deletes** things `create-nx-workspace` (or a past mnci version)
scaffolds: `create-nx-workspace`'s own `.prettierrc`, any retired formatter config
(`.prettierrc*`, `.oxfmtrc.json`, `oxlint.config.ts` — mnci has shipped both Prettier
and oxlint in the past, and no longer uses either), and `.vscode/` (fully covered by
the `.code-workspace` file). Deletion is newer behaviour than overwriting, and
`mnci upgrade` does it too — the docs already tell users to `git diff` before
committing an upgrade.

## Technology Stack

- **Bundler**: npm workspaces (TypeScript project references, no per-project `project.json`)
- **Language**: TypeScript (with dual compiler: TS 6 for API, TS 7 `tsc` for compile)
- **Linting AND formatting**: ESLint (flat config) — one tool. Code quality,
  type-aware rules and JavaScript Standard Style, including
  `space-before-function-paren`, which no formatter could ever satisfy. There is
  no Prettier and no oxfmt; `eslint --fix` is the formatter
- **Testing**: Jest (default) or Vitest
- **Build**: esbuild (Node apps), Rollup (npm libs), `python -m build` (Python), `go build` (Go), `flutter build web` (Flutter), `dotnet build` (C#)
- **Release**: `nx release` (versioning from conventional commits, git tag-only push)
- **CI**: Azure Pipelines and/or GitHub Actions
- **Python toolchain**: pip (not uv), Ruff, pytest, PyPA `build`/`twine`
- **Go toolchain**: one root `go.mod` (single module), golangci-lint, `go test`, via `@nx-go/nx-go`
- **Flutter toolchain**: one root `pubspec.yaml` (Dart pub workspace), `flutter analyze`/`test`, via `@mnci/nx-flutter`
- **.NET toolchain**: `dotnet` SDK, delegating to `@nx/dotnet` (inference-only — no generators, so mnci scaffolds via `dotnet new` directly), `dotnet pack`/`dotnet nuget push` for release

## Key Files & Their Purpose

### Entry Points

- **`packages/cli/src/cli.handler.ts`** — CLI argument dispatcher (`mnci new`, `mnci add`, `mnci upgrade`)
- **`packages/cli/src/workspace-creation/create-workspace.use-case.ts`** — workspace generation (calls `applyOverlay`)
- **`packages/cli/src/project-scaffolding/add-project.use-case.ts`** — per-project scaffolding (delegates to Nx generators)
- **`packages/cli/src/workspace-upgrade/upgrade-workspace.use-case.ts`** — re-apply overlay to existing workspace
- **`packages/cli/src/workspace-diagnostics/check-invariants.use-case.ts`** — read-only invariant check (`mnci doctor`); exits non-zero on any finding, and every finding names its remedy
- **`packages/cli/src/dependency-management/sync-dependencies.use-case.ts`** — `mnci sync`: converge every external dependency range declared at more than one version, then run `nx sync` for TypeScript project references. Owns the one call to `nx sync` (`mnci add` imports it from here)
- **`packages/cli/src/dependency-management/update-dependencies.use-case.ts`** — `mnci up`: `npm-check -u`'s grouped report and multiselect, plus the projects column, across npm/pip/pub/nuget/go
- **`packages/cli/src/dependency-management/`** — the cross-language machinery both commands share: `manifest.repository.ts` (read and minimally rewrite every manifest shape), `semver.algorithm.ts` (parse, compare, bucket), `registry.client.ts` (latest version per ecosystem)

### Core Implementation

- **`packages/cli/src/workspace-overlay/overlay.use-case.ts`** — the config files mnci owns (see "Files `mnci` owns" below):
  - Exports `applyOverlay()` (pure file writer, deterministic)
  - Exports config constants: `ROOT_SCRIPTS`, `RELEASE_CONFIG`, `RETIRED_FORMATTER_FILES`, etc.
  - Exports VS Code workspace file template (`vscodeWorkspace()`)
  - Exports CI YAML generators: `azurePipelinesYaml()`, `githubActionsYaml()`
  - Exports shared guard scripts (Python install, pack, release) used by both CI providers

- **`packages/cli/src/workspace-overlay/overlay.use-case.spec.ts`** — comprehensive overlay fixture tests (330+ assertions), including six that execute the CI verify guard against a real git repo

### CLI Plumbing

- **`packages/cli/src/terminal/prompts.client.ts`** — interactive prompts for workspace/app names, stack choices, CI provider
- **`packages/cli/src/nx-workspace/nx.client.ts`** — cross-spawn wrappers for `nx`, `npm`, shell commands (safe from injection)
- **`packages/cli/src/terminal/logger.client.ts`** — colored console output

### Go (third-party plugin)

- **`packages/cli/src/project-scaffolding/go.use-case.ts`** — the four Go kinds, delegating to
  `@nx-go/nx-go` (validated on Nx 23 despite its declared `< 23` devkit range).
  Bootstraps one root `go.mod` via the plugin's `init` + `convert-to-one-mod`,
  then writes build/test/lint targets explicitly. Lint is pinned to
  `golangci-lint`; the plugin's own default is `go fmt`, which only reformats.
- `go-lib` is deliberately **excluded from `release.projects`** via
  `!tag:type:go-lib`. Not tuning — a bug fix: a `go-lib` lands in `packages/`
  but has no per-project manifest, so Nx's default `versionActions` looks for a
  `package.json` that isn't there and aborts while building the release graph,
  which kills `nx release` for the _whole_ workspace. Excluding is also the
  semantically right call: one root `go.mod` means one module, so its packages
  have no independent versions to bump.

### C# (third-party plugin, inference-only)

- **`packages/cli/src/project-scaffolding/csharp.use-case.ts`** — the four C# kinds
  (`csharp-app`, `csharp-lib`, `csharp-internal-lib`, `csharp-function-app`),
  scaffolded directly via `dotnet new` rather than through `@nx/dotnet`
  generators — `@nx/dotnet` is **inference-only** (confirmed by `npm pack`ing
  it and reading its contents: it ships no `generators.json` at all), so it
  writes no `project.json` and mnci writes every target explicitly, the same
  posture as Go's single-module layout.
- **`writeCsharpVersionActions()`** writes `tools/csharp-version-actions.cjs`
  into the *generated* workspace — a workspace-relative `.cjs` file, not a
  new npm package. Nx's `resolveVersionActionsPath` tries `require.resolve`
  as a package specifier first and falls back to a workspace-relative
  `require.resolve(join(workspaceRoot, path))`, which is what makes this
  work with nothing published. `CsharpVersionActions` extends Nx's own
  `VersionActions` and reads/writes the `<Version>` element of the project's
  single `.csproj`, globbed at runtime rather than hardcoded.
- **`csharpLibPublishTarget()`** writes an `nx-release-publish` target
  (`dotnet pack` then `dotnet nuget push`) that is **always present**,
  regardless of registry choice — Nx throws if *zero* projects in a release
  group carry that exact target name, so the target exists unconditionally
  and self-gates at *runtime* on `process.env.NUGET_PAT`, printing "NuGet
  publish is not configured" and exiting 0 when absent. Mirrors how the
  Python publish target carries no registry specifics at generation time.
- **`nugetConfigContent()`** (`workspace-overlay/overlay.use-case.ts`) mirrors `.npmrc`'s design for the
  same reason: `nuget.org` needs no credentials, and an Azure Artifacts feed
  is registered under the fixed key `NUGET_AZURE_SOURCE` (`'AzureArtifacts'`)
  with `packageSourceCredentials` referencing `%NUGET_PAT%` — NuGet's
  environment-variable substitution syntax on every platform, verified
  against Microsoft's own docs (never `${VAR}` or `$VAR`). The key is fixed
  rather than derived from the real feed name so the publish target needs no
  `RegistryConfig` of its own at generation time.
- `mnci sync`/`mnci up` gained a `nuget` ecosystem in `dependency-management/manifest.repository.ts` and
  `dependency-management/registry.client.ts`: NuGet references are read from `<PackageReference>`
  elements in every `.csproj`, and `latestNugetVersions()` shells out to
  `dotnet package search --exact-match --format json` — the same
  "ask the ecosystem's own tool, never hand-roll the registry call" rule
  `latestNpmVersions`/`latestPipVersions` already follow. `resolvedVersion`
  honestly returns `undefined` for NuGet: each `.csproj` restores into its
  own `obj/project.assets.json`, so unlike npm/pub there is no single
  workspace-wide resolved version to report.

### Flutter Plugin (Independent Package)

- **`packages/nx-flutter/`** — a real `@nx/devkit` plugin (`@mnci/nx-flutter`).
  The second first-party plugin, built for the same reason as the Python one:
  no maintained Nx-23-compatible Flutter plugin exists. `@nxrocks/nx-flutter`
  cannot even load on Nx 23 (it imports
  `@nx/workspace/src/utilities/fileutils`, removed in 23).
  - Generators: `application`, `library`, `internal-library` — each delegates
    scaffolding to the official **`flutter create`** (run from a
    `GeneratorCallback`, since it writes to the real FS, not the Tree), so no
    template is maintained against SDK releases
  - Executors: `build` (`flutter build web`), `test`, `lint`
    (`flutter analyze --fatal-infos`)
  - Exports `DartVersionActions` for `nx release` (reads/writes `pubspec.yaml`)
  - **Central dependencies via a Dart pub workspace**: one root `pubspec.yaml`
    lists every project, each member has `resolution: workspace`, and one
    `flutter pub get` at the root resolves internal _and_ external deps into a
    single `pubspec.lock`. An internal lib is consumed with a **plain version
    constraint, no `path:`** — which is why Flutter needs no vendoring step
  - Central lint config: root `analysis_options.yaml`, `include`d by each project
  - Apps build **web only**, keeping the Android SDK off every build agent

### Python Plugin (Independent Package)

- **`packages/nx-python-pip/`** — a real `@nx/devkit` plugin (`@mnci/nx-python-pip`)
  - Generators: `application`, `library`, `internal-library`, `function-application`
  - Executors: `build` (PyPA build), `test` (pytest), `lint` (Ruff), `publish` (twine)
  - Exports `VersionActions` for Nx release integration
  - No dependency on CLI itself; usable standalone in any Nx 21+ workspace

### Testing & E2E

- **`packages/cli/src/*/*.use-case.spec.ts`** — unit tests for each command
- **`packages/cli/e2e/cli.e2e.mjs`** — real generation → lint/test/build/package for all kinds (JS, Python, **Go**, Flutter, **C#**). Gated as an Nx `e2e` target, and run in CI by a nightly-scheduled, Windows-only job (it takes ~25-30 min). Go, Flutter and C# are each gated on their toolchain and reported as **SKIPPED** when absent — never silently dropped, which is exactly how Go went uncovered for so long. The `e2e-windows` job's own toolchain-install steps are unconditional (`continue-on-error`, network operations on someone else's infrastructure) rather than reusing the `ci` job's `existsSync('go.mod')`-style guards, which key on the working directory and would never fire in a job whose generated workspaces live in a temp directory.
- **ESLint config exception** (root `eslint.config.mjs`) — `tsdoc-require-2/require-param` and
  `require-type-param` are off for `workspace-overlay/overlay.use-case.ts`, since `rootScripts()` takes no parameters

## Development Workflow

### Building & Testing

```bash
npm run build          # build @mnci/cli, @mnci/nx-python-pip, @mnci/nx-flutter
npm run test           # unit tests (cli, nx-python-pip, nx-flutter)
npm run lint           # ESLint — code quality, type-aware rules AND formatting
npm run format         # eslint . --fix --cache (auto-fix, incl. formatting)
npm run typecheck      # tsc across the workspace (bundlers do not type-check)
npm run affected       # lint + typecheck + test + build for changed projects only
npm run graph          # open Nx project graph
npm run release:preview  # dry-run what nx release would do
```

### Key Commands

- **`npm run format`** before committing — `eslint . --fix --cache`; Nx generates semicolons/double-quotes, which needs normalising to Standard Style
- **`git diff`** before pushing — review what `mnci upgrade` or any overlay change actually touches
- **No breaking of tools** — the CLI is dogfooded; if a change breaks the e2e or generated workspace lint/test/build, the CI will catch it

### Merge Strategy: merge commits, NOT squash

**Merge pull requests with a merge commit.** Do not squash-merge, and do not
rebase-merge.

The reason is branch hygiene, and it is not a matter of taste. A squash merge puts a
**brand-new commit** on `main` whose content matches the branch but whose SHA is
unrelated to it, so the branch's tip is never an ancestor of `main`. That breaks
`git branch --merged`, which tests ancestry rather than content — and it breaks it
_permanently_. This repo squash-merged ~90 PRs, and the result is that
`git branch -r --merged origin/main` reports **nothing at all**, so telling a
finished branch from an abandoned one requires checking each PR's `merged_at` by
hand. Two of the eight branches left behind that way (`dev`, `badges`) look
identical to git as the merged ones, while actually holding unmerged work.

Rebase-merging has the same defect for the same reason: replayed commits get new
SHAs. Merge commits are the only one of the three strategies that keeps ancestry
intact.

The trade, stated: `main` gains a merge commit per PR plus the branch's individual
commits, so a branch with `wip`/`fix typo` commits now shows them in changelogs.
Keep branch history tidy rather than relying on a squash to hide it. GitHub's
`Merge pull request #N from …` message is not a conventional commit, which is
harmless — conventional-commit parsers skip non-conforming messages when computing
version bumps, and commitlint only runs on local commits via the husky hook.

Enforce it in **Settings → General → Pull Requests**: allow merge commits, disable
squash and rebase merging. Until that is set, nothing stops a merge from silently
being a squash again.

### Release Model

- Versions come from **Conventional Commits** enforced by commitlint at commit time
- `nx release --dry-run` (or `npm run release:preview`) shows what would happen without changes
- On push to `main`, CI runs `nx release --yes` → bumps versions → tags → publishes to npm
- Merge strategy interacts with this directly — see "Merge Strategy" above

## Current State

What the project actually does today, by subsystem. For history — why a decision was
made, what was tried and rejected, which commit fixed what — read the git log; commit
messages and PR descriptions carry that narrative now, not this file. For open work,
see [`ROADMAP.md`](ROADMAP.md), which is the live source of truth for known gaps and
planned features.

### Five language toolchains, one shape

Every kind scaffolds through the ecosystem's own tooling wherever an official Nx
generator exists (`@nx/react`, `@nx/node`, `@nx/js`), and through a thin first-party
Nx plugin where none does:

- **Node/TypeScript** — official `@nx/react` (Vite) and `@nx/node`/`@nx/js` generators.
  `npm-lib`, `internal-lib`, `react-app`, `node-app`, `node-function-app`.
- **Python** — `@mnci/nx-python-pip`, a real first-party `@nx/devkit` plugin (pip, Ruff,
  pytest, PyPA `build`/`twine`; no uv, no Poetry). Kinds: `python-app`, `python-lib`,
  `python-internal-lib`, `python-function-app`. Vendoring via `mnci add python-vendor`.
- **Go** — `@nx-go/nx-go` (third-party), one root `go.mod`, **no** `go.work` and no
  per-project manifests. Kinds: `go-app`, `go-lib`, `go-internal-lib`,
  `go-function-app`. Every target is written explicitly by `project-scaffolding/go.use-case.ts` — the plugin's
  inference needs a per-project `go.mod`, which the single-module layout doesn't have.
  `go-lib` is excluded from `release.projects` (`!tag:type:go-lib`): it has no
  per-project manifest, so Nx's default `versionActions` would abort the whole release
  graph. `golangci-lint`, not the plugin's `go fmt` default.
- **Flutter** — `@mnci/nx-flutter`, a first-party plugin built on a **Dart pub
  workspace**: one root `pubspec.yaml`, every member with `resolution: workspace` and
  an entry in the root `workspace:` list (miss either and pub silently resolves that
  project standalone). Kinds: `flutter-app`, `flutter-lib`, `flutter-internal-lib`.
  Web-only builds (keeps the Android SDK off build agents); git-tag-only publishing
  (no pub registry on Azure Artifacts). A publishable `flutter-lib` must keep its
  `release.version.versionActions` override, or `nx release` fails workspace-wide.
- **C#/.NET** — `@nx/dotnet` is **inference-only** (verified by packing and reading
  the tarball — no `generators.json`), so all four kinds scaffold via `dotnet new`
  directly and write their own targets, the same posture as Go. Kinds: `csharp-app`,
  `csharp-lib` (NuGet), `csharp-internal-lib`, `csharp-function-app` (isolated
  worker). `nx release` needed no new npm package — `tools/csharp-version-actions.cjs`
  is written into the generated workspace and resolved via Nx's workspace-relative
  fallback in `resolveVersionActionsPath`. The publish target
  (`csharpLibPublishTarget()`) is always present and self-gates at runtime on
  `NUGET_PAT`, since Nx throws if zero projects in a release group carry the
  `nx-release-publish` target name. `csharp-function-app`'s `.csproj` needs an
  explicit `<FrameworkReference Include="Microsoft.AspNetCore.App" />` — ASP.NET
  Core's shared framework is not referenced implicitly by `Azure.Functions.Sdk` — and
  `addCsharpFunctionApp()` runs `dotnet restore` again after overwriting the
  generator's placeholder `.csproj`, since the only restore that ran targeted the
  discarded plain-console project and `@nx/dotnet`'s inferred build passes
  `--no-restore --no-dependencies`.
- The e2e (`packages/cli/e2e/cli.e2e.mjs`) drives all five toolchains end to end,
  isolated per section (`section(label, needs, body)`): a crash in one section is
  recorded and the run continues rather than silently dropping every section after
  it, and a section is reported as a loud `SKIPPED` (never silently dropped) when its
  toolchain is absent. Go, Flutter and C# are each gated on their SDK. The
  `e2e-windows` job's toolchain-install steps are **unconditional**
  (`continue-on-error`) rather than reusing the `ci` job's `existsSync('go.mod')`-style
  guards, which key on the job's own working directory and would never fire against
  the e2e's temp-directory workspaces.

### Uniform `build` / `build:dev` / `start` / `dev` scripts, plus per-project launch configs

Every app kind (never a plain library) carries all four npm scripts and a matching
VS Code `launch` entry, written by `registerProjectCommands`
(`project-scaffolding/post-generation.use-case.ts`) at the end of every `mnci add`:

- **`build`** — production.
- **`build:dev`** — carries whatever debug info the toolchain distinguishes (source
  maps, unoptimized codegen, debug symbols); omitted where a language has nothing to
  distinguish (e.g. Flutter's `build-dev` still exists because of an upstream bug
  workaround, but Flutter ships no `start` — no static file server for a built web
  bundle).
- **`start`** — runs what `build` already produced. No rebuild, no watch.
- **`dev`** — builds a debug version and watches, rebuilding/restarting on change.
- Each toolchain needed a different underlying mechanism: Node's `@nx/js:node`
  `buildTarget` needs the manifest's real scoped name (found by running it, not by
  reading the executor's schema); Go and `air` shell out via `execSync`, so
  `-gcflags=all=-N -l` needs the space quoted **inside** the flag string to survive
  the shell join; Python's `watchmedo auto-restart` restarts on every subprocess
  exit by default, so `--no-restart-on-command-exit` is load-bearing; C#'s
  `dotnet build`/`run` default to `Debug` (opposite of the JS convention here), so
  `build`/`build:dev` are explicit `-c Release`/`-c Debug`.
- `.code-workspace` launch configs use `node-terminal` (not `node`) so breakpoints
  bind inside `nx run-many`'s child processes, drive `npm run <script>` (never a
  path into `node_modules`, which is version-dependent), and scope `cwd` by folder
  **name** (`${workspaceFolder:<name>}`). The launch array is merged on upgrade by
  exact name match (`mnci: <name> dev`, not a `startsWith` prefix, which would
  delete every per-project entry on the next `mnci upgrade`).
- A future `cli-lib` kind (publishable package that is also invoked like an app)
  would need the app treatment; deferred, since the kind doesn't exist yet.

### Rollup npm libraries: source maps and declaration files

`@nx/js:lib --bundler=rollup` needed several post-generation repairs, all applied by
`workspace-overlay/overlay.use-case.ts`/`project-scaffolding/post-generation.use-case.ts` and re-applied on `mnci upgrade`:

- **Source maps**: `withRollupSourceMaps` sets `sourcemap: true` in `withNx`'s FIRST
  argument only (the second argument's `output.sourcemap` is always overwritten), and
  forces `compiler: 'babel'` — `@nx/js:lib`'s hardcoded `compiler: 'swc'` produces
  structurally valid but semantically empty maps (`sources: []`) through
  `@nx/rollup`'s swc plugin. `sourcemapPathTransform` also normalizes the emitted
  `sources` path (rollup's OS-native, one-parent-too-many path is wrong on every
  platform for a URL-style specifier).
- **`types`**: the generator writes `types: './dist/index.esm.d.ts'`, a file its own
  build never emits. `repairPublishableManifest()` (`project-scaffolding/post-generation.use-case.ts`) repoints it at
  `./dist/src/index.d.ts` — not the intermediate re-export stub, which
  `@nx/rollup`'s `dts-bundle` plugin builds with `path.relative()`, an OS-native
  separator that is wrong (backslash) on Windows and breaks module resolution
  there. Applies identically to `npm-lib` and `react-lib`. Still open upstream: the
  stub itself remains backslash-broken on Windows; the e2e reports it `SKIPPED`.
- **Packaging**: `files` excludes `!**/*.d.ts.map` (declaration maps reference
  `../src/*.ts`, which `dist`-only packaging never ships) but keeps `.js.map` files,
  since debugging a published package needs them.
- A CI verify-target guard (`verify-targets.integration.spec.ts`) resolves every declared verify
  target to its real shell command and fails on a no-op (`echo`, stub) — Nx disables
  an inferred target (e.g. `typecheck` when `noEmit: true`) by replacing its command
  with a passing `echo`, which is otherwise invisible to CI. Absences must be
  recorded in `ABSENT_BY_DESIGN` with a reason.

### Linting and formatting: ESLint only

There is no Prettier and no oxfmt. `@mnci/eslint-config` is the whole opinion — code
quality, type-aware rules, and JavaScript Standard Style formatting (including
`space-before-function-paren`, unreachable under any Prettier-compatible formatter
since Prettier rewrites `function f (a)` back to `function f(a)` on every run).
`eslint --fix` is the formatter; `npm run format` runs it.

- Rules are ported programmatically from `neostandard` onto `@stylistic` v5 (never a
  runtime dependency on neostandard, which pins an incompatible `@stylistic` version).
  Every block has a unique `name`, checked against `ESLINT_BLOCK_INVENTORY` in
  `workspace-overlay/overlay.use-case.ts` in both directions.
- `mnci/house-style` is a **separate block composed after** the ported `mnci/standard`
  block, holding five deliberate departures from plain Standard:
  `comma-dangle: 'always-multiline'`, `key-spacing` aligned on value (coupled with a
  `no-multi-spaces` exception — moving one without the other makes the config
  self-contradictory), `quote-props: 'consistent-as-needed'`,
  `max-statements-per-line: 2`, and a required blank line before `return`
  (`@stylistic/padding-line-between-statements`, not the removed
  `newline-before-return`).
- Coverage beyond core JS/TS: React (`@eslint-react/eslint-plugin`, ESLint-10-
  compatible, replacing the abandoned `eslint-plugin-react`; hooks rules stay with
  `eslint-plugin-react-hooks`), JSX a11y (`jsx-a11y/recommended`), type-aware rules
  (`configs/typeAware.js`, curated rather than `recommendedTypeChecked`, scoped to
  `{apps,libs,packages}/*/src/**` — a file outside a tsconfig is a fatal parse
  error), intra-project import cycles (`import-x/no-cycle`, `no-self-import`; cross-
  project `no-unresolved` is deliberately off — an internal lib's manifest points at
  an unbuilt `./dist`), regex safety (`eslint-plugin-regexp`), and a root-level
  `lint` target (`ROOT_LINT_TARGET`) covering CI/config/Markdown files that no
  per-project target reaches.
- `nx.json`'s `namedInputs.sharedGlobals` includes every root config file
  (`eslint.config.mjs`, `tsconfig.base.json`, root `package.json`) so `nx affected`
  doesn't treat a change to any of them as invisible — a root config file lives in
  no project, so without this a PR touching only `eslint.config.mjs` verified
  nothing and reported green.
- `mnci doctor`'s `checkNoRetiredFormatter` fails on a leftover `.prettierrc*` /
  `.oxfmtrc.json` / `oxlint.config.ts` — inert from the CLI but still picked up by a
  globally installed formatter extension, silently undoing Standard on save while
  `lint` stays green.

### CI: dual provider, affected-scoped, audited

Both providers (`azure-pipelines.yml`, `.github/workflows/ci.yml`) share
byte-identical guard logic (`workspace-overlay/overlay.use-case.ts`, asserted by an anti-drift test), so a fix
to one is mirrored in the other by construction:

- **`AFFECTED_OR_ALL_GUARD`**: verifies affected projects on a PR (via
  `git merge-base`, not `nrwl/nx-set-shas`), everything otherwise. Every fallback
  path (missing ref, unresolvable merge-base, non-PR run) verifies **everything**,
  never nothing.
- **Release steps** fire only on `event_name == 'push' && ref_name == 'main'` — the
  positive form, not `!= 'pull_request'`, which would also match any trigger added
  later (this bit mnci's own workflow once, via a hand-added `workflow_dispatch`).
  Azure's equivalent trigger fix (`in(Build.Reason, 'IndividualCI', 'BatchedCI')`)
  is still open — see ROADMAP #23.
- **`npm audit`** blocks on `fixAvailable` findings at `moderate` or above (not a
  severity guess), non-blocking only for advisories with no published fix; a
  malformed report exits 0 with the reason printed rather than failing silently.
  `pip-audit` stays report-only — its output carries no `fixAvailable` equivalent.
  This gate has gone stale twice on the same advisory class (a `js-yaml`/
  `smol-toml` pin drifting one patch behind the advisory's actual fix line); treat
  an `overrides` pin as a claim about a point in time, not an invariant.
- The nightly Windows e2e (`schedule: '0 3 * * *'`) provisions Go's linter and the
  Flutter SDK unconditionally, and is the only thing that has ever exercised
  `@mnci/nx-flutter` on Windows for real — which is how a `spawnSync`-cannot-run-
  `.bat` bug (the CVE-2024-27980 hardening) went unnoticed through several releases;
  fixed by routing every Flutter invocation through `cross-spawn` (`runFlutter()`),
  which resolves `.bat` shims without `shell: true`.
- `.devcontainer/devcontainer.json` mirrors CI's toolchain (Node/Python/Go via
  devcontainer features; Flutter from the same pinned SDK clone CI uses, since no
  maintained Flutter feature exists). Never built against a real Docker daemon in
  this environment — booting it once is still an open verification step.

### Release model and publish auth

- `nx release` is **tag-only**: it never commits, so versions resolve from git tags.
  **A tagless clone makes a dry run silently wrong** (falls back to
  `fallbackCurrentVersionResolver: "disk"`, which reads stale manifest versions) —
  always `git fetch --tags` before trusting `nx release --dry-run` output.
  Versioning is driven entirely by Conventional Commits (commitlint via husky).
  The disk fallback is a real hazard, not just a local dry-run footgun: it exists so a
  brand-new package's first release doesn't hard-error the whole release graph (nx's
  own `--first-release` is a one-shot CLI flag, not something a fixed CI command can
  scope to only the projects that need it), but for an already-published project it
  means an unresolvable tag silently proposes — and can publish — a version
  **downgrade**, reproduced against a real multi-package workspace (`0.2.0` proposed
  against a published `0.7.0`). The generated CI is safe only because it always fetches
  full history and releases only from `main`; `SHALLOW_CLONE_GUARD` in `workspace-overlay/overlay.use-case.ts`
  makes that an explicit, enforced precondition (fails loudly on a shallow checkout)
  rather than leaving it as an unstated assumption one `fetchDepth`/`fetch-depth` edit
  away from silently breaking.
- **Merge PRs with a merge commit** — never squash or rebase-merge. Both replace the
  branch tip's SHA, permanently breaking `git branch --merged`'s ancestry check;
  this repo already squash-merged ~90 PRs and lost the ability to tell a finished
  branch from an abandoned one that way.
- `.npmrc`: Azure Artifacts gets real `@scope:registry` routing (npm prefers a
  scope's registry over the global default on publish) plus `username`/`_password`
  Basic auth; public npm gets auth only, no routing (npmjs.org is already the
  default, so "routing" would be a false claim of protection).
- **Azure Artifacts rejects a PAT sent as a Bearer token.** The feed's publish
  endpoint answers with `www-authenticate: Bearer authorization_uri=https://
  login.windows.net/...`, meaning the Bearer scheme wants an **Entra ID** token,
  not a PAT — npm sends `_authToken` verbatim as Bearer and gets rejected. **A PAT
  only authenticates via Basic** (`username`/`_password`), which is what
  `npmrcContent()` already emits; do not "fix" this by switching to `_authToken`.
  The actual fix for a real Azure Pipelines run is the `npmAuthenticate@0` task
  (injects an Entra-issued token) — not yet adopted in `workspace-overlay/overlay.use-case.ts`, since it would
  overwrite a hand-set password; see ROADMAP for the open trade-off.
  Both feed path forms (`/npm/` and `/npm/registry/`) are keyed in the generated
  file, since npm matches credentials by URL prefix and walks only upward.
- XML config files (`NuGet.Config`) reject `<!-- -->` comments containing `--`
  anywhere in the body — a real trap hit once (a `--registry` substring inside a
  comment invalidated the whole document, cascading into an unrelated Flutter e2e
  failure via a corrupted Nx project graph). `workspace-overlay/overlay.use-case.spec.ts` has a permanent
  regression test for this.

### Workspace tooling: `mnci sync`, `mnci up`, `mnci doctor`

- `nx sync` reconciles **TypeScript project references only** — it has no opinion
  on dependency versions, and npm has no `catalog:` mechanism, so nothing else
  enforces one-version-per-workspace.
- `mnci sync` closes that gap: converges every externally-declared dependency range
  to the installed version across npm/pip/pub/go/nuget, then runs `nx sync`. Go is
  excluded (one root module, nothing to converge) with an explicit message, not a
  silent no-op. Peer ranges (`>=` compatibility declarations) are excluded from
  convergence — narrowing one drops consumers of a published plugin.
  `resolvedVersion` is honestly `undefined` for pip (no lockfile) and NuGet (each
  `.csproj` restores independently, no workspace-wide resolution).
- `mnci up` reproduces `npm-check -u`'s grouped report and multiselect across all
  five ecosystems, plus a "which projects declare this" column no single-project
  tool can produce; selecting a row rewrites every declaration, which is what stops
  `up` from creating the drift `sync` repairs. Each ecosystem's own tool answers the
  "what's latest" question (`npm view`, `pip index versions`, `go list -m -u -json
  all`, `flutter pub outdated --json`, `dotnet package search`) rather than a
  hand-rolled registry call, so private feeds and their auth just work.
- `mnci doctor` is a read-only invariant checker: exits non-zero on any finding,
  and every finding names its remedy (retired formatter files, undeclared root
  dependency hoisted into a rollup-bundled project via `@nx/dependency-checks`,
  linter-mode consistency, etc.).

### `@mnci/az-durable`

A fifth package: typed compile-time safety across the Azure Durable Functions
orchestrator/activity boundary, scaffolded via `mnci add npm-lib` (dogfooding the
CLI on a real published package). Every scheduling helper (`callActivity`,
`eventTask`, `timerTask`, `timerTaskUntil`, `subOrchestrationTask`) is a generator
delegated to via `yield *`, which is the only mechanism that gives each call its own
per-call return type (a plain generator has one `TNext` shared by every `yield`).
`continueAsNew` is a handler argument, not a free function, since it must be typed
to *that* orchestration's own input. Peer dependency only (`durable-functions` is
imported by value in `activity.ts`/`orchestration.ts` to call `df.app.*`, but that's
still zero runtime `dependencies`). `test/dogfood/` holds reconstructions of real
workflows for API-shape validation, not production verification — its README says
so.

## Known Issues & Future Plans

[`ROADMAP.md`](ROADMAP.md) is the live, actively-maintained tracker for open work —
read its top summary section first; it states what's done, what's open, and at what
priority, with file:line citations for anything found by measurement rather than
assumed. As of the last rollup there: **no P1 is open**. Open work is:

- **New capability (P2):** a container/Docker project kind; e2e test projects
  (Playwright, measured as needing no rule relaxation against the current lint
  config); multi-project `dev up`; `--preset` composition for scaffolding several
  kinds at once.
- **A gate that still doesn't gate:** Azure Pipelines' release trigger has the same
  "any non-PR event" over-fire shape already fixed for GitHub Actions, but the
  precise fix is unverified — no Azure pipeline run has ever exercised this
  project's actual release path, so there's nothing to check a change against.
- **Deliberately deferred upgrade:** TypeScript 7 for the compile step, pending a
  proper compatibility pass.
- Two P3 items, otherwise closed.
- A `cli-lib` project kind (publishable package that's also invoked like an app) is
  named but not yet built — noted under the build/dev script convention above.

## Design Decisions & Reasoning

### "Files mnci owns" Philosophy

`applyOverlay()` writes a small, fixed set of config files; Nx owns everything else:

1. `nx.json` (release, sync, generators, `namedInputs.sharedGlobals`, mnci metadata)
2. `package.json` (curated root scripts only — name, scripts, the dual TS compiler deps,
   the ESLint toolchain)
3. `.npmrc` (publish auth; the azure variant also routes `@scope` to the feed)
4. *(nothing — there is no formatter config; `mnci upgrade` DELETES `.prettierrc*`,
   `.prettierignore`, `.oxfmtrc.json` and `oxlint.config.ts` if a past version wrote them)*
5. `eslint.config.mjs` (one import from `@mnci/eslint-config`, plus the block inventory)
6. `commitlint.config.mjs` + `.husky/commit-msg` (conventional-commit enforcement)
7. `<workspace-name>.code-workspace` (VS Code configuration: folders, settings,
   extensions, per-project tasks, and `launch` configs for build/test/lint/typecheck)
8. CI pipeline file(s) (`azure-pipelines.yml` and/or `.github/workflows/ci.yml`)
9. `.github/dependabot.yml` (`--ci=github|both` only)
10. `.devcontainer/devcontainer.json` (a local environment matching CI's toolchain)

Everything else — source, tests, `project.json` targets — is auto-generated by delegating
to Nx generators. There are **no** per-project ESLint configs: every `@nx/*` generator
writes one, and `removeGeneratedEslintConfig()` (`project-scaffolding/post-generation.use-case.ts`) deletes it after every
`add`, so the config cannot re-fragment as a workspace grows.

### ESLint is the whole opinion: quality, types, and formatting, in one package

`@mnci/eslint-config` is a real package with no build step, whose ~20 plugins are its
own dependencies rather than ~20 devDependencies in every generated workspace. An
upgrade therefore reaches existing workspaces through `npm update`, and the config is
independently testable against the real `eslint` binary.

There is deliberately **no formatter, and no second tool to keep in sync.** Prettier
and oxfmt were both tried and retired — a formatter and a linter that each hold style
opinions must be kept in agreement, and the only way that ever worked was
`eslint-config-prettier` switching every stylistic ESLint rule off, meaning ESLint had
no opinion of its own. With no formatter, `space-before-function-paren` — Standard's
signature rule, previously unreachable because Prettier and oxfmt both rewrite
`function f (a)` back to `function f(a)` — is finally ON. `eslint --fix` **is** the
formatter; `npm run format` runs it.

**Every config block carries a `name`** (`mnci/base`, `mnci/react`, `mnci/house-style`,
…), including ones spread from upstream presets that ship anonymous — `configs/named.js`
fills those in while keeping any name upstream provides. The names are what
`eslint --inspect-config` reports and what a user's override targets, and they are the
whole reason a three-line root config is navigable at all. The generated
`eslint.config.mjs` ships the same list as a comment plus an override recipe;
`ESLINT_BLOCK_INVENTORY` in `workspace-overlay/overlay.use-case.ts` holds it, and an `workspace-overlay/overlay.use-case.spec.ts` test fails
in **both** directions if it and the real config disagree — a stale inventory points the
reader at a block that does not exist, and nothing about generating a workspace would
notice.

`mnci/house-style` (composed **after** the ported `mnci/standard` block) is where this
repo's five deliberate departures from plain Standard live — see "Linting and
formatting: ESLint only" under Current State for the list. Editing the ported block in
place instead of adding to `house-style` would silently revert those choices the next
time it's re-extracted from upstream.

### `.npmrc`: the two registry kinds get deliberately different files

Publish auth is wired, and the two variants differ because the honest answer differs.

**Azure Artifacts gets `@scope:registry` routing plus feed credentials.** Scope routing
is real protection here: npm prefers a scope's registry over the global one when
publishing a scoped package, so a `@scope/*` package cannot reach npmjs.org by accident.
Verified against a real registry (npm reports `Publishing to <feed>`), and again in a
real generated workspace. Only the scope is routed — a global `registry=` would send
every install through the feed, so `npm ci` would need feed auth just to fetch public
packages.

**Public npm gets the auth line only, no routing.** npmjs.org is already the default, so
routing the scope there changes nothing, and calling it protection would be false — the
public registry _is_ the intended target. This matters because the old file made exactly
that false claim: `packages/cli/README.md` asserted scope routing made accidental public
publishes impossible while no `@scope:registry` line was ever emitted, and
`workspace-overlay/overlay.use-case.spec.ts` asserted the line's absence. **Do not reintroduce a protection the
configuration cannot provide** — the generated file now says why it is absent.

One trap: the same `PAT` is consumed in **two encodings**. npm's `_password` takes the
base64 value Azure hands out, as-is; `twine` wants the raw token, which the CI release
guard decodes. Check which before wiring a third protocol.

### Tag-Only Git

- `nx release` never commits, only tags
- Versions resolve from git tags on future runs
- Allows retagging if a release needs rollback (tag deletion/recreation)
- Simplifies cherry-pick workflows (no merge commits in tag history)

### No Plugin for Node/React Functions

- Node Function Apps: official `@nx/node:application` + thin v4 overlay (hand-written `host.json`, `function.json`)
- React Apps: official `@nx/react` (Vite) with per-environment builds (dev/uat/prod)
- Both use official generators; no third-party plugins except Python

### Python as a Separate Nx Plugin

- Could have stayed in `add/python.ts`, but:
  - Generation logic was growing (4 kinds, each with their own targets)
  - Vendoring, versioning, publishing needed proper abstraction
  - Extracted to `@mnci/nx-python-pip` for reuse in other Nx workspaces
  - Cleaner separation of concerns (CLI is thin, plugin is the opinion)

## Testing & Verification

### Unit Tests

- `packages/cli/src/*.test.ts` — mocked Nx/shell calls, fixture-based
- `packages/nx-python-pip/src/generators/*.test.ts` — real Nx devkit testing
- All tests must pass before committing

### E2E Tests

- `packages/cli/e2e/cli.e2e.mjs` — real `mnci new` + `mnci add` for all kinds
- Verifies: generation → lint → test → build → package/publish
- Covers internal-lib vendoring, cross-project imports, Python wheel content
- Runs in CI on every push to main

### Linting & Formatting

- `npm run lint` → ESLint (code quality, types, **and** formatting — there is no
  separate formatter or `format:check` step)
- `npm run format` → `eslint . --fix --cache` (local use, also auto-fixes formatting)
- ESLint config exception for `workspace-overlay/overlay.use-case.ts` (TSDoc rules off since `rootScripts()` has no params)

## Debugging & Troubleshooting

### Common Issues

1. **Tests fail with "No stack found"** → `stack` object changed shape; check `StackConfig` interface
2. **Lint errors on TSDoc** → verify `@param`, `@returns`, `@throws` tags; check eslint.config.mjs for exceptions
3. **E2E failures on new kind** → verify `add/<kind>.ts` generates valid project.json + runs nx:run-many for lint/test/build
4. **CI hangs on Python** → ensure `pip-audit` is guarded; if workspace has no Python projects, step should no-op cleanly
5. **`nx release --dry-run` reports absurd versions** → **run `git fetch --tags` first.**
   A clone made without tags (which is what a fresh CI or remote-agent checkout
   gives you) makes the dry run *silently wrong* rather than failing: with no tag
   to resolve, every project falls back to `fallbackCurrentVersionResolver: "disk"`,
   and the manifests on disk are stale **by design** — `release.git.commit` is
   `false`, so a release tags and publishes without ever writing the bump back.
   `@mnci/cli` reads `1.0.0` on disk against `4.0.6` published, so a tagless dry
   run proposes `2.0.0`: a version that already exists, from a diagnosis that
   looks authoritative. The real answer with tags fetched is `4.0.7`. `ci.yml`
   already does this (`git fetch --all --prune --tags`, commented "Version
   resolution needs the release tags") — the trap is for whoever debugs locally.
   **Read a release dry run only from a clone that has the tags.**

### Key Invariants to Preserve

- `applyOverlay()` is deterministic (same input → same output, every time)
- `mnci upgrade` re-applies overlay safely (overwrites mnci-owned files only)
- Stack is persisted in `nx.json`'s `mnci` block (upgrade reads it back)
- All shell commands use cross-spawn (safe from injection)
- Shared dev/tool packages live at the ROOT; runtime dependencies belong to the package that imports them. Go is the stated exception — one root `go.mod` means there is no per-project manifest to own anything
- A peer range is never rewritten by mnci: it declares compatibility, not a version choice, and narrowing it drops consumers
- `nx sync` reconciles TypeScript project references ONLY — it has no opinion about dependency versions
- Python toolchain is invoked as `python3 -m <tool>` (not venv paths, works cross-platform)
- Go uses a SINGLE root `go.mod`; never reintroduce `go.work` (a stale `use` entry breaks the whole Nx graph)
- Go targets are written explicitly by `project-scaffolding/go.use-case.ts` — `@nx-go/nx-go`'s inference needs a per-project `go.mod`, which the single-module layout has not
- Flutter uses a SINGLE root `pubspec.yaml` pub workspace; every member needs `resolution: workspace` **and** an entry in the root `workspace:` list. Miss either and pub silently resolves that project standalone, giving it its own lockfile and dropping it out of the shared resolution
- A publishable `flutter-lib` MUST keep its `release.version.versionActions` override — without it `nx release` fails for the entire workspace, not just that project (same failure mode as the `go-lib` exclusion above)
- The Flutter SDK is installed **outside** the workspace by CI; never clone it inside, as it ships its own nested `pubspec.yaml` files that pollute pub resolution and the Nx graph
- Any change to a CI guard must be mirrored in BOTH providers — `workspace-overlay/overlay.use-case.spec.ts`'s anti-drift test asserts the guard bodies are byte-identical (only the PATH-publishing step legitimately differs)

## See Also

- [`ROADMAP.md`](ROADMAP.md) — open work: known gaps, planned kinds, and the
  invariants that are documented but not yet enforced
- [`packages/cli/README.md`](packages/cli/README.md) — detailed CLI & workflow docs
- [`packages/nx-python-pip/README.md`](packages/nx-python-pip/README.md) — Python plugin reference
- [`packages/nx-flutter/README.md`](packages/nx-flutter/README.md) — Flutter plugin reference
- [`packages/cli/src/workspace-overlay/overlay.use-case.ts:1–100`](packages/cli/src/workspace-overlay/overlay.use-case.ts) — config constants & VSCode workspace template
