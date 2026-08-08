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
├── eslint-config/        # @mnci/eslint-config — the shared ESLint + Prettier config
├── oxlint-config/        # @mnci/oxlint-config — the same opinion on oxlint + oxfmt
├── nx-python-pip/        # @mnci/nx-python-pip — Nx plugin for pip-native Python projects
└── nx-flutter/           # @mnci/nx-flutter — Nx plugin for Flutter/Dart pub workspaces

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
.prettierrc.mjs           # re-exports @mnci/eslint-config/prettier (JavaScript Standard Style)
.prettierignore           # paths Prettier skips
commitlint.config.mjs     # Conventional commit enforcement (via husky hook)
.husky/commit-msg         # commitlint hook
.npmrc                    # publish auth (azure also routes @scope to the feed)
<workspace-name>.code-workspace  # single-file VS Code workspace (folders, extensions, settings)
.devcontainer/devcontainer.json   # Node/Python/Go/Flutter toolchain matching CI
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

- **`packages/cli/src/overlay.test.ts`** — comprehensive overlay fixture tests (330+ assertions), including six that execute the CI verify guard against a real git repo

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
- **`packages/cli/e2e/cli.e2e.mjs`** — real generation → lint/test/build/package for all kinds (JS, Python, **Go**, Flutter). Gated as an Nx `e2e` target, and only run in CI by a `workflow_dispatch`-only Windows job (it takes ~25-30 min). Go and Flutter are each gated on their toolchain and reported as **SKIPPED** when absent — never silently dropped, which is exactly how Go went uncovered for so long.
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

## Current State & Recent Changes

Ordered newest first. The "(Latest)" tag marks the most recent entry only — older
entries describe how the project got here, not what's newest.

### The e2e Now Installs Go's Linter and the Flutter SDK (Latest)

`@mnci/nx-flutter` is a first-party, published plugin that had **never once been
exercised in CI**, and the reason was not a missing test — the tests exist. Every
run reported `⊘ SKIPPED the entire Flutter section` and `⊘ SKIPPED the go lint
assertion`, because the `e2e-windows` job provisioned nothing beyond Node.

- **The `ci` job's guards could not be reused, and copying them would have looked
  like a fix.** Every Go and Flutter guard begins with `existsSync('go.mod')` /
  `existsSync('pubspec.yaml')` **against the working directory**. The e2e job's
  working directory is this repo, which has neither — the suite generates its
  workspaces in a temp directory and drives them from there. So the gated guards
  would skip every time. The e2e job needs **unconditional** provisioning, and a
  test now asserts these steps contain no marker check.
- **`continue-on-error` on every provisioning step, deliberately.** An SDK
  download is a network operation on someone else's infrastructure. The e2e
  already reports an absent toolchain as a loud `SKIPPED` in its final report, so
  a flaky clone degrades to exactly today's behaviour instead of reddening a
  nightly for something that is not mnci's fault — and it cannot degrade silently,
  because the report names every skip.
- **The hardcoded Flutter version is a drift risk, so it is guarded rather than
  introduced and forgotten.** The workflow must hardcode `3.44.8` (the generator
  emits no e2e job at all), so a test asserts it equals `FLUTTER_SDK_VERSION`.
  Bumping the constant fails the suite until the workflow follows.
- All three assertions were mutation-tested: re-adding a `pubspec.yaml` marker
  check fails, bumping `FLUTTER_SDK_VERSION` fails, and dropping
  `continue-on-error` fails.
- **Still unproven: the Flutter section itself.** These steps make it _run_; what
  it reports on Windows is unknown, because it has never run. Expect the first
  nightly after this to be informative rather than green, and read it as new
  coverage rather than a regression.

### npm audit Now Blocks on an Actionable Advisory

`npm audit` reported **9 vulnerabilities (8 high, 1 moderate)** on this repo. All
9 are fixed, and the gate that should have caught them was already there — doing
nothing useful.

- **The step existed and was warn-only, on a justification that had inverted.**
  `NPM_AUDIT_STEP` was `npm audit --audit-level=high || echo …`, documented as
  non-blocking because "every flagged vulnerability traced back to `nx`'s and
  `verdaccio`'s own bundled transitive dependencies … nothing an edit to _this_
  workspace's manifest could fix". Measured now: **9 of 9 had `fixAvailable`**,
  and every one was fixed by a targeted `overrides` entry — exactly the edit that
  note called impossible. Same shape as the stale `js-yaml` pin below: a decision
  resting on a measurement nothing re-checks.
- **The split is actionable vs not, which npm reports per advisory
  (`fixAvailable`) rather than a severity guess.** A published fix at moderate or
  above exits 1; anything upstream has not fixed is printed and passes. That
  keeps the whole of the original concern — going red for something nobody here
  can fix only teaches people to ignore the gate — while removing the part that
  was false.
- **`--omit=dev` would have reported 0.** Measured on the pre-fix tree: every one
  of the 9 arrived through a devDependency (verdaccio, ts-jest's istanbul chain,
  `eslint-plugin-tsdoc`, commitlint, Vite). Auditing production only would have
  been another gate that verifies nothing.
- **The threshold is `moderate`, not `high`**, because `--audit-level=high` missed
  the `postcss` advisory outright — moderate, and fixable.
- **A broken audit does not fail the build.** Unparseable JSON exits 0 with the
  reason printed; a gate that cannot read its input should say so.
- **`pip-audit` deliberately stays report-only**, and the asymmetry is now
  documented as a limitation rather than a preference: its output carries no
  `fixAvailable` equivalent, so the actionable line cannot be drawn. Do not
  "align" the two by making it blocking — that trades a weak gate for a false one.
- **A stale pin was the concrete find.** `overrides["@verdaccio/config"]["js-yaml"]`
  was already `^4.3.0` — a fix for this same advisory, whose range upstream later
  extended to _include_ 4.3.0. It read as fixed and was not. `@istanbuljs/load-nyc-config`
  needed a separate 3.x pin, since 4.x dropped `safeLoad`.
