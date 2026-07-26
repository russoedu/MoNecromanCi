# MoNecromanCI (`mnci`) — Reference for AI Tools

> **Purpose of this file.** A single, self-contained, factual description of what
> this project is, what it generates, and what must not be broken — written so an
> AI assistant can work on it (or on a workspace it generated) without guessing.
>
> **Everything here was verified against the code at commit `b4de5fa`**, not
> copied from other docs. Where the older docs are wrong, this file says so.

---

## 1. What this project is

`mnci` is a CLI that scaffolds and maintains **opinionated Nx monorepos**. It is
deliberately **thin**: it delegates project generation to official/first-party
generators and owns only a small set of root config files.

Two principles drive every design decision:

1. **Thin layer over Nx.** Prefer an existing generator over hand-written
   templates. When no usable plugin exists, build a real Nx plugin (this has
   happened twice — Python and Flutter) rather than hand-rolling files in the CLI.
2. **Conventional commits drive releases.** `nx release` versions, tags and
   publishes from git history. Nothing is ever committed back to `main` — the
   model is **tag-only** (`git.commit: false`).

This repository is itself an Nx monorepo, **built and maintained by the CLI it
ships** (dogfooded).

### Repository layout

```
packages/
├── cli/              # @mnci/cli — the binary (mnci new / add / upgrade)
├── nx-python-pip/    # @mnci/nx-python-pip — Nx plugin, pip-native Python
└── nx-flutter/       # @mnci/nx-flutter — Nx plugin, Flutter/Dart pub workspaces
libs/                 # empty (.gitkeep only)
tsconfig.base.json    # shared TS config
```

`nx show projects` → `@mnci/cli`, `@mnci/nx-python-pip`, `@mnci/nx-flutter`,
`@mnci/source` (the root).

---

## 2. The three commands

```
mnci new [name]      Create a monorepo (Nx TS preset + the mnci overlay)
mnci add [kind] [name]  Add a project by delegating to a generator
mnci upgrade         Re-apply the latest overlay to an existing workspace
```

Running `mnci` bare enters an interactive wizard.

### `mnci new` flags

| Flag                                              | Values / meaning                                       |
| ------------------------------------------------- | ------------------------------------------------------ |
| `-y, --yes`                                       | accept defaults for anything not passed                |
| `--scope <scope>`                                 | npm scope for publishable packages (e.g. `@demo`)      |
| `--registry <kind>`                               | `azure-artifacts` \| `npm`                             |
| `--organization`, `--project`, `--artifacts-feed` | Azure DevOps coordinates                               |
| `--agent <pool>`                                  | a vmImage (`ubuntu-latest`) or a self-hosted pool name |
| `--variable-group <name>`                         | Azure DevOps variable group holding the PAT            |
| `--ci <provider>`                                 | `azure` (default) \| `github` \| `both`                |
| `--test-runner <runner>`                          | `jest` (default) \| `vitest`                           |
| `--nx-cloud`                                      | opt in to Nx Cloud (off by default)                    |

### `mnci add` flags

| Flag              | Applies to                                                       |
| ----------------- | ---------------------------------------------------------------- |
| `--scope <scope>` | publishable npm libs (defaults to `@<workspace name>`)           |
| `--framework <f>` | **`node-app` only**: `express \| fastify \| koa \| nest \| none` |
| `--lib <name>`    | **`python-vendor` only**: the `libs/<name>` to vendor            |

### `mnci upgrade`

Re-runs the exact same `applyOverlay()` that `new` uses, so a fix to the overlay
reaches already-generated workspaces. It reads its defaults back from the `mnci`
block in `nx.json`; any flag passed overrides **and is re-persisted**. It touches
only mnci-owned files — never project source or `project.json` targets.

---

## 3. The 17 project kinds

`mnci add <kind> <name>`. The kind list is the union type `ProjectKind` in
`packages/cli/src/commands/add.ts`; `PROJECT_KINDS` drives both the CLI
`choices()` validation and the interactive picker.

