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
.npmrc                    # publish auth (azure also routes @scope to the feed)
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
- **`packages/cli/src/commands/doctor.ts`** — read-only invariant check (`mnci doctor`); exits non-zero on any finding, and every finding names its remedy

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
npm run typecheck      # tsc across the workspace (bundlers do not type-check)
npm run affected       # lint + typecheck + test + build for changed projects only
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

### JSX Accessibility, Vitest Globals, and Comments in `tsconfig.json` (Latest)

Roadmap #19b, #19c and #19e — the rest of `@mnci/eslint-config`'s coverage gaps
except #19d (import-graph rules).

- **`eslint-plugin-jsx-a11y` (`recommended`) now covers every `.jsx`/`.tsx`.** There
  were two React kinds and **zero** a11y rules touching JSX:
  `@html-eslint/require-img-alt` applies to `**/*.html` only, so an `<img>` in a
  component was checked by nothing. Verified on a real generated workspace, because
  the risk was `recommended` failing a fresh `react-app` — Nx's `NxWelcome` is a
  large slab of markup. It lints clean out of the box, and planted violations report
  `alt-text`, `anchor-is-valid`, `click-events-have-key-events` and
  `no-static-element-interactions`. This also corrects the docs' "HTML + a11y"
  claim, which held for `.html` and not for JSX.
- **Vitest's `vi`/`vitest` globals are declared**, and `vitest.*` config files join
  the `jest.*` entry. Narrow — the vitest stack generates `.ts` specs and `no-undef`
  is off for TS — but `vi.fn()` in a `.js` spec really did report `'vi' is not
defined`.
- **`jsonc/no-comments` is now explicitly off for the JSONC family**, and the reason
  is worth remembering: `tsconfig*.json` was **already** listed as JSONC, yet a
  commented one still failed. Those files also match `**/*.json`, whose block enables
  the rule, and the JSONC preset only _omits_ it rather than setting `'off'` — so in
  flat config the earlier `'error'` wins. Spreading a preset does not undo an earlier
  block; only an explicit `'off'` does. `.vscode/*.json` joined the same block.
- Both new rule blocks were mutation-tested, and the JSON relaxation is tested in
  both directions so it cannot quietly loosen real `.json` files.

### Two Plugins Had a Fake `typecheck` Target

Nx **disables** an inferred `typecheck` target when a project's tsconfig sets
`noEmit: true`, replacing the command with an `echo` that exits 0.
`@mnci/nx-flutter` and `@mnci/nx-python-pip` both set it, so their typecheck passed
by printing a message — #18's gate was theatre for two of four projects, both
published.

- **Fixed with the pattern `@mnci/cli` already used**: a `tsconfig.typecheck.json`
  plus a `typecheck` package script, rather than touching the build. `noEmit: true`
  and the contradictory `emitDeclarationOnly: true` are gone from the base tsconfig
  — `tsconfig.lib.json` overrode both, so they were dead config that only set the
  trap.
- **Turning the gate on found real pre-existing errors**, which is the proof it
  mattered: `tsconfig.lib.json` excludes `*.spec.ts`, so every spec in both plugins
  was type-checked by nothing. `toSorted`/`Object.hasOwn` against `lib: es2021`, and
  five stale `as unknown as Buffer` casts (now
  `as unknown as ReturnType<typeof readFileSync>`, so they track `@types/node`).
- **The newer `lib` is in `tsconfig.typecheck.json` only, never the base.** Bumping
  the base to `es2023` was tried and **changed published output** — class property
  initializers become native class fields, a `[[Set]]` → `[[Define]]` change in a
  class that `extends` Nx's `VersionActions`. Confined to the typecheck config,
  `dist/` is byte-identical (verified by diffing). Never raise `target`/`lib` in
  these packages' base tsconfig for the sake of a spec file.
- **Verified by planting a type error, watching typecheck fail, removing it** — the
  only verification that means anything here, since a green typecheck was the
  symptom.
- **No `mnci doctor` check**, deliberately: the trap cannot occur in a generated
  workspace (neither mnci nor any `@nx/*` generator writes `noEmit` — checked), and
  doctor's bar is invariants that have actually been violated somewhere it runs.
  Still missing: an automated guard that a `typecheck` target is not a stub. CI
  cannot catch this class by running the target, because the stub passes.

### Type-Aware Lint Rules in `@mnci/eslint-config`