- **This repo's own `ci.yml` never had the step at all**, which is why nothing
  reported the 9 — and it was missing **seven** guards, not one: pip-audit, all
  three Go steps and all three Flutter steps. Regenerating wholesale is wrong,
  since the file legitimately carries `workflow_dispatch`, the nightly
  `schedule`, a whole `e2e-windows` job and `checkout@v7`, none of which
  `overlay.ts` emits (a generated workspace has no e2e suite) — a blind
  regeneration would delete the nightly.
- **`pipelineDrift.test.ts` now guards the class**, one-directionally: every
  `run:` command the generator emits for the `ci` job must be present here.
  Extras are fine, and comparing only `run:` (never `uses:`) is what lets
  Dependabot bump action versions without tripping it. **There is deliberately no
  exemption table** — all seven missing guards were added rather than excused,
  since each begins with an existence check and no-ops without the toolchain, so
  a Go or Python project landing here is covered on day one. A table of seven
  "harmless" exemptions is precisely how the audit step stayed missing.
  Mutation-tested both ways: deleting the audit step fails it, and so does
  deleting the nightly `schedule` (the wrong way to "fix" drift).
- **Verified by execution against two real dependency trees**, not by reading the
  guard: the fixed tree exits 0, the pre-fix tree exits 1 listing all nine. Eight
  unit tests drive the branches with a stub `npm` on PATH — the pattern the verify
  guard established — including the mixed report where an unactionable finding
  must not shield an actionable one.

### The oxlint Path's First Real e2e Run, and Three Failures

The Windows e2e had never once driven `mnci new --linter=oxlint`. Its first run
failed three assertions, all in the `alt` section, and none of them was a flaky
test — each was a defect that reached real generated workspaces.

- **`runPrettier()` was hardcoded, and ran in oxlint workspaces too.** This is
  the worst of the three because it fails _silently_: an oxlint workspace has no
  `.prettierrc.mjs` (the overlay deletes it), so `npx prettier --write .` does
  not error — it formats the whole workspace against **Prettier's own defaults**,
  semicolons and double quotes, the exact inverse of the shared opinion, over
  files mnci had just written correctly. `oxfmt --check` then reported **19 files
  unformatted in a freshly generated workspace**, `eslint.config.mjs` and
  `oxlint.config.ts` among them. Now `runFormatter(cwd, linter, target)`.
- **`readWorkspaceStack()` never read `linter` at all**, so `mnci add` had no way
  to know — the same mis-formatting on every add, and `WorkspaceStack` had no
  such field to pass. It defaults to `eslint` when absent, the call `upgrade`
  already documents, since a pre-choice workspace has no persisted value.
- **`@mnci/oxlint-config` was STRICTER than ESLint on `.tsx`**, which is the one
  thing the parity contract forbids. `mnci/react` switches
  `explicit-function-return-type` **off** — a component's return type is always
  inferred JSX — and this config's React block was derived by diffing only the
  rules that block turns ON, so the single `'off'` was missed. A fresh
  `mnci add react-app` failed `npm run lint` on Nx's own `app.tsx` and
  `nx-welcome.tsx`, files the user had never opened.
- **Enumerating the class found a second instance nobody had hit**: the `.d.ts`
  blocks. A declaration file matches `**/*.{ts,mts,cts,tsx}`, so `no-explicit-any`,
  `consistent-type-imports`, the promise rules and `unbound-method` all stayed on
  where ESLint takes them off. `configs/declarations.js` mirrors it. A generated
  workspace has no `.d.ts`, so this would have waited for the first user to add a
  vendor declaration.
- **The derivation method was the bug, so the guard is a property, not a
  fixture.** `tests/parity.spec.ts` now resolves both configs and asserts that
  every rule an ESLint block disables _after_ something enabled it is disabled in
  a matching oxlint scope. It found a third entry on the first run —
  `no-irregular-whitespace` for `*.yaml` — which is a legitimate exemption, since
  oxlint has no YAML parser; that is encoded as a reachability property rather
  than a rule-name allowlist. Both real gaps were mutation-tested (reverting
  either fails 3 and 7 tests respectively).
- Verified against the actual failing shape, not fixtures alone: a real `app.tsx`,
  a real `nx-welcome.tsx` and a plain `.ts`, where oxlint reported **3 errors
  before and 1 after** — the survivor being the plain `.ts`, so the rule was not
  switched off wholesale.

### The CLI Offers a Linter Choice

`mnci new --linter=eslint|oxlint`, also a prompt and an `mnci upgrade` override,
persisted in `nx.json`'s `mnci` block. Default stays `eslint`, so nothing changes
for an existing workspace or a flagless run.

- **The oxlint option is a HYBRID, and calling it a swap would be a lie about what
  the workspace gets.** oxlint parses JS/TS/JSX/Vue and nothing else, so a pure
  swap would leave a duplicate key in a CI pipeline, a malformed `pyproject.toml`
  and a publishable package's wrong manifest all reported by nothing.
  `@mnci/eslint-config`'s new `nonJs()` export keeps YAML/TOML/MD/CSS/HTML/JSON and
  `@nx/dependency-checks`, composed from the same block modules `mnci()` uses so
  the two modes cannot drift.
- **`rootLintTarget()` is what actually runs oxlint, and the first pass forgot it.**
  Every per-project `lint` target comes from `@nx/eslint/plugin` and runs ESLint
  alone, so an oxlint workspace had a valid `oxlint.config.ts`, a green
  `npm run lint`, and never invoked oxlint once. Found while writing the e2e
  assertion that would have "passed" — the gate-that-verifies-nothing class again.
  oxlint sweeps the WHOLE workspace (no `--ignore-pattern` scoping) precisely
  because no per-project target covers it.
- **Switching modes deletes the mode you left** — config files _and_ the
  formatter's `devDependencies` entry. Two formatter configs is the `.prettierrc`
  precedence bug in a new costume: both files valid, CLI picks one, editor picks
  the other, gates disagree silently.