| Kind                   | Lands in                 | Generator                               | Targets written                           |
| ---------------------- | ------------------------ | --------------------------------------- | ----------------------------------------- |
| `react-app`            | `apps/<name>`            | `@nx/react` (Vite)                      | lint, test, build (dev/uat/prod), package |
| `node-app`             | `apps/<name>`            | `@nx/node` (esbuild)                    | lint, test, build, package                |
| `node-function-app`    | `apps/<name>`            | `@nx/node` + Azure Functions v4 overlay | lint, test, build, package                |
| `npm-lib`              | `packages/<name>`        | `@nx/js:lib --bundler=rollup`           | lint, test, build, publish                |
| `internal-lib`         | `libs/<name>`            | `@nx/js:lib` (private)                  | lint, test, build                         |
| `python-app`           | `apps/<name>`            | `@mnci/nx-python-pip:application`       | lint, test, build, package                |
| `python-function-app`  | `apps/<name>`            | `…:function-application`                | lint, test, package                       |
| `python-lib`           | `python-packages/<name>` | `…:library`                             | lint, test, build, `nx-release-publish`   |
| `python-internal-lib`  | `libs/<name>`            | `…:internal-library`                    | lint, test                                |
| `python-vendor`        | _(edits a manifest)_     | none — see below                        | —                                         |
| `go-app`               | `apps/<name>`            | `@nx-go/nx-go:application`              | build, test, lint, package                |
| `go-function-app`      | `apps/<name>`            | `@nx-go/nx-go:application`              | build, test, lint, package                |
| `go-lib`               | `packages/<name>`        | `@nx-go/nx-go:library`                  | test, lint                                |
| `go-internal-lib`      | `libs/<name>`            | `@nx-go/nx-go:library`                  | test, lint                                |
| `flutter-app`          | `apps/<name>`            | `@mnci/nx-flutter:application`          | lint, test, build (web), package          |
| `flutter-lib`          | `packages/<name>`        | `@mnci/nx-flutter:library`              | lint, test                                |
| `flutter-internal-lib` | `libs/<name>`            | `@mnci/nx-flutter:internal-library`     | lint, test                                |

**How the directory is chosen differs by stack, and both are intentional:**

- **Python:** the CLI passes an explicit `--directory=…`, which is why
  `python-lib` lands in `python-packages/` even though the plugin's own default
  for `library` is `libs/`.
- **Flutter:** the CLI passes no `--directory`, so the plugin's defaults apply
  (`apps/`, `packages/`, `libs/`).

**Adding an 18th kind** requires touching, at minimum: the `ProjectKind` union,
`PROJECT_KINDS`, the module import, and a `switch` case in `add.ts`. A missing
`switch` case is a **compile-time error** (`const exhaustive: never`), so it
cannot be half-done silently. Also update the "Next steps" hint in `new.ts`.

---

## 4. The dependency model — the single most important concept

Every stack uses **one central root manifest**. Projects consume it; nothing
maintains per-project dependency islands.

| Stack   | Root manifest                           | How a project consumes it                 | CI dependency injection                                          |
| ------- | --------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------- |
| TS/JS   | `package.json` + `package-lock.json`    | npm workspaces + TS project refs          | `npm ci`                                                         |
| Python  | `requirements-dev.txt` (toolchain only) | per-project `pyproject.toml`              | 2 guards: toolchain install, then `pip install -e` every project |
| Go      | **one root `go.mod`**                   | plain import path, `<module>/libs/<name>` | `go mod download`                                                |
| Flutter | **root `pubspec.yaml` (pub workspace)** | `resolution: workspace` in each member    | **one** `flutter pub get` at the root                            |

### Why Flutter is the cleanest case

A Dart pub workspace means one root `pubspec.yaml` listing every project, and
`resolution: workspace` in each member. A single `flutter pub get` at the root
then resolves **internal and external dependencies together** into **one**
`pubspec.lock` and **one** `.dart_tool/package_config.json` — pub actively
deletes any per-package copies it finds.

