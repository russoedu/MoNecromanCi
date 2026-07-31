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
├── eslint-config/        # @mnci/eslint-config — the shared ESLint flat config
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
eslint.config.mjs         # ESLint flat config — mnci-owned; 3 lines importing @mnci/eslint-config
.prettierrc.json + .prettierignore   # Prettier config for code formatting (JavaScript Standard Style)
commitlint.config.mjs     # Conventional commit enforcement (via husky hook)
.husky/commit-msg         # commitlint hook
.npmrc                    # comment-only — publish auth is a documented deferral (see below)
<workspace-name>.code-workspace  # single-file VS Code workspace (folders, extensions, settings)
package.json              # Root scripts (build, lint, test, format, release:preview, etc)
```

Every file above is mnci-owned — written (and, on `mnci upgrade`, rewritten) by
`applyOverlay()` in `overlay.ts`. That includes `eslint.config.mjs`, which it did **not**
until recently: it used to come from `create-nx-workspace`, which is exactly why the rich
config this repo had never reached a single generated workspace.

`applyOverlay()` also **deletes** two things `create-nx-workspace` scaffolds: its own
`.prettierrc` (which wins Prettier's precedence over mnci's `.prettierrc.json`, silently
discarding the entire formatting opinion) and `.vscode/` (fully covered by the
`.code-workspace` file). Deletion is newer behaviour than overwriting, and `mnci upgrade`
does it too — the docs already tell users to `git diff` before committing an upgrade.

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

- **`packages/cli/src/overlay.ts`** — the config files mnci owns (see "Files `mnci` owns" below):
  - Exports `applyOverlay()` (pure file writer, deterministic)
  - Exports config constants: `ROOT_SCRIPTS`, `RELEASE_CONFIG`, `PRETTIER_CONFIG`, etc.
  - Exports VS Code workspace file template (`vscodeWorkspace()`)
  - Exports CI YAML generators: `azurePipelinesYaml()`, `githubActionsYaml()`
  - Exports shared guard scripts (Python install, pack, release) used by both CI providers

- **`packages/cli/src/overlay.test.ts`** — comprehensive overlay fixture tests (268 assertions)

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
- **ESLint config exception** (root `eslint.config.mjs`) — `tsdoc-require-2/require-param` and
  `require-type-param` are off for `overlay.ts`, since `rootScripts()` takes no parameters

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

Ordered newest first. The "(Latest)" tag marks the most recent entry only — older
entries describe how the project got here, not what's newest.

### One Root ESLint Config, One Prettier Config, in Generated Workspaces (Latest)

Eight reported problems with real generated workspaces, all traced to one pattern:
**this repo's own root had been hand-upgraded while `overlay.ts` was never updated**, so
mnci worked while everything it produced did not.

- **`@mnci/eslint-config`** is the fourth package: the whole linting opinion (JS/TS,
  React, JSON/JSONC/JSON5, YAML, Markdown, CSS, HTML+a11y, tests), no build step, tested
  against the real `eslint` binary. A generated workspace gets a three-line root config
  importing it and **no per-project configs** — every generator writes one, and
  `removeGeneratedEslintConfig()` deletes it after each `add`.
- **`@nx/dependency-checks` moved to that root config**, retiring npmLib's hand-written
  `NPM_LIB_ESLINT_CONFIG`. Verified: a project with no config of its own still gets its
  inferred `lint` target and still reports real violations. The e2e enforces both halves
  permanently, since a future Nx change there would silently disable linting workspace-wide.
- **Prettier was dead in every generated workspace.** `create-nx-workspace` writes
  `.prettierrc`, mnci wrote `.prettierrc.json`, and `.prettierrc` wins Prettier's
  precedence — so mnci's whole formatting opinion was discarded. The overlay now deletes
  it, and `trailingComma` is corrected from `"es5"` to `"none"` (Standard forbids them).
  Nx's `.vscode/` goes too.
- **`runPrettier()` runs at the end of `new` and every `add`.** Nx's generators emit
  semicolons and double quotes, so a fresh workspace failed its own `format:check` before
  the user wrote a line. Non-fatal: the project is already generated by then.
- **`space-before-function-paren` cannot be enabled alongside Prettier** — see the ESLint
  section under Design Decisions. This reversed an earlier decision; it was verified by
  round-tripping a real file through both binaries rather than argued from docs.
- **Nx's generators run with `--linter=none`, and mnci registers
  `@nx/eslint/plugin` in `nx.json` itself.** Found by real end-to-end
  generation, not by reading code: `@nx/react` pins `eslint-plugin-import@2.31.0`,
  whose peer range caps at ESLint 9, so `mnci add react-app` failed its npm
  install outright. `--linter=none` is the right
  answer regardless — mnci deletes the config those generators write — but it
  removes the side effect that used to register the plugin, so the overlay now
  owns that too. A latent oddity goes with it: `npm run lint` previously worked
  in a fresh workspace only by accident.
- **The stack is ESLint 9, not 10** — decided by the plugins, not the version
  number. `eslint-plugin-react` has no ESLint 10 release at all (it throws while
  loading `react/display-name`, killing lint for every `.tsx` file), and
  `@nx/react` pins `eslint-plugin-import@2.31.0`, which caps at 9. So:
  `eslint ^9.39` and `eslint-plugin-unicorn` pinned to `^61`, the last line
  supporting 9. Three unicorn rules this config would want off don't exist in
  v61 and so aren't listed — ESLint rejects a config naming a rule its plugin
  lacks. `configs/base.js` records which ones, for whoever upgrades next.
- **This repo now lints itself with the config it ships** (`eslint.config.mjs` is the same
  three-line import), which is what makes the original drift impossible to reintroduce.
  TSDoc enforcement stays a root-only extra block — an mnci-authoring standard, not
  something to impose on a user's workspace.

### Local-Dev Commands: `:build`/`:qa`/`:start` Scripts and VS Code Tasks

- Every `mnci add` now finishes by calling `registerProjectCommands`
  (`commands/add/shared.ts`) on the project it just generated: `<name>:build`
  (when the kind has a build target), `<name>:qa` (`lint && test`, always),
  and `<name>:start` (only kinds with a real local dev-server story — never a
  library) get written as root `package.json` scripts, and mirrored as VS
  Code Tasks in the workspace's `.code-workspace` file. Idempotent — a repeat
  `add` of the same name overwrites its own entries rather than duplicating.
- `:start` routes through an existing generator target where one already
  exists (`nx run <name>:serve` for `react-app`/`node-app`) or a small
  `nx:run-commands` target mnci writes where none did: `go run .` (`go-app`),
  `flutter run -d chrome` (`flutter-app`), `python3 main.py` (`python-app` —
  mnci writes a runnable `main.py` too, since the plugin's own sample module
  has none), and `func start` for `node-function-app`/`python-function-app`.
- **Fixed a real bug found while wiring this up**: `node-function-app`'s
  manifest `main` field was `main.js`, correct only for the _deployed_ (zip,
  flattened) layout, never for local dev — `apps/<name>/main.js` never exists
  before a build, and the build only ever writes `apps/<name>/dist/main.js`.
  Local `func start` would have failed outright. Fixed by pointing `main` at
  `dist/main.js` and changing the `package` target to nest `dist/` inside the
  zip (`addLocalFolder(..., 'dist')`) instead of flattening it — one `main`
  value now resolves correctly both locally and once deployed.
- `go-function-app` deliberately gets **no** `:start` script: unlike the Node
  and Python function-app kinds, it writes no `host.json`/custom-handler
  config, so there is nothing for `func start` to attach to. A known gap,
  stated plainly rather than shipping a script that would just fail.
- Also fixed a pre-existing, unrelated bug found in the same file:
  `vscodeWorkspace()`'s `folders` array was hardcoded to _this repo's own_
  packages (`packages/cli`, `packages/nx-python-pip`, and a stale
  `libs/monecromanci-v2` path that no longer exists) instead of being
  generic — every fresh `mnci new` workspace was getting nonsense folder
  entries. Now just `[{ path: '.', name: workspaceName }]`.

### Go and Flutter Support, Plus Four Pre-existing Bug Fixes

- **Go**: four kinds (`go-app`, `go-lib`, `go-internal-lib`, `go-function-app`) via
  `@nx-go/nx-go`, one root `go.mod`. No e2e coverage yet (needs Go on the CI machine) —
  see "Known Invariants" and the Go section of `packages/cli/README.md`.
- **Flutter**: three kinds (`flutter-app`, `flutter-lib`, `flutter-internal-lib`) via
  a new first-party plugin, `@mnci/nx-flutter`, built on **Dart pub workspaces** —
  one root `pubspec.yaml`, so internal deps resolve with a plain version constraint
  and no `path:`. Web-only builds; git-tag-only publishing (no pub registry on
  Azure Artifacts). Has real e2e coverage, gated to run only when the Flutter SDK
  is present (`SKIPPED` otherwise) — the pattern Go should eventually adopt.
- **`GitHub Releases` changelogs**: on `--ci=github`-only workspaces, `nx release`
  now posts a per-project changelog (from conventional commits) to a GitHub
  Release instead of writing an unpushable `CHANGELOG.md`. `--ci=azure`/`both`
  are unchanged.
- **Four pre-existing bugs fixed**, found while building the above:
  1. `go-lib` had no per-project manifest, so Nx's default `versionActions`
     aborted the whole release graph — fixed by excluding `type:go-lib` from
     `release.projects` (see the Go section above).
  2. The e2e suite crashed partway through on a removed `--linter oxlint` flag,
     so everything after it (Python, and now Go/Flutter) had never actually run.
  3. The e2e's oxlint/oxfmt assertions described a stack mnci can no longer
     produce; rewritten for ESLint + Prettier.
  4. A fresh `vitest`-stack `npm-lib` failed `npm run lint` out of the box —
     `@nx/dependency-checks` flagged the generated `*.spec.ts`/`vitest.config.*`
     imports. Fixed via `ignoredFiles` in `add/npmLib.ts`.

### Stack Simplification

- **Removed oxlint entirely** — was an alternative linter, but:
  - Not essential (ESLint + Prettier handles the same job)
  - Reduced configuration surface
  - Simpler for users to understand
- **Unified on ESLint + Prettier** everywhere
  - ESLint for code quality (correctness, not style)
  - Prettier for all formatting (JavaScript Standard Style)
- **Stack now has one choice**: test runner (`jest` / `vitest`), not linter

### VS Code Workspace File

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

### "Files mnci owns" Philosophy

`applyOverlay()` writes a small, fixed set of config files; Nx owns everything else:

1. `nx.json` (release, sync, generators, mnci metadata)
2. `package.json` (curated root scripts only — name, scripts, the dual TS compiler deps,
   the ESLint toolchain)
3. `.npmrc` (comment-only — see the deferral below)
4. `.prettierrc.json` + `.prettierignore` (formatting)
5. `eslint.config.mjs` (three lines importing `@mnci/eslint-config`)
6. `commitlint.config.mjs` + `.husky/commit-msg` (conventional-commit enforcement)
7. `<workspace-name>.code-workspace` (VS Code configuration)
8. CI pipeline file(s) (`azure-pipelines.yml` and/or `.github/workflows/ci.yml`)
9. `.github/dependabot.yml` (`--ci=github|both` only)

Everything else — source, tests, `project.json` targets — is auto-generated by delegating
to Nx generators. There are **no** per-project ESLint configs: every `@nx/*` generator
writes one, and `removeGeneratedEslintConfig()` (`add/shared.ts`) deletes it after every
`add`, so the config cannot re-fragment as a workspace grows.

### ESLint: one config, in a package

The linting opinion is `@mnci/eslint-config` — a real package with no build step,
whose plugins are its own dependencies rather than a dozen devDependencies in every
generated workspace. An upgrade therefore reaches existing workspaces through
`npm update`, and the config is independently testable (it is, against the real `eslint`
binary).

Two things about it are load-bearing and easy to undo by accident:

- **`eslint-config-prettier` is composed LAST**, then the stylistic block after it.
  That block holds only rules Prettier never touches (`spaced-comment`,
  `lines-between-class-members`, `unicode-bom`).
- **`space-before-function-paren` must stay off.** Standard's signature rule, and the
  obvious thing to add back — but `eslint-config-prettier` disables it because it
  _conflicts_ with Prettier, not because it is redundant. Prettier rewrites
  `function f (a)` to `function f(a)` on every run, so enabling it makes `npm run lint`
  and `npm run format:check` mutually unsatisfiable. A regression test asserts it is off.

### `.npmrc` is deliberately empty

It carries comments only. The old file claimed, in `packages/cli/README.md`, that scope
routing made accidental public publishes impossible — it never emitted a
`@scope:registry` line at all, so that was simply false. Rather than ship half-wired
auth, publish authentication is an explicit deferral: the CI token export stays in place
so wiring it later is one line, and the generated `.npmrc` says so in a comment.

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

- [`ROADMAP.md`](ROADMAP.md) — open work: known gaps, planned kinds, and the
  invariants that are documented but not yet enforced
- [`packages/cli/README.md`](packages/cli/README.md) — detailed CLI & workflow docs
- [`packages/nx-python-pip/README.md`](packages/nx-python-pip/README.md) — Python plugin reference
- [`packages/nx-flutter/README.md`](packages/nx-flutter/README.md) — Flutter plugin reference
- [`packages/cli/src/overlay.ts:1–100`](packages/cli/src/overlay.ts) — config constants & VSCode workspace template