- **Format-on-save was broken for `.ts`, and it was mnci's fault.** The
  `.code-workspace` set a global `editor.defaultFormatter` plus `[json]`/`[jsonc]`/
  `[yaml]` only. VS Code resolves a language-specific setting ahead of a general
  one and does so BEFORE scope, so any user-level `[typescript]` block outranked
  it. Reported from a real workspace where `.json` formatted and `.ts` did not.
  `FORMATTED_LANGUAGES` pins them all.
- **Generated workspaces never declared `prettier`** — it arrived only as a
  transitive dependency of `@mnci/eslint-config`, so `npx prettier` worked while
  the VS Code extension, which resolves prettier from the PROJECT's dependencies
  and silently falls back to its bundled copy, could get a different one. `oxfmt`
  and `oxlint` are declared for the same reason.
- **Additive for the linter, EXCLUSIVE for the formatter**, and the asymmetry is
  the correction to the first pass, which declared `prettier` unconditionally —
  so an oxlint workspace declared a formatter nothing ran. The justification
  inverts under oxlint: the declaration exists so `esbenp.prettier-vscode`
  resolves the _project's_ prettier, and that extension is not even recommended
  there, so declaring it is precisely what lets a globally installed copy
  reformat on save against the opinion oxfmt is not applying — with `format:check`
  (oxfmt) then reporting the result as unformatted. prettier stays in
  `node_modules` regardless (`@mnci/eslint-config` depends on it), so **this is
  about the declaration, not about pruning the tree**. Two mechanisms enforce it,
  and mutation testing is what showed the split: the write-site ternary covers
  `mnci new`, `withoutStaleLinterDependencies()` covers `mnci upgrade`, and only
  the prune can fix a manifest that already declares it. `mnci doctor` checks it.
- **`FORMATTED_LANGUAGES` claimed to be "everything the formatter handles" and
  had never been checked against the binaries.** Measuring both found `html`
  missing from a list that had always been able to include it, and `toml`
  formattable by oxfmt alone — `prettier` on a `.toml` exits with `No parser
could be inferred for file`. So `[toml]` is pinned under **oxlint only**
  (`OXFMT_ONLY_LANGUAGES`); pinning it under eslint would route the file to a
  formatter that errors on it. An oxlint workspace therefore gets a formatted
  `pyproject.toml`, closing the gap `configs/toml.js` documents as unenforceable
  — and nothing re-opens the rule that block rejected, since no linter has an
  opinion on the file either way.
- **The two `mnci doctor` linter checks shipped with no tests at all**, found while
  adding the third. All three are covered now, including the default-to-`eslint`
  path every pre-choice workspace takes, plus a latent crash the tests exposed:
  both checks read `package.json` through `readJson`, which _throws_ on a missing
  file, so doctor would have died on the kind of broken workspace it exists to
  diagnose. `declaredDevDependencies()` reads it tolerantly instead.
- **`oxc.oxc-vscode` is one extension covering oxlint AND oxfmt** (verified on the
  Marketplace), so an oxlint workspace needs no formatter extension —
  and `dbaeumer.vscode-eslint` stays in BOTH lists, because the hybrid still lints
  YAML there.
- **The e2e's `alt` workspace is now the oxlint half of the matrix**, pairing with
  `demo` (jest + eslint) instead of adding a third workspace and another ~8 minutes
  of real installs.

### A Second Linting Package: `@mnci/oxlint-config`

The same lint and style opinion on the Rust toolchain — oxlint + oxfmt — as an
alternative to `@mnci/eslint-config`, not a replacement. **Not yet wired into the
CLI**; that is the next conversation. This reverses the earlier "removed oxlint
entirely" decision, deliberately and on request.

- **The contract is directional, and that is what makes it testable.** Anything
  `@mnci/eslint-config` accepts must pass oxlint. The config may be more
  _permissive_ — it unavoidably is — but never _stricter_, because that is the case
  where a green codebase starts failing on files nobody touched. Verified the
  strongest way available: **0 findings across this whole ESLint-clean monorepo**.
- **Literal rule parity is impossible, and the numbers are stated rather than
  glossed.** Of the 452 rules the ESLint config enables for a project `.ts`, oxlint
  implements 206; **246 do not exist in it** (169 `unicorn`, 56 `regexp`, plus a
  tail). oxlint also parses only JS/TS/JSX/Vue, so YAML, TOML, Markdown, CSS, HTML
  and JSON are linted by nothing here — measured, not assumed: `eslint-plugin-yml`
  loads through the bridge and then exposes no rules, and oxlint would not parse a
  `.yaml` even if it did.
- **225 of the 246 are closed with oxlint's `jsPlugins`**, which runs _real_ ESLint
  plugins. So `unicorn` and `regexp` here are not ports — they are the same
  packages at the same versions the ESLint config uses. oxlint's own partial
  `unicorn` is switched off so one defect is never reported twice.
- **Three wrong turns, each found by measurement and each recorded in the file it
  affects.** (1) `categories: { correctness: 'error' }` was measured clean on this
  repo — but with oxlint's _default_ plugins; once `import`/`jest`/`vitest`/`react`
  were enabled it reported 8 findings on ESLint-clean source. (2) `categories: {}`
  changed nothing, because the plugins are what enable rules, which is why
  `configs/leaks.js` disables 111 of them. (3) TypeScript rules applied
  workspace-wide made `typescript/no-require-imports` fire on a `.cjs` file the
  ESLint config lints clean, so they are TS-scoped like the ESLint block they
  mirror.
- **Two genuine divergences, off with evidence** in `configs/divergences.js`. The
  worrying one is `unicorn/no-array-sort`: an _option_ (`allowExpressionStatement`)
  that ESLint honours and the alpha bridge appears not to — a rule stricter than
  configured everywhere it runs, not just in one file.