The consequence that matters day to day:

```yaml
# packages/shared/pubspec.yaml
dependencies:
  core: ^0.0.1 # ← resolves to libs/core. NO `path:` needed.
```

_Verified empirically:_ the depended-on package returns **404 on pub.dev**, so
resolution could only have been local.

This is also why **Flutter needs no vendoring step**. Contrast Python below.

### Why `python-vendor` exists (and has no equivalent elsewhere)

Plain pip has no bundled-local-dependency feature. A publishable wheel cannot
depend on an unpublished workspace lib, so the internal lib's module must be
**physically copied into the consumer's wheel at build time**.

`mnci add python-vendor <consumer> --lib <internal-lib>` writes a
`[tool.mnci-python-pip] vendor = [...]` entry into the consumer's
`pyproject.toml`; the plugin's `build` executor stages and copies the module. It
is idempotent and refuses self-vendoring.

- **Go** needs none: `go build` links statically, and one module means siblings
  are plain subpackages.
- **Flutter** needs none: pub workspaces resolve members locally.

---

## 5. Layout convention = release scoping

| Directory          | Contents                                         | Released?                        |
| ------------------ | ------------------------------------------------ | -------------------------------- |
| `apps/`            | every app kind                                   | **Never** — packed into the drop |
| `packages/`        | publishable npm libs, Go packages, Dart packages | Yes, except `go-lib`             |
| `python-packages/` | publishable Python packages                      | Yes — `twine upload`             |
| `libs/`            | internal libs (TS/Python/Go/Dart)                | **Never**                        |

Shipped `release.projects`:

```js
projects: ['packages/*', 'python-packages/*', '!tag:type:go-lib']
```

**`!tag:type:go-lib` is a bug fix, not tuning.** A `go-lib` lives in `packages/`
but has **no per-project manifest** (mnci puts every Go project in one root
`go.mod`), so Nx's default `versionActions` looks for a `package.json` that is
not there and **aborts while building the release graph** — which kills
`nx release` for the _entire_ workspace, not just the Go project.

_Verified A/B against a real `@nx-go/nx-go:library`:_ without the exclusion
`EXIT=1`; with it `EXIT=0` and the npm lib releases normally.

Excluding is also semantically right: one root `go.mod` means **one module**, so
its packages have no independent versions. `go get <module>/packages/<x>@vX.Y.Z`
resolves against the _module's_ tag.

A **Dart** package in `packages/` needs no such exclusion — `pubspec.yaml` has a
real `version:` field and `@mnci/nx-flutter` stamps a `versionActions` override.

---

## 6. The release model

```js
projectsRelationship: 'independent',
releaseTag: { pattern: '{projectName}@{version}' },
git: { commit: false, tag: true, push: <github-only> },
version: { conventionalCommits: true, fallbackCurrentVersionResolver: 'disk' },
```

- **Tag-only.** Nothing is committed to `main`. Future runs resolve versions from
  tag names.
- **One flat project list, not named `release.groups`.** Nx hard-errors the whole
  release when any explicit group matches zero projects — a real failure for a
  workspace with Python but no npm packages, or vice versa.
- **Per-project `versionActions` overrides** are what let heterogeneous manifests
  coexist: npm's default (`package.json`), `@mnci/nx-python-pip`'s
  (`pyproject.toml`), `@mnci/nx-flutter`'s (`pubspec.yaml`).
- **Changelogs:** files are off everywhere (unpushable under tag-only). On
  `--ci=github` **only**, Nx generates a changelog from conventional commits and
  posts it to a **GitHub Release** (`createRelease: 'github'`, `file: false`).
  That provider also sets `git.push: true`, because Nx refuses `createRelease`
  with push disabled. `azure`/`both` keep the pipeline's own explicit tag push,
  since a `GITHUB_TOKEN` is not guaranteed there.

---

## 7. The generated CI pipeline