`configs/typeAware.js` adds the rules that read **types** — most importantly
`no-floating-promises`, which catches a dropped `await` that `tsc`, Prettier and
every other rule are silent about. The blocker recorded in `configs/typescript.js`
("a generated monorepo cannot know its tsconfigs up front") was obsolete:
`projectService: true` discovers each file's tsconfig itself.

- **Curated, not `recommendedTypeChecked`.** That preset reported 67 problems on
  this repo, mostly not bugs — `require-await` fires on every `nx-python-pip`
  executor, which must be `async` to satisfy Nx's contract. The curated set
  reported 10, all real, including a genuine floating promise in `cli.ts`.
- **Scoped to `{apps,libs,packages}/*/src/**`, and that is a safety decision.** A
  `.ts` file in no tsconfig is a **fatal parse error**, which suppresses every
  other rule for that file _and_ fails the build. Applying the rules workspace-wide
  made four of this package's own tests report `FATAL`. `allowDefaultProject` is
  fatal in the other direction too (`*.config.ts` broke `packages/cli/tsup.config.ts`),
  so scoping to directories guaranteed to have a tsconfig is the only choice that
  cannot misfire. Widen it only with that guarantee.
- **`no-misused-promises` sets `checksVoidReturn: { attributes: false }`.** A
  freshly generated `react-app` with `onClick={async () => { await save() }}` — the
  universal React idiom — failed `npm run lint` on a file the user wrote normally.
  Found by generating a real workspace and adding a real react-app. Only that
  sub-check is off; `Array.filter(async …)` still errors, and a test pins each half
  so relaxing the rule wholesale cannot pass.
- **Verified on a real generated workspace**, not just fixtures: green out of the
  box across `npm-lib`, `internal-lib` and `react-app`, and a planted floating
  promise reported in **both** `packages/*/src` and `libs/*/src`. Both new
  assertions were mutation-tested in both directions.
- **Found a separate P1 while doing this** (ROADMAP #20): `nx-flutter` and
  `nx-python-pip` have a `typecheck` target Nx has **disabled** because their
  tsconfigs set `noEmit: true` — it passes by printing a message. So #18's
  `typecheck` gate is theatre for two of four projects. Deliberately not fixed here
  (it changes two published packages' emit config), but recorded rather than left
  for someone to rediscover.

### Generated CI Verifies Affected Projects on a PR, Everything Otherwise

Both providers now share one verify step (`AFFECTED_OR_ALL_GUARD` in `overlay.ts`),
byte-identical between them and asserted so by the anti-drift test — which matters
more for this guard than the others, since the two providers detect a pull request
through **different** environment variables (`GITHUB_BASE_REF` vs
`SYSTEM_PULLREQUEST_TARGETBRANCH`), so a provider-specific copy would change _what
CI verifies_ rather than only how it is spelled.

- **Every fallback path verifies everything, never nothing.** A missing target ref,
  an unresolvable merge-base, any non-PR run → full `run-many`. Getting the base
  too wide costs minutes; too narrow means CI runs almost nothing, reports green,
  and has verified nothing. `main` therefore needs no special case — neither
  provider sets a PR target branch on a push, so a release run always verifies in
  full as a consequence of the fallback rather than a second condition.
- **`git merge-base`, not `nrwl/nx-set-shas`** (GitHub-only): one mechanism for both
  providers, correct in each by construction. Azure's `refs/heads/` prefix is
  stripped, since Azure sends a full ref where GitHub sends a bare name.
- **The standalone `npm run lint` step is gone** — it was `nx run-many -t lint`, a
  strict subset of the verify target list, and on an affected-scoped PR it would
  have re-linted every project. `format:check` deliberately stays workspace-wide:
  `prettier --check .` is one invocation over the tree, not a per-project target.
- **Verified by executing the guard, not by reading it.** Six tests run the real
  emitted command against a real git repo with a stub `npx` on PATH recording which
  Nx command it chose (not-a-PR, GitHub PR, Azure's full ref resolving to the _same_
  base, unresolvable branch, exit-status propagation, and surviving YAML parsing
  unchanged in both providers). Both branches were mutation-tested to confirm the
  tests fail when the guard breaks. Affected _selection_ was checked separately on a
  real workspace: changing a depended-on internal lib marks it and its consumer.
  This is the practice `mnci-details.md` §9 already prescribes for guards.

### One Root ESLint Config, One Prettier Config, in Generated Workspaces

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
3. `.npmrc` (publish auth; the azure variant also routes `@scope` to the feed)
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
`overlay.test.ts` asserted the line's absence. **Do not reintroduce a protection the
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