- **A fixture that asserted the opposite of the truth was caught and removed.** The
  minimal repro written for `consistent-function-scoping` is reported by _both_
  linters, so as a "clean" fixture it was simply wrong. The divergence only appears
  on the real 400-line module. **A fake fixture is worse than no fixture.**
- **oxfmt replaces Prettier, verified rather than assumed**: byte-identical on
  JSON/YAML/MD/CSS/TS samples and on 60 of 61 real files, diverging only on how a
  multi-line union after `as` wraps. A test diffs the two binaries and asserts the
  option set `toEqual` the ESLint package's, so the two halves cannot drift.
  **The speed claim was later restated at the right scale**: 46ms against ~1.5s is
  a _single file_; checking this whole monorepo is 2.3s against 14.6s, about 6x.
  Quote the whole-repo number — it is the one a contributor waits on.
- **#24's guard earned its keep again**: it failed the moment the package appeared,
  because a new project had no `build` target and no recorded reason.

### `@mnci/eslint-config` Owns Prettier, and Every Block Has a Name

The package held the whole linting opinion while the formatting opinion was a literal
in `overlay.ts` — two halves of one decision, in two places, reachable by two different
upgrade paths (`npm update` for one, `mnci upgrade` for the other). And the cost of
having moved the rules into a package had gone unpaid: a three-line root config gives no
hint that twenty tools are behind it.

- **`prettier.js` is the new source of truth**, exported as
  `@mnci/eslint-config/prettier`, with `prettier` moved into the package's own
  dependencies so a workspace need not declare a formatter to be formatted correctly.
  Generated workspaces get a `.prettierrc.mjs` that re-exports it, and `.prettierrc.json`
  joins the files `applyOverlay()` **deletes** — mnci used to write that name, and it
  outranks `.mjs`, so an upgrade that left it behind would do nothing at all.
- **The 86-file reformat was a drift this uncovered, not a style change.** This repo's
  `.prettierrc.json` said `trailingComma: "es5"` while the `PRETTIER_CONFIG` it ships
  says `"none"`. Nothing reported it, because the check and the shipped opinion were
  different files. `tests/prettier.spec.ts` pins every option now, through the real
  binary, loading the config **by its bare specifier** via a node_modules symlink — the
  spelling is the subject, since a missing `exports` entry resolves fine in-repo and
  fails only once published.
- **Every one of the 29 resolved blocks now has a unique `name`.** ESLint 9 added it and
  `eslint --inspect-config` reports it, so it is the only handle a user has on "which
  block turned this on". `configs/named.js` covers the presets that ship anonymous
  (`eslint-plugin-yml`, `eslint-plugin-toml`, `eslint-config-prettier`) while keeping any
  name upstream does provide — `typescript-eslint/recommended` stays itself. Asserted as
  a property, not a list: a new block without a name fails.
- **The generated config now carries the inventory and the override recipe**, and the
  inventory is checked against the real config in both directions. Mutation-tested both
  ways: renaming `mnci/import-graph` fails, and dropping `mnci/css` from the table fails.
- The one override that cannot work — `space-before-function-paren` — is stated in the
  generated file itself, where someone would try it, rather than only in a README.

**Verified by running the emitted files, not by reading them.** A probe workspace got
the real `ESLINT_CONFIG` and `PRETTIER_CONFIG` output plus a node_modules symlink to the
package: the config parses with its comment block intact and resolves **29 blocks, 0
unnamed**; a real `.ts` lints clean; Prettier resolves through `.prettierrc.mjs` and
applies Standard (`"double";` → `'double'`, and `function f (a)` → `function f(a)`,
which is the `space-before-function-paren` conflict demonstrating itself); and the
override recipe **copied verbatim out of the generated comment** silences
`no-explicit-any` for one directory. What that still does not cover is
`create-nx-workspace` itself — a full `mnci new` + `mnci add react-app` remains the
stronger check, and is what the e2e does.

### Generated Workspaces Ship a Devcontainer

ROADMAP #11. The toolchain matrix is Node + Python + Go + Flutter, and only **CI** had
all four: the pipeline installs the Flutter SDK and assumes CPython and Go on the
agent, while locally a contributor was on their own.

- **`NODE_VERSION` is now one constant** feeding both the workflow's `setup-node` and
  the container's base image. Hardcoding it twice is the drift the file exists to
  remove, and a test fails if the image tag stops reading it.
- **`postCreateCommand` reuses the pipeline's own guards** — `npm ci`, the
  `python:install` root script, then the same `golangci-lint` and Flutter SDK
  one-liners CI runs. All are idempotent and no-op without a `go.mod`/`pubspec.yaml`,
  so a JS-only workspace pays almost nothing. A third copy would be the thing that
  drifts, so there isn't one.
- **Python and Go are devcontainer features; Flutter cannot be** — no maintained one
  exists, the same reason `@mnci/nx-flutter` was written — so the SDK comes from the
  pinned clone, matching CI by construction. A Dockerfile was rejected as a second
  thing to maintain against upstream.
- The VS Code extension list became a shared constant, so the `.code-workspace` file
  and the container cannot recommend different toolsets.
- **The limit is stated rather than glossed: the container was never built.** This
  environment has the Docker client but no daemon. What _was_ verified: all three
  registry refs resolve, the JSON parses, a real generated workspace gets the file,
  and that workspace's own `format:check` and root `lint` accept it — the latter only
  because #28's root lint target, shipped one change earlier, is what covers
  `.devcontainer/` at all. Booting it once on a machine with Docker is the check this
  still deserves.

### The e2e No Longer Cascades on One Failure

ROADMAP #21's structural half, which closes #21. `run()` throws and the e2e was one
linear file, so a crash anywhere silently removed all coverage below it — which had
happened twice, and is how the suite once reported nothing at all about Go because
_Python's_ toolchain could not install.

- **A `section(label, needs, body)` helper wraps five blocks**: `js stack`,
  `alt stack`, `python`, `go`, `flutter`. A section that throws is recorded and the
  run continues; a section whose prerequisite failed is **skipped**, so its assertions
  do not become a wall of failures all tracing to one cause. Skipping is transitive.