Both providers are kept in **lockstep** and are asserted byte-identical by an
anti-drift test in `overlay.test.ts`. Only PATH-publishing differs, because the
mechanisms genuinely differ (`##vso[task.prependpath]` vs `$GITHUB_PATH`).

Step order (Azure; GitHub is the same minus "Attach HEAD" and the per-app build
tags, which have no Actions equivalent):

```
 1 checkout (persistCredentials, fetchDepth 0)
 2 Attach HEAD to the source branch          (azure only)
 3 Fetch branches and release tags
 4 Set the git identity used for release tags
 5 UseNode@1 / setup-node    ← the ONLY toolchain task
 6 npm ci
 7 npm audit                                  (non-blocking)
 8 Install Python dependencies                (guard)
 9 Install Python project dependencies        (guard) ← Python dep injection
10 pip-audit                                  (non-blocking)
11 Download Go module dependencies            (guard) ← Go dep injection
12 Install golangci-lint                      (guard)
13 Add Go tool bin to PATH                    (guard)
14 Install the Flutter SDK (3.44.8)           (guard)
15 Add the Flutter SDK to PATH                (guard)
16 Resolve Dart dependencies                  (guard) ← Flutter dep injection
17 npx nx sync:check
18 npm run lint
19 npx nx run-many -t lint,test,build
20 Pack all apps → dist/drop                  (main only)
21 Publish the drop artifact                  (main only)
22 Tag the run per app                        (main only, azure)
23 Release — version, tag and publish         (main only)
24 Push release tags                          (main only, non-github)
```

### Guard scripts — how conditional steps work

Every stack-specific step is a **single-line `node -e "…"`**, chosen because it
runs byte-identically under `cmd.exe` and POSIX `sh` (no bash, no PowerShell).
The pattern is always: check a sentinel → `console.log('No X - skipping.')` and
`process.exit(0)` (a **clean zero exit**, so the step is green, not skipped).

| Stack   | Sentinel file          | Written by                 |
| ------- | ---------------------- | -------------------------- |
| Python  | `requirements-dev.txt` | first `mnci add python-*`  |
| Go      | `go.mod`               | first `mnci add go-*`      |
| Flutter | `pubspec.yaml`         | first `mnci add flutter-*` |

**Critical architectural fact:** `applyOverlay()` has **no knowledge** of which
stacks a workspace uses, and cannot — `mnci new` runs before any `mnci add`. So
every stack step is emitted **unconditionally** and self-guards at runtime.
Gating at generation time would mean `mnci add flutter-app` produced a pipeline
with no Flutter steps until the user re-ran `mnci upgrade`.

### Toolchain assumptions

- **Node** is the only toolchain the pipeline _installs via a task_.
- **Python and Go** are assumed present — they ship on every hosted agent image.
- **Flutter is the exception**: it is **not** on hosted agents, so the pipeline
  installs it itself, by shallow `git clone` at a pinned tag (Flutter's own
  documented method, and the only one uniform across agents — release archives
  differ by platform).

**The SDK is cloned OUTSIDE the workspace**, to `~/.mnci-flutter-<version>`.
This is not cosmetic: the Flutter SDK ships **dozens of its own nested
`pubspec.yaml` files**, which inside the tree would pollute pub's resolution and
give Nx thousands of extra files to glob.

---

## 8. The two first-party Nx plugins

Both exist for the same reason: no maintained, Nx-23-compatible option exists.

### `@mnci/nx-python-pip`

pip-native Python — **no uv, no Poetry, no lock file**. Ruff + pytest + the PyPA
`build`/`twine` frontends.

- Generators: `application`, `library`, `internal-library`, `function-application`
- Executors: `build` (PyPA build, with vendoring), `test` (pytest), `lint`
  (Ruff), `publish` (twine)
