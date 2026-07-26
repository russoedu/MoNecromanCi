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
├── nx-python-pip/        # @mnci/nx-python-pip — Nx plugin for pip-native Python projects
└── nx-flutter/           # @mnci/nx-flutter — Nx plugin for Flutter/Dart pub workspaces

tsconfig.base.json        # shared TypeScript configuration

libs/                     # empty (.gitkeep only) — internal libs would live here
(apps/)                   # If this repo had apps, they'd go here; currently it doesn't

.github/
├── workflows/ci.yml      # GitHub Actions CI (if --ci=github|both during initial setup)
└── dependabot.yml        # Weekly dependency update PRs (if --ci=github|both)

azure-pipelines.yml       # Azure Pipelines CI (if --ci=azure|both during initial setup)

nx.json                   # Nx workspace config with release, sync, generators settings
.eslintrc.config.mjs      # ESLint flat config for code quality (no formatting)
.prettierrc.json          # Prettier config for code formatting (JavaScript Standard Style)
.commitlintrc.mjs         # Conventional commit enforcement (via husky hook)
package.json              # Root scripts (build, lint, test, format, release:preview, etc)
```

## Technology Stack

- **Bundler**: npm workspaces (TypeScript project references, no per-project `project.json`)
- **Language**: TypeScript (with dual compiler: TS 6 for API, TS 7 `tsc` for compile)
- **Linting**: ESLint (flat config) — code quality only
- **Formatting**: Prettier — JavaScript Standard Style (no semicolons, single quotes, 2-space)
- **Testing**: Jest (default) or Vitest
- **Build**: esbuild (Node apps), Rollup (npm libs), `python -m build` (Python), `go build` (Go), `flutter build web` (Flutter)
- **Release**: `nx release` (versioning from conventional commits, git tag-only push)
- **CI**: Azure Pipelines and/or GitHub Actions
- **Python toolchain**: pip (not uv), Ruff, pytest, PyPA `build`/`twine`
- **Go toolchain**: one root `go.mod` (single module), golangci-lint, `go test`, via `@nx-go/nx-go`
- **Flutter toolchain**: one root `pubspec.yaml` (Dart pub workspace), `flutter analyze`/`test`, via `@mnci/nx-flutter`

## Key Files & Their Purpose

### Entry Points

- **`packages/cli/src/cli.ts`** — CLI argument dispatcher (`mnci new`, `mnci add`, `mnci upgrade`)
- **`packages/cli/src/commands/new.ts`** — workspace generation (calls `applyOverlay`)
- **`packages/cli/src/commands/add.ts`** — per-project scaffolding (delegates to Nx generators)
- **`packages/cli/src/commands/upgrade.ts`** — re-apply overlay to existing workspace

### Core Implementation

- **`packages/cli/src/overlay.ts`** — the "5 files mnci owns":
  - Exports `applyOverlay()` (pure file writer, deterministic)
  - Exports config constants: `ROOT_SCRIPTS`, `RELEASE_CONFIG`, `PRETTIER_CONFIG`, etc.
  - Exports VS Code workspace file template (`vscodeWorkspace()`)
  - Exports CI YAML generators: `azurePipelinesYaml()`, `githubActionsYaml()`
  - Exports shared guard scripts (Python install, pack, release) used by both CI providers

- **`packages/cli/src/overlay.test.ts`** — comprehensive overlay fixture tests (171 assertions)

### CLI Plumbing

- **`packages/cli/src/prompts.ts`** — interactive prompts for workspace/app names, stack choices, CI provider
- **`packages/cli/src/nx.ts`** — cross-spawn wrappers for `nx`, `npm`, shell commands (safe from injection)
- **`packages/cli/src/util/logger.ts`** — colored console output

### Go (third-party plugin)

- **`packages/cli/src/commands/add/go.ts`** — the four Go kinds, delegating to
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

- **`packages/cli/src/commands/*.test.ts`** — unit tests for each command
- **`packages/cli/e2e/cli.e2e.mjs`** — real generation → lint/test/build/package for all kinds (JS, Python, Flutter). Gated as an Nx `e2e` target, and only run in CI by a `workflow_dispatch`-only Windows job (it takes ~25-30 min). **Go has no e2e coverage** — it was marked done but never written.
- **ESLint config exception** (`.eslintrc.config.mjs` lines 310–317) — TSDoc rules disabled for `overlay.ts` since `rootScripts()` has no parameters

## Development Workflow

### Building & Testing

```bash
npm run build          # build @mnci/cli, @mnci/nx-python-pip, @mnci/nx-flutter
npm run test           # unit tests (cli, nx-python-pip, nx-flutter)
npm run lint           # ESLint (code quality) + Prettier (formatting check)
npm run format         # Prettier --write (auto-fix formatting)
npm run affected       # lint + test + build for changed projects only
npm run graph          # open Nx project graph
npm run release:preview  # dry-run what nx release would do
```

### Key Commands

- **`npm run format`** before committing — workspace is generated with semicolons/double-quotes, needs normalization to Standard Style
- **`git diff`** before pushing — review what `mnci upgrade` or any overlay change actually touches
- **No breaking of tools** — the CLI is dogfooded; if a change breaks the e2e or generated workspace lint/test/build, the CI will catch it

### Release Model

- Versions come from **Conventional Commits** enforced by commitlint at commit time
- `nx release --dry-run` (or `npm run release:preview`) shows what would happen without changes
- On push to `main`, CI runs `nx release --yes` → bumps versions → tags → publishes to npm

## Current State & Recent Changes

### Stack Simplification (Latest)

- **Removed oxlint entirely** — was an alternative linter, but:
  - Not essential (ESLint + Prettier handles the same job)
  - Reduced configuration surface
  - Simpler for users to understand
- **Unified on ESLint + Prettier** everywhere
  - ESLint for code quality (correctness, not style)
  - Prettier for all formatting (JavaScript Standard Style)
- **Stack now has one choice**: test runner (`jest` / `vitest`), not linter

### VS Code Workspace File (Latest)

- Generated as `<workspace-name>.code-workspace` on `mnci new`
- Single file to open in VS Code (`File > Open Workspace from File`)
- Includes:
  - Folder structure (root, packages/_, libs/_)
  - ESLint validation settings
  - Prettier as default formatter
  - Recommended extensions (ESLint, Prettier, Angular Console, Jest Runner)
- Replaces the old per-folder `.vscode/extensions.json`

### Python Plugin (Completed)

- Dropped `@nxlv/python` (uv-only, not maintained for pip)
- Built in-house: `@mnci/nx-python-pip` with generators + executors
- Pip + Ruff + pytest + PyPA `build`/`twine` — no uv, no Poetry
- Unified release with npm via `nx release` → `twine upload`
- Vendoring via `mnci add python-vendor` for internal-lib dependencies

### CI Provider Choice

- **`--ci` flag**: `azure` (default) | `github` | `both`
- Azure Pipelines: `azure-pipelines.yml`
- GitHub Actions: `.github/workflows/ci.yml`
- Dependabot: `.github/dependabot.yml` (for `github`/`both` only)
- Same logic, different syntax — no drift

### Nx Cloud (Optional)

- `--nx-cloud` flag opts in (default off)
- Named provider values (`azure` or `github`) avoid non-interactive hang in `create-nx-workspace`
- Requires browser setup after generation

## Design Decisions & Reasoning

### "5 Files" Philosophy

Only the CLI owns exactly 5 files; Nx owns everything else:

1. `nx.json` (release, sync, generators, mnci metadata)
2. `.npmrc` (auth for Azure Artifacts or npm)
3. `.prettierrc.json` + `.eslintrc.config.mjs` (formatting/linting)
4. `.husky/commit-msg` (commitlint hook)
5. `.code-workspace` (VS Code configuration)
6. CI pipeline file(s) (`azure-pipelines.yml` and/or `.github/workflows/ci.yml`)

Everything else — source, tests, config — is auto-generated by delegating to Nx generators.

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

- `npm run lint` → ESLint (code quality)
- `npm run format:check` → Prettier (formatting in CI)
- `npm run format` → Prettier --write (local use)
- ESLint config exception for `overlay.ts` (TSDoc rules off since `rootScripts()` has no params)

## Debugging & Troubleshooting

### Common Issues

1. **Tests fail with "No stack found"** → `stack` object changed shape; check `StackConfig` interface
2. **Lint errors on TSDoc** → verify `@param`, `@returns`, `@throws` tags; check eslint.config.mjs for exceptions
3. **E2E failures on new kind** → verify `add/<kind>.ts` generates valid project.json + runs nx:run-many for lint/test/build
4. **CI hangs on Python** → ensure `pip-audit` is guarded; if workspace has no Python projects, step should no-op cleanly

### Key Invariants to Preserve

- `applyOverlay()` is deterministic (same input → same output, every time)
- `mnci upgrade` re-applies overlay safely (overwrites mnci-owned files only)
- Stack is persisted in `nx.json`'s `mnci` block (upgrade reads it back)
- All shell commands use cross-spawn (safe from injection)
- Python toolchain is invoked as `python3 -m <tool>` (not venv paths, works cross-platform)
- Go uses a SINGLE root `go.mod`; never reintroduce `go.work` (a stale `use` entry breaks the whole Nx graph)
- Go targets are written explicitly by `add/go.ts` — `@nx-go/nx-go`'s inference needs a per-project `go.mod`, which the single-module layout has not
- Flutter uses a SINGLE root `pubspec.yaml` pub workspace; every member needs `resolution: workspace` **and** an entry in the root `workspace:` list. Miss either and pub silently resolves that project standalone, giving it its own lockfile and dropping it out of the shared resolution
- A publishable `flutter-lib` MUST keep its `release.version.versionActions` override — without it `nx release` fails for the entire workspace, not just that project (same failure mode as the `go-lib` exclusion above)
- The Flutter SDK is installed **outside** the workspace by CI; never clone it inside, as it ships its own nested `pubspec.yaml` files that pollute pub resolution and the Nx graph
- Any change to a CI guard must be mirrored in BOTH providers — `overlay.test.ts`'s anti-drift test asserts the guard bodies are byte-identical (only the PATH-publishing step legitimately differs)

## See Also

- [`packages/cli/README.md`](packages/cli/README.md) — detailed CLI & workflow docs
- [`packages/nx-python-pip/README.md`](packages/nx-python-pip/README.md) — Python plugin reference
- [`packages/nx-flutter/README.md`](packages/nx-flutter/README.md) — Flutter plugin reference
- [`packages/cli/src/overlay.ts:1–100`](packages/cli/src/overlay.ts) — config constants & VSCode workspace template