- **A crashed section is `enforce`d, not `skip`ped** — the run still exits non-zero.
  The goal was never to tolerate the failure, only to stop it being a silent one.
- **The roadmap's own sizing was wrong, and measuring beat estimating.** It predicted
  "94 top-level bindings, many crossing section boundaries". Exactly **one** does:
  `altWorkspace`, which `python` and `go` both drive. ESLint's `no-undef` proved it —
  wrapping reported 93 references to that one name and nothing else — so the hoist is
  one line. Reach for static analysis before assuming a refactor is large.
- **Validated by injecting failures into real runs**, one per half: a `throw` atop
  `js stack` was recorded and the run still generated the alt workspace, asserted
  against it, and entered `python`; throws atop _both_ early sections made `python`
  and `go` report `⊘ SKIPPED … its prerequisite section "alt stack" failed`, with the
  report printed and exit 1 carrying exactly the two crashes. Before the change the
  first throw alone produced no report at all.
- Go's and Flutter's toolchain gates are deliberately a _different_ mechanism: absent
  tooling is `SKIPPED` and does not fail the run; a crash is a failure that is
  reported.

### Root-Level Files Now Have a Lint Target

ROADMAP #28, found by #24's guard: `npm run lint` is `nx run-many -t lint`, and every
`lint` target belongs to a package and runs `eslint .` in its own directory. Nothing
ran ESLint at the workspace root, so `.github/workflows`, root JSON/Markdown and the
root config files were covered by no target at all.

- **Fixed with an explicit `lint` target on the root project**, scoped by **CLI**
  ignore patterns (`--ignore-pattern "packages/**"` and friends) rather than config
  `ignores`. That distinction is load-bearing: flat-config `ignores` are relative to
  the config file, and every package's `lint` resolves that same root config, so
  ignoring `packages/**` there would have switched linting off _inside_ the packages.
- 19 files, zero problems, and none of the 158 inside packages are re-linted.
- **Proven to gate**: a planted `var` in a root `.mjs` fails `@mnci/source:lint`.
  #24's `ABSENT_BY_DESIGN` entry for it is gone, so the stub guard now covers it too.
- **It ships to generated workspaces too**, via `ROOT_LINT_TARGET` in `overlay.ts`,
  written alongside `includedScripts: []` — load-bearing, since the root scripts are
  the `nx run-many` aggregators and inferring targets from them would make `lint`
  invoke `nx run-many -t lint`, itself. Merged, not replaced, so a workspace's own
  root targets survive an upgrade.
- **It nearly did not ship, on a measurement that was wrong.** The first pass reported
  46 errors in a generated workspace, 45 in `.agents/`, `.github/skills/` and
  `.opencode/` — read as Nx's agent scaffolding. They are not: `SANDBOX_INJECTED` in
  `cli.e2e.mjs` names those three directories as artifacts **this coding-agent sandbox
  injects into every cwd**, which is why the e2e deletes them before any
  whole-workspace assertion. **Measure workspace-wide claims outside the sandbox**, or
  subtract `SANDBOX_INJECTED` first.
- The real blocker was **one** rule: `unicorn/no-anonymous-default-export` on the root
  `jest.config.ts` Nx generates (`export default async () => ({ projects: … })`). It
  is now off for the `jest.*`/`vitest.*` config family, pinned in both directions so
  it cannot quietly go off for ordinary modules.
- **Verified on a real generated workspace**: target present, `nx run <scope>/source:lint`
  exits 0 out of the box, `npm run lint` runs it without recursing, and a planted `var`
  in the generated `commitlint.config.mjs` fails it. The e2e pins all four.

### The Stack Is on ESLint 10

ROADMAP #26, closed. ESLint **10.8.0**, `eslint-plugin-unicorn` **72**, `@eslint/js`
**10** — the content of Dependabot #86 and #83, both closed with reasons at the time.
Neither holdout survived measurement.

- **`jsx-a11y`'s peer cap was stale, not real.** Its latest release peers at
  `^3 … ^9`, so `npm install` ERESOLVEs on 10 — but with one override the plugin
  installs and its rules still fire. `ESLINT_PEER_OVERRIDES` in `overlay.ts` writes
  `"overrides": { "eslint-plugin-jsx-a11y": { "eslint": "$eslint" } }` into every
  generated root manifest, because **npm honours `overrides` only at the root**,
  which is why a config package cannot fix this for itself. Merged rather than
  replaced, so a workspace's own overrides survive `mnci upgrade`. State the trade
  when touching it: mnci deleted `legacy-peer-deps` for weakening dependency
  resolution, and this is the same kind of decision, only far narrower — remove it
  the moment jsx-a11y declares ESLint 10.
- **The bump surfaced 92 problems and zero defects.** The three rules
  `configs/base.js` predicted on v61 were the top three by count —
  `name-replacements` (35), `no-top-level-assignment-in-function` (19),
  `consistent-boolean-name` (13) — and the prediction was right about why. A fourth
  joins them: `no-incorrect-template-string-interpolation` (10) reads Nx's own
  `{workspaceRoot}` tokens as forgotten `${...}`, so it cannot be right about any
  code that writes Nx config.
- **The other 25 were fixed, not silenced** — the difference between adopting a rule
  and neutering it. One was a genuine defect: core ESLint 10's `no-useless-assignment`
  found a dead initialiser in `doctor.ts`.
- **`--fix` was run _after_ the four disables, deliberately.** The naming rules
  rewrite identifiers, so fixing first renames code that is about to stop being
  linted — a 350-line diff of pointless churn, which is exactly what happened on the
  first attempt before it was reverted.