- Exports `PythonVersionActions` (reads/writes `pyproject.toml`'s version line)

### `@mnci/nx-flutter`

Flutter/Dart on **Dart pub workspaces**.

- Generators: `application`, `library`, `internal-library` — each delegates
  scaffolding to the **official `flutter create`**, run from a
  `GeneratorCallback` (it writes to the real FS, not the Nx `Tree`).
  `--platforms=web` keeps output lean: only `web/` is scaffolded.
- Executors: `build` (`flutter build web`), `test`, `lint`
  (`flutter analyze --fatal-infos`)
- Exports `DartVersionActions` (reads/writes `pubspec.yaml`'s `version:`)
- Writes the root `pubspec.yaml` + `analysis_options.yaml` on first add
  (idempotent — user edits survive), and registers each project under
  `workspace:`

**`--fatal-infos` is pinned even though it is already the default.** Verified
against 3.44.8: `--help` reports "defaults to on", and `--no-fatal-infos` turns a
failing lint run green. It is passed anyway because that default is the only
thing making this a real gate — nearly every `flutter_lints` rule reports at
_info_ severity. Note plain `dart analyze` defaults the **opposite** way (fails
on errors/warnings but not infos), so swapping the command without carrying the
flag would silently stop enforcing anything.

**Third-party risk note:** `@nx-go/nx-go` declares `@nx/devkit ">= 20 < 23"`
while this workspace runs Nx 23. That range is a plain dependency, not a peer, so
npm nests its own devkit copy and everything works — validated empirically. Still
worth re-checking on Nx upgrades.

---

## 9. Files `mnci` owns

`applyOverlay()` is the single writer. It is **deterministic** (same input →
same output) and is what both `new` and `upgrade` call.

```
nx.json                    (release, sync, generators, and the `mnci` block)
package.json               (curated root scripts only)
.npmrc
.prettierrc.json + .prettierignore
commitlint.config.mjs
.husky/commit-msg
<workspace-name>.code-workspace  (VS Code multi-root workspace, extensions, settings)
azure-pipelines.yml        (--ci=azure|both)
.github/workflows/ci.yml   (--ci=github|both)
.github/dependabot.yml     (--ci=github|both)
```

Everything else — project source, `project.json` targets, ESLint configs — is
owned by Nx generators or the user.

**`mnci` does NOT write a root ESLint config.** `create-nx-workspace` and the Nx
generators own that. The one exception is the **per-npm-lib** `eslint.config.mjs`
(`NPM_LIB_ESLINT_CONFIG` in `add/npmLib.ts`), which adds `@nx/dependency-checks`
exclusions — see §11.

### Root scripts

| Script                    | Runs                               |
| ------------------------- | ---------------------------------- |
| `build` / `lint` / `test` | `nx run-many -t <target>`          |
| `affected`                | `nx affected -t lint,test,build`   |
| `graph`                   | `nx graph`                         |
| `release:preview`         | `nx release --dry-run`             |
| `format` / `format:check` | `prettier --write .` / `--check .` |
| `python:install`          | the same two Python guards CI runs |
| `prepare`                 | `husky`                            |

### The `mnci` block in `nx.json`

Persists `scope`, `registry`, `agent`, `variableGroup`, `ci`, and
`stack.testRunner`. Two independent readers depend on it: `mnci add` reads
`.stack`; `mnci upgrade` reads the whole thing as its defaults.

**Stack-specific state is NOT stored here.** It lives in the sentinel files
(`go.mod`, `requirements-dev.txt`, `pubspec.yaml`). Adding a stack should not
touch this block.

---

## 9b. Where the logic lives (start here before editing)

| I need to change…                                              | Go to                                           |
| -------------------------------------------------------------- | ----------------------------------------------- |
| A CLI flag or command                                          | `packages/cli/src/cli.ts`                       |
| The kind list / dispatch                                       | `packages/cli/src/commands/add.ts`              |
| How one kind generates                                         | `packages/cli/src/commands/add/<stack>.ts`      |
| Shared add helpers (`AddOptions`, `ensureAdmZip`, `hasPlugin`) | `packages/cli/src/commands/add/shared.ts`       |
| Workspace creation                                             | `packages/cli/src/commands/new.ts`              |
| **Anything mnci writes into a workspace**                      | `packages/cli/src/overlay.ts`                   |
| CI YAML, guard scripts, release config                         | `packages/cli/src/overlay.ts`                   |
| Interactive prompts                                            | `packages/cli/src/prompts.ts`                   |
| Shell execution (cross-spawn wrappers)                         | `packages/cli/src/nx.ts`                        |
| Name validation                                                | `packages/cli/src/util/names.ts`                |
| Python generation/executors                                    | `packages/nx-python-pip/src/`                   |
| Flutter generation/executors                                   | `packages/nx-flutter/src/`                      |
| Pub workspace wiring                                           | `packages/nx-flutter/src/internal/workspace.ts` |
| E2E                                                            | `packages/cli/e2e/cli.e2e.mjs`                  |

`overlay.ts` is the highest-leverage and highest-risk file: it is the sole writer
of every generated workspace's config, and both `new` and `upgrade` call it.

### Common task recipes

- **Add a project kind** → §3's checklist, then a `add/<kind>.test.ts` mirroring
  `go.test.ts`, then docs. If it needs a toolchain, add guards in `overlay.ts`
  (both providers) keyed on a sentinel file.
- **Change a CI step** → edit the guard constant _and_ both `azurePipelinesYaml()`
  and `githubActionsYaml()`; the anti-drift test will fail otherwise.
- **Debug a generated workspace** → generate one into a temp dir with the built
  CLI (`node packages/cli/dist/cli.js new demo --yes --registry npm --scope @demo`)
  rather than reasoning about the templates.
- **Verify a guard actually works** → extract the emitted `node -e` string from
  the generated YAML and _run it_ in a fixture directory. Asserting on the string
  alone has hidden real bugs here.

---

## 10. Verification — how to check this project works

```bash
npm run build                    # all three packages
npm run test                     # 311 tests total
npm run lint                     # ESLint (quality) — Prettier is separate
npm run format:check             # Prettier
npx nx sync:check                # TS project references
npx nx run-many -t lint,test,build   # everything at once
```

Expected: **311 unit tests** — 221 (`cli`), 50 (`nx-flutter`), 40
(`nx-python-pip`). `packages/cli` enforces an **85% coverage threshold** on
statements/branches/functions/lines; the two plugins have no threshold.

### The e2e suite

```bash
node packages/cli/e2e/cli.e2e.mjs      # ~15-30 min, real network
```

It runs the **built** CLI for real: `mnci new` (real `create-nx-workspace`, real
npm installs), `mnci add` for each kind, then real `nx run-many -t lint,test,build`
and a real `nx release --dry-run` inside the generated repo. Expected result:
**115 enforced checks, exit 0, zero skips** (with the Flutter SDK on `PATH`).

**Toolchain gating.** The Flutter section is the _only_ skippable one: the SDK is
not on a stock machine or CI image, so it runs when `flutter` is present and
reports **SKIPPED** loudly when not. Nothing else is skippable.

In CI the e2e is **`workflow_dispatch`-only** on `windows-latest` (it is slow);
the default PR job does not run it.

---

## 11. Invariants — do not break these

1. **`applyOverlay()` is deterministic.** Same input → same output, always.
2. **`mnci upgrade` overwrites only mnci-owned files.** Never project source.
3. **All shell commands use `cross-spawn`** with the `(command, args[])` array
   form — never string concatenation with `shell: true`. Every argument can come
   from user input; the old design let a crafted name run arbitrary shell.
4. **Go uses a SINGLE root `go.mod`.** Never reintroduce `go.work` — one stale
   `use` entry makes `go list -m -json` fail, which breaks the **entire** Nx
   project graph, not just Go.
5. **Go targets are written explicitly.** `@nx-go/nx-go`'s inference needs a
   per-project `go.mod`, which the single-module layout does not have.
6. **Flutter members need BOTH** `resolution: workspace` _and_ an entry in the
   root `workspace:` list. Miss either and pub silently resolves that project
   standalone — it gets its own lockfile and drops out of shared resolution. The
   failure is quiet, which is why generators write both.
7. **A publishable `flutter-lib` must keep its `versionActions` override.**
   Without it `nx release` fails for the whole workspace (same failure mode as
   the `go-lib` exclusion).
8. **Never clone the Flutter SDK inside the workspace** (§7).
9. **CI guard changes must be mirrored in both providers.** The anti-drift test
   asserts the guard bodies are byte-identical.
10. **Build outputs must be DIRECTORIES, not bare files.** Nx scans each declared
    `outputs` entry to cache it; scanning a file raises `ENOTDIR`. This bit Go
    (`go build` writes a bare file, so mnci builds one level deeper) and is why
    `flutter build web --output` is safe (it writes a directory natively).
11. **Drop-zip basenames are a contract.** They are exactly `<kind>-<name>.zip`
    (react is `<kind>-<name>-<env>.zip`), because Azure derives each per-app build
    tag from the zip filename — so the tag can never drift from the artifact.
12. **The npm-lib ESLint config must exclude the test toolchain** from
    `@nx/dependency-checks`. rollup bundles from the entry point only, so
    `vitest.config.*` and `*.spec.*` never reach the published package. Without
    this, a **vitest** workspace fails `npm run lint` on a freshly generated
    npm-lib. (`.spec` only — matching an unused `.test` glob drags an
    `eslint-disable` into the generated file, which a consuming workspace can flag
    as an unused directive.)
13. **Adding a package requires `npx nx sync`** and committing the resulting
    `tsconfig.json` change, or `nx sync:check` fails in CI.

---

## 12. Known gaps and corrections to older docs

**Corrections — the older docs are wrong about these:**

- `CLAUDE.md` used to reference `e2e/boxout.e2e.mjs` and a `libs/monecromanci-v2`
  layout. **Neither exists.** The real e2e is `packages/cli/e2e/cli.e2e.mjs`.
- The CLI's published `description` advertised **oxlint/oxfmt**, which were
  removed. The stack has exactly **one** knob now: the test runner. Linting is
  always ESLint (quality) + Prettier (formatting).
- The task list marked "Implement Flutter support" **completed long before any
  code existed**. Treat task-list completion claims as unreliable; verify against
  the code.

**Real gaps:**

- **Go has no e2e coverage.** It has real unit tests and real CI wiring, but the
  e2e never drives it, because it needs Go on the machine. The skip mechanism
  built for Flutter would work here but has not been applied.
- **Flutter apps build for web only.** Android needs the Android SDK + NDK on
  every agent; iOS is impossible on Linux. Add platforms per-app with
  `flutter create --platforms=…`.
- **No lock file for Python** — plain pip has none, matching the company standard
  this was built for. `requirements-dev.txt` is unpinned.
- **Function-app deployment is not wired** into the pipeline; the drop zip is the
  deploy input.
- **Azure Artifacts has no pub/Dart feed type**, so `flutter-lib` and `go-lib`
  publish **by git tag only** — there is no registry upload step for either.

---

## 13. Working on this repo — practical notes

- **Run `npm run format` before committing.** Nx generators emit
  semicolons/double-quotes; Prettier normalises to JavaScript Standard Style
  (no semicolons, single quotes, 2-space).
- **Commits are linted** by commitlint via a husky `commit-msg` hook. Use
  conventional commits — they drive versioning.
- **TSDoc is enforced by ESLint** on source files: `@param`, `@returns`,
  `@throws`, `@typeParam` are required, including `@param None -` for
  zero-argument functions. Keep code spans on one line — a backtick pair split
  across lines is a TSDoc syntax error.
- **The plugins compile against the `es2021` lib**, so `Array#toSorted` is
  unavailable in their production source (it is fine in `*.spec.ts`, which use a
  different tsconfig).
- **`git diff` before pushing.** Review what an overlay change actually touches.
- **When something is claimed to work, verify it empirically.** This project's
  history contains several claims that did not survive contact with a real run —
  the dead e2e, the phantom Flutter implementation, the `go-lib` release break.