- **Verified on a real generated workspace**: `npm install` succeeds on ESLint 10
  (the override's whole purpose), and the resolved tree is eslint 10.8.0 + unicorn 72
  - jsx-a11y 6.10.2.
- `mnci doctor`'s eslint-major check needed no code change — it derives from
  `ESLINT_VERSION`, so only its test fixtures moved.

### React Rules Now Come From `@eslint-react`

ROADMAP #26 step 2, taken first on purpose: it is the one step of the ESLint 10
upgrade that is independently useful and reversible, and isolating it keeps the
expensive real-react-app verification about React rather than about ESLint 10.

- **`eslint-plugin-react` is gone.** Its latest release peers on `eslint: ^3 … ^9.7`
  with no ESLint 10 build at all, so it — not ESLint — is what pinned this config to 9. `@eslint-react/eslint-plugin` is a maintained rewrite peering on `eslint: "*"`.
  Every rule it has no equivalent for is a class-component or `propTypes` rule; this
  project generates neither, and two of them were already switched off here.
- **`recommended-typescript`, and it needs no type services.** Only
  `recommended-type-checked` does, so this block carries none of `typeAware.js`'s
  scoping hazard, where a file outside a tsconfig becomes a fatal parse error. In
  5.18.1 `recommended` and `recommended-typescript` resolve to an identical rule set.
- **Hooks stay with the React team's plugin.** `@eslint-react` reimplements them and
  ships a config to switch `eslint-plugin-react-hooks` off in favour of its own; this
  config does the reverse and switches off the two `@eslint-react` rules that
  duplicate it, so one defect is never reported twice with two different messages.
  Its other hook-adjacent rules (`purity`, `set-state-in-effect`, `use-memo`) are new
  coverage and stay on. A test pins both halves, so flipping the pair cannot pass.
- **Verified on a real generated workspace with a real `react-app`**, not on fixtures
  — the exact step #107 skipped. `npm run lint` exits 0 on the fresh workspace, and a
  planted keyless list reports `@eslint-react/no-missing-key` as an error.
- **It found one new warning on a file the user never wrote**:
  `dom-no-dangerously-set-innerhtml` on Nx's `nx-welcome.tsx`. **Kept deliberately** —
  it is a `warning`, nothing sets `--max-warnings`, so lint still exits 0, unlike the
  react-lib rollup and `prefer-regex-literals` precedents which were hard failures.
  Switching off a security-relevant rule to quiet one piece of Nx boilerplate is the
  worse trade.

### `nx affected` Was Blind to Every Root Config File

ROADMAP #25, filed as "blind to `@mnci/eslint-config`". Measuring it showed the
problem was far wider: `nx affected` walks the **project graph**, and a root config
file lives in no project — so changing one marked only the root pseudo-project, which
has **no verify target at all**.

Measured one file at a time with `nx show projects --affected --uncommitted`:
`eslint.config.mjs`, `tsconfig.base.json` and the root `package.json` each marked
`@mnci/source` **and nothing else**, so the affected-scoped verify step on such a PR
ran nothing and reported green. `nx.json` and `package-lock.json` already marked
everything (Nx special-cases both).

- **Fixed by filling in `namedInputs.sharedGlobals`**, which the preset's `default`
  input already references and `production` extends — one list reaches every target.
- **The fix ships to users, not just this repo.** `SHARED_GLOBAL_INPUTS` and
  `withSharedGlobals()` in `overlay.ts` write the same three root files into every
  generated workspace's `nx.json`, and `mnci upgrade` back-fills existing ones. The
  merge is additive and idempotent, so a workspace's own entries survive.
- **This repo carries three entries the generated list cannot**:
  `packages/eslint-config/{package.json,index.js,configs/**/*.js}`. Here the lint
  config is a workspace member; in a generated workspace it is a registry dependency,
  so its changes arrive through `package-lock.json`, which Nx already tracks.
- **`.prettierrc.json` is deliberately absent.** Prettier is not a project target —
  `format:check` runs `prettier --check .` over the whole tree every run — so listing
  it would bust every cache and verify nothing new.
- **The e2e asserts it behaviourally**, touching each of the three files in a real
  generated workspace and requiring real projects to be marked; the nx.json entries
  alone would not catch Nx changing how `sharedGlobals` is consumed. Both unit
  assertions were mutation-tested.

### A Guard Against Verify Targets That Verify Nothing

ROADMAP #24, the loose end from #20 — closed as the _class_ rather than the two
instances. `packages/cli/src/verifyTargets.test.ts` reads the real Nx project graph,
resolves every verify target down to the shell command it ultimately runs, and fails
when that command is a no-op (`echo`, `:`, `true`, `exit 0`).

- **This is the only kind of check that can catch it.** Nx _disables_ an inferred
  target rather than dropping it: with `noEmit: true` in a tsconfig, `typecheck`
  survives in the graph with its command replaced by `echo "The 'typecheck' target
is disabled because …"`, so **running** it passes. CI is structurally blind to it.
- **The target list is read from the root `affected` script**, not duplicated, so the
  guard can never cover a narrower set than CI actually runs.
- **It follows `npm run <script> [-w <pkg>]`**, because most targets here are one hop
  from a `package.json` script — a `"typecheck": "echo skip"` hides in the script, not
  in the target, and is caught identically.
- **A missing target is the weaker gate, not the stronger one.** `nx run-many -t X`
  skips every project without an `X` and exits 0, so absence must be a recorded
  decision in `ABSENT_BY_DESIGN` with a reason. Mutation-tested in all three shapes:
  Nx's real stub, an `echo` script, and an unexplained absence.
- **Writing that exemption table found another live instance**, which is the argument
  for the rule. The reason drafted for `@mnci/eslint-config` having no `typecheck` —
  "ts-jest type-checks the specs as it runs" — is **false**: `tsconfig.base.json` sets
  `isolatedModules: true`, which puts ts-jest in transpile-only mode, so
  `const x: number = 'y'` in a spec passes jest. Its `tests/config.spec.ts` was
  type-checked by nothing. Fixed with #20's pattern (`tsconfig.typecheck.json` + a
  `typecheck` script), clean on the first run, and verified real by planting a type
  error. **No project is exempt from `typecheck` now** — and none should be, since a
  project's specs are type-checked only by that target's tsconfig.
- Also recorded, not fixed (ROADMAP #28): no `lint` target covers root-level files.
  Every `lint` target runs `eslint .` inside its own package, so `.github/workflows`,
  root JSON/Markdown and the root config files are linted by nothing. Measured —
  `eslint .` at the root is clean over 177 files — so it is a gate hole, not a bug.

### Regex and TOML Linting, and One Preset Measured and Rejected

The rest of ROADMAP #19e, which closes #19 entirely.

- **`eslint-plugin-regexp`** (`flat/recommended` minus four) for
  `no-super-linear-backtracking` — a regex that is correct but exponential on a
  crafted input. Three real findings here, all unused capturing groups.
- **The four exclusions are a crash, not taste.** `no-legacy-features`,
  `no-missing-g-flag`, `no-useless-dollar-replacements` and `no-useless-flag` reach
  for type information and **throw** when the TS parser has no type-aware services —
  normal for any `.ts` outside `{apps,libs,packages}/<name>/src`. A crash kills
  linting for the whole file. An isolated test of the preset passes, because in
  isolation there are no services to be missing; all four had to be found by
  iterating the real lint.
- **TOML is `flat/base`, parser only.** `flat/standard` reports **six**
  `array-bracket-spacing` errors on the `pyproject.toml` `nx-python-pip` itself
  generates — every Python workspace would have failed lint on a file the user never
  wrote. A test pins the real generated content as clean. TOML formatting is
  therefore unenforced: Prettier has no TOML support, and the alternative measured
  worse than nothing.
- **`eslint-plugin-n`'s fuller `recommended` set was rejected.** `no-missing-import`
  alone gave **189** false positives — the same unbuilt-`dist` problem that forced
  `no-unresolved` off in #19d — and a narrow subset's four findings were _all_
  legitimate patterns (a test runner exiting non-zero, shebangs on `node` scripts).
  Zero real bugs, so it fails the same "earns its keep" test three unicorn rules
  already fail. Recording a rejection matters as much as recording an addition.
- Verified on a real generated **Python** workspace: clean out of the box, a
  malformed `pyproject.toml` caught as a parse error. Both decisions mutation-tested.

### Release Steps Fired on Any Non-PR Event, and the e2e Now Runs Nightly

ROADMAP #22 and half of #21. Found while trying to add a nightly schedule for the
e2e: doing that to the workflow _as it stood_ would have started publishing packages
every night.

- **Every release-only step was gated on `event_name != 'pull_request' && ref_name
== 'main'`.** "Anything that is not a PR" also means _any trigger anyone adds
  later_. Generated workspaces were safe only **by construction** — their workflow
  has exactly two triggers — while mnci's own workflow was already exposed, having
  hand-added `workflow_dispatch` for the Windows e2e job: clicking _Run workflow_ to
  get that job also satisfied the release condition and would have run
  `nx release --yes`.
- **Fixed to the positive form** in both, `event_name == 'push' && ref_name ==
'main'`. Behaviour-identical for existing generated workspaces (provable — no third
  trigger exists), a real fix here. A test asserts the positive form is present _and_
  the negative one is gone, so it cannot come back; mutation-tested.
- **Azure is deliberately untouched.** `ne(Build.Reason, 'PullRequest')` has the same
  shape, and a manually queued run on `main` would satisfy it. The precise fix is
  `in(Build.Reason, 'IndividualCI', 'BatchedCI')`, but no Azure run has ever
  exercised this project's release path, and changing an untested release trigger to
  guard a hypothesis is the worse trade. Documented instead — decide it with evidence.
- **The e2e now also runs on a nightly `schedule`** (`0 3 * * *`), which is safe
  _because_ of the gating fix. It had been red since #92 — eight PRs — since a manual
  trigger was the only thing that ever ran it. Still open (#21): a failure in one e2e
  section destroys every later section, which is how one bad `pip install` reported
  nothing at all about Go or Flutter.

### Go Finally Has e2e Coverage

ROADMAP §6's oldest gap. All four Go kinds had real unit tests and real CI wiring,
but nothing had ever driven them end to end, so every Go invariant in these docs was
**documented and unverified**. The e2e now drives them, gated on the Go toolchain and
reported as `SKIPPED` when absent — the Flutter pattern, and the point of it: Go went
uncovered for so long precisely because it was silently _dropped_ rather than loudly
skipped.

What it enforces, each one an invariant that previously rested on documentation
alone: one root `go.mod` with **no** `go.work` and zero per-project manifests; every
target written explicitly (nothing is inferred in single-module mode, because
`@nx-go/nx-go`'s inference keys on a per-project `go.mod`); `go-app` having a `start`
target while `go-function-app` deliberately does not; a cross-project import
resolving with **no** vendoring or `replace` directive; real `go build`/`go test`;
`golangci-lint` rather than the plugin's `go fmt` default; a genuinely compiled
binary in `dist/drop/go-app-*.zip`; and `nx release` surviving a `go-lib`.

- **`golangci-lint` is gated separately from `go`.** Hosted CI images ship Go but
  not the linter (this repo's pipeline `go install`s it), so tying the whole section
  to it would skip the structural, build, test, package and release checks on most
  machines. Only the lint assertion is gated.
- **The release assertion needs a non-Go releasable package present**, which is why
  it lives in `altWorkspace` (it already has `npm-lib sdk`). Found while verifying:
  in a **Go-only** workspace `nx release` errors with "Release group `__default__`
  matches no projects", because `!tag:type:go-lib` empties the scope — a different
  failure entirely, which would have made the assertion prove nothing. The generated
  CI's release guard already skips that case correctly.
- The module path is **read from `go.mod`**, not hardcoded: it derives from the
  workspace scope, so hardcoding would make the section quietly wrong on a rename.

### Intra-Project Import Cycles, and Two Silent Failures

Roadmap #19d, which completes #19. `configs/importGraph.js` adds
`import-x/no-cycle` and `no-self-import`, scoped to project source — the
**intra-project** gap, since `@nx/enforce-module-boundaries` only sees edges
_between_ projects.

Three things here are load-bearing, and all three were found by running it:

- **`settings['import-x/parsers']` is what makes `no-cycle` work at all.**
  `languageOptions.parser` tells ESLint how to parse the file being linted; it says
  nothing about how import-x parses the files it _follows_. Without the mapping,
  every `.ts` dependency is unparseable, traversal stops at depth one, and the rule
  reports **nothing, ever** — enabled and inert. `no-unresolved` does _not_ need it,
  which is precisely why the gap is easy to miss: one rule works while the other is
  dead. `@typescript-eslint/parser` is an explicit dependency so this never relies
  on hoisting.
- **The Node resolver is unusable.** With import-x's default resolver this reported
  **179** errors on this repo, all false — Node cannot resolve an extensionless
  relative TypeScript import. `createTypeScriptImportResolver` gets **no `project`
  option**, so it discovers each file's nearest tsconfig itself, the same reason
  `projectService: true` works for the type-aware block.
- **`no-unresolved` is off, structurally rather than by preference.** A project
  consumes an internal lib by scoped name; npm workspaces symlinks it, but the
  manifest points at `./dist`, which does not exist until that dependency is
  **built** — and `lint` does not depend on `build`. The `ts` preset has no tsconfig
  `paths` either. Verified on a real generated workspace: a lib re-exporting
  `@scope/core` reported it unresolved, a false positive on the internal-lib feature
  central to the scaffold. Switched off explicitly with a test pinning it, so nobody
  re-enables it in good faith. `tsc` already covers unresolved _typed_ imports.

Verified on a real generated workspace after the change: cross-project import clean,
planted intra-project cycle reported. Both traps mutation-tested.

### JSX Accessibility, Vitest Globals, and Comments in `tsconfig.json`

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
  number. So: `eslint ^9.39` and `eslint-plugin-unicorn` pinned to `^61`, the
  last line supporting 9. Three unicorn rules this config would want off don't
  exist in v61 and so aren't listed — ESLint rejects a config naming a rule its
  plugin lacks. `configs/base.js` records which ones, for whoever upgrades next.
  The plugin that originally decided it, `eslint-plugin-react`, has since been
  replaced by `@eslint-react/eslint-plugin` (see the entry at the top of this
  section); what remains is `jsx-a11y`'s stale peer cap and unicorn 72's
  `>=10.4` floor, both written up in ROADMAP #26.
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

1. `nx.json` (release, sync, generators, `namedInputs.sharedGlobals`, mnci metadata)
2. `package.json` (curated root scripts only — name, scripts, the dual TS compiler deps,
   the ESLint toolchain)
3. `.npmrc` (publish auth; the azure variant also routes `@scope` to the feed)
4. `.prettierrc.mjs` (re-exports `@mnci/eslint-config/prettier`) + `.prettierignore`
5. `eslint.config.mjs` (one import from `@mnci/eslint-config`, plus the block inventory)
6. `commitlint.config.mjs` + `.husky/commit-msg` (conventional-commit enforcement)
7. `<workspace-name>.code-workspace` (VS Code configuration)
8. CI pipeline file(s) (`azure-pipelines.yml` and/or `.github/workflows/ci.yml`)
9. `.github/dependabot.yml` (`--ci=github|both` only)
10. `.devcontainer/devcontainer.json` (a local environment matching CI's toolchain)

Everything else — source, tests, `project.json` targets — is auto-generated by delegating
to Nx generators. There are **no** per-project ESLint configs: every `@nx/*` generator
writes one, and `removeGeneratedEslintConfig()` (`add/shared.ts`) deletes it after every
`add`, so the config cannot re-fragment as a workspace grows.

### ESLint _and_ Prettier: one opinion, in one package

`@mnci/eslint-config` is a real package with no build step, whose ~20 plugins are its
own dependencies rather than ~20 devDependencies in every generated workspace. An
upgrade therefore reaches existing workspaces through `npm update`, and the config is
independently testable (it is, against the real `eslint` and `prettier` binaries).

**It owns the formatting opinion too**, exported as `@mnci/eslint-config/prettier` and
consumed by a generated `.prettierrc.mjs` that re-exports it. Linting and formatting are
one decision — `eslint-config-prettier` is composed last precisely so every rule defers
to Prettier's settings — so splitting them across two packages creates a version pair
free to drift until `lint` and `format:check` contradict each other. Two consequences
worth remembering:

- **Precedence is a trap, and mnci has fallen into it twice.** Prettier resolves
  `.prettierrc` → `.prettierrc.json` → … → `.prettierrc.mjs`, so `applyOverlay()`
  deletes the first two: `.prettierrc` because `create-nx-workspace` writes it,
  `.prettierrc.json` because **mnci itself used to**. Leave either behind and the
  shared opinion is silently ignored.
- **`trailingComma` is `none`, not `es5`.** This repo's own `.prettierrc.json` said
  `es5` while `overlay.ts` shipped `none`, so mnci was formatted against an opinion it
  did not publish — 86 files' worth, reported by nothing. `tests/prettier.spec.ts` pins
  every option now by running the real binary.

**Every config block carries a `name`** (`mnci/base`, `mnci/react`,
`mnci/prettier-compat`, …), including ones spread from upstream presets that ship
anonymous — `configs/named.js` fills those in while keeping any name upstream provides.
The names are what `eslint --inspect-config` reports and what a user's override targets,
and they are the whole reason a three-line root config is navigable at all. The
generated `eslint.config.mjs` ships the same list as a comment plus an override recipe;
`ESLINT_BLOCK_INVENTORY` in `overlay.ts` holds it, and an `overlay.test.ts` test fails
in **both** directions if it and the real config disagree — a stale inventory points the
reader at a block that does not exist, and nothing about generating a workspace would
notice.

Two more things are load-bearing and easy to undo by accident:

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
