<p align="center">
  <img src="../../assets/logo.svg" alt="mnci" width="160">
</p>

# @mnci/cli

> A **thin CLI over what Nx already ships**: an opinionated one-command Nx
> monorepo with automatic commit-message versioning, instead of hand-rolling
> templates, configs and CI engines.

## The thesis

Most of what a monorepo tool needs to hand-roll — a template engine, a shared
config package, a custom CI engine, a dependency-injection step for published
packages, a doctor/drift-sync system to keep it all consistent — already has a
first-party (or established community) Nx equivalent:

| Hand-rolled elsewhere                      | This CLI uses instead                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------- |
| Template engine + per-project config files | `create-nx-workspace --preset=ts` + `nx g` plugin generators                  |
| A shared toolchain package for configs     | The configs the Nx generators emit (one root ESLint/tsconfig)                 |
| A custom multi-step CI engine              | `nx affected -t lint,typecheck,test,build` + `nx release` (~60-line pipeline) |
| A dist-package dependency injector         | `nx release` updates dependent versions natively                              |
| Hand-written Azure Function templates      | `@nx/node:application` (plain Node app) + a thin Azure Functions v4 overlay   |
| doctor/drift sync of tool-owned files      | Nothing to drift: this CLI owns 5 small files, Nx owns the rest               |

## Commands (deliberately just four)

```sh
mnci new my-repo            # create a monorepo (prompts scope + registry)
mnci new my-repo --yes --registry npm --scope @my
mnci new my-repo --yes --registry npm --scope @my --nx-cloud  # opt in to Nx Cloud

cd my-repo
mnci add react-app web         # @nx/react (Vite + Jest)
mnci add node-app svc          # @nx/node (plain Node app, esbuild)
mnci add node-app api --framework express  # ...or fastify | koa | nest
mnci add node-function-app api # @nx/node + an Azure Functions v4 overlay
mnci add npm-lib sdk           # @nx/js publishable lib -> packages/
mnci add internal-lib utils    # @nx/js private lib -> libs/
mnci add react-lib ui          # @nx/react publishable component lib -> packages/
mnci add react-internal-lib design  # @nx/react private component lib -> libs/

# Python (@mnci/nx-python-pip — pip + Ruff + pytest + PyPA build/twine, no uv)
mnci add python-app svc            # app -> apps/ (wheel, zipped into the drop)
mnci add python-function-app fn    # Azure Functions (Python v2) -> apps/
mnci add python-lib shared         # publishable -> python-packages/ (twine upload)
mnci add python-internal-lib core  # private shared lib -> libs/
mnci add python-vendor shared --lib core  # wire core's module into shared's built wheel

# Go (@nx-go/nx-go — one root go.mod, golangci-lint + go test)
mnci add go-app api            # executable -> apps/ (binary, zipped into the drop)
mnci add go-function-app fn    # serverless handler -> apps/
mnci add go-lib core           # publishable (by git tag) -> packages/
mnci add go-internal-lib util  # private shared package -> libs/

# Flutter (@mnci/nx-flutter — one root pubspec.yaml pub workspace, analyze + test)
mnci add flutter-app hello         # Flutter web app -> apps/ (bundle, zipped into the drop)
mnci add flutter-lib shared        # publishable (by git tag) -> packages/
mnci add flutter-internal-lib core # private shared package -> libs/

mnci upgrade                  # re-apply the latest overlay (see below)
mnci upgrade --agent windows-latest   # ...with an explicit override

mnci doctor                   # check this workspace's invariants (read-only)
```

## `mnci doctor`: checking the invariants actually hold

Read-only — it never edits the workspace. Every failing finding names the command
that fixes it (usually `mnci upgrade`), and it exits non-zero when anything failed,
so it works as a CI step as well as a local command.

Every check corresponds to an invariant that has **actually** been violated, in
this repo or in a workspace it generated. None are hypothetical; a check nobody has
ever needed is noise that trains people to ignore the output.

| Check                                                   | The failure it catches                                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Exactly one root ESLint config, and no per-project ones | The config fragmenting — every `@nx/*` generator writes one, so each project ends up linting against whichever config sits nearest |
| No stray `.prettierrc`                                  | It outranks `.prettierrc.json`, so the whole formatting opinion is silently discarded while both files look fine                   |
| `@nx/eslint/plugin` registered in `nx.json`             | Without it `npm run lint` exits 0 while linting nothing                                                                            |
| The **resolved** `eslint` major                         | A declared range and an installed version are different things — manifests once said `^10` while the pin said 9                    |
| `.npmrc` matches the recorded registry                  | The two registry kinds get different files; an Azure workspace also needs its scope routed                                         |
| `versionActions` on publishable Dart/Python packages    | Its absence aborts `nx release` for the **whole** workspace, not just that project                                                 |
| `nx sync:check`                                         | A stale TypeScript project reference that was never committed                                                                      |

Everything else is plain Nx, surfaced as a small curated set of root scripts —
each a single cross-platform command:

| Script                    | Runs                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`           | `nx run-many -t build`                                                                                                                |
| `npm run lint`            | `nx run-many -t lint`                                                                                                                 |
| `npm run test`            | `nx run-many -t test`                                                                                                                 |
| `npm run typecheck`       | `nx run-many -t typecheck` — its own script because a bundler-built project's `build` strips types without reading them               |
| `npm run affected`        | `nx affected -t lint,typecheck,test,build` (vs `main`)                                                                                |
| `npm run graph`           | `nx graph`                                                                                                                            |
| `npm run release:preview` | `nx release --dry-run`                                                                                                                |
| `npm run python:install`  | fixed Python toolchain (ruff/pytest/build/twine) + editable-install every Python project — the same two guards CI runs, for local dev |
| `prepare`                 | `husky` (commit-msg lint hook)                                                                                                        |

## Every `add` also wires local-dev commands

Every `mnci add` (and the inline `internal-lib` case) finishes by calling
`registerProjectCommands` (`commands/add/shared.ts`), which writes up to three
root `package.json` scripts for the project just added:

| Script         | Runs                                       | When it's added                                                                                                                                    |
| -------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<name>:build` | `nx run <name>:build`                      | the kind has a `build` target (not every kind does — a private lib with nothing to publish, or a Python function app deployed as source, has none) |
| `<name>:qa`    | `nx run <name>:lint && nx run <name>:test` | always — every kind has both                                                                                                                       |
| `<name>:start` | the kind's real local-dev command          | only kinds with a genuine dev-server story — never a library                                                                                       |

The same three (when present) are appended as VS Code Tasks into the
workspace's `<workspace-name>.code-workspace` file, so they also show up
under **Terminal → Run Task** / the Command Palette — `build`/`qa` grouped
accordingly, `start` marked `isBackground` since it runs a process that
doesn't exit on its own. Re-running `add` for the same project name
overwrites its own scripts/tasks rather than duplicating them.

`:start` resolves differently per kind — an existing generator target where
one already exists, a small `nx:run-commands` target mnci writes where none
did:

| Kind(s)                                    | `:start` runs                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `react-app`, `node-app`                    | `nx run <name>:serve` — the generator's own inferred dev-server target                                                                |
| `node-function-app`, `python-function-app` | `nx run <name>:start` → `func start` (Azure Functions Core Tools, install separately — never a prerequisite for `add` itself)         |
| `python-app`                               | `nx run <name>:start` → `python3 main.py` — mnci writes a runnable `main.py`, since the plugin's own sample module has no entry point |
| `go-app`                                   | `nx run <name>:start` → `go run .`                                                                                                    |
| `flutter-app`                              | `nx run <name>:start` → `flutter run -d chrome` (web is the only platform this plugin builds for)                                     |
| every library, `go-function-app`           | no `:start` at all — see below                                                                                                        |

**`go-function-app` is a known gap, not an oversight**: unlike the Node and
Python function-app kinds, it writes no `host.json`/custom-handler config, so
there is nothing for `func start` to attach to. Shipping a `:start` script
that would just fail felt worse than being upfront that it doesn't exist yet.

## What `new` actually does

1. `npx create-nx-workspace@latest <name> --preset=ts` — npm workspaces +
   TypeScript project references. Libraries get **no `project.json`**; targets
   are inferred from each project's tsconfig/package.json.
2. Patches `nx.json` with the release opinion (the only config Nx has no
   default for): independent versioning from **conventional commits**,
   `{projectName}@{version}` tags, **tag-only git** (`commit: false`) — nothing
   is ever pushed to `main`; future runs resolve versions from tag names. Also
   fills in `namedInputs.sharedGlobals` with the root config files
   (`eslint.config.mjs`, `tsconfig.base.json`, `package.json`), without which
   `nx affected` on a pull request is blind to them: they live in no project, so
   changing one marked only the root pseudo-project — which has no
   lint/typecheck/test/build target — and the affected-scoped verify step ran
   nothing at all while reporting green.
3. Writes `eslint.config.mjs` (three lines importing `@mnci/eslint-config` —
   the whole linting opinion, in one root config), `.prettierrc.json` +
   `.prettierignore`, `.npmrc` (publish auth — see **Publish auth** below),
   `commitlint.config.mjs`, a husky `commit-msg` hook, the chosen CI provider's
   pipeline file(s)
   (`azure-pipelines.yml` and/or `.github/workflows/ci.yml`, `--ci`, default
   `azure`; `github`/`both` also gets `.github/dependabot.yml` — weekly
   dependency-update PRs), a `<workspace-name>.code-workspace` file (VS Code
   workspace configuration with folder structure, ESLint/Prettier settings,
   recommended extensions, and an empty `tasks` array that `mnci add` fills in
   per project — see below — open it in VS Code via `File > Open Workspace
from File`), and the curated root scripts.
4. Installs the chosen **stack** (see below), `husky` + `@commitlint/*` for
   real, so versions resolve at generation time.

## `mnci upgrade`: re-applying the overlay to an existing workspace

Every fix to `overlay.ts` — a release-config correction, a CI guard rewritten,
a new Windows code path — only ever reached _future_ `mnci new` calls until
this existed; nothing let an already-generated workspace pick one up.
`mnci upgrade`, run from the workspace root, closes that gap: it resolves the
same options `new` would have and calls the exact same `applyOverlay` `new`
itself calls — the one function that does every bit of `mnci`-owned file
writing (`nx.json`'s `release`/`sync`/`generators`/`namedInputs.sharedGlobals`/
`mnci` blocks, `.npmrc`,
`eslint.config.mjs`, `.prettierrc.json`, `commitlint.config.mjs`,
`.husky/commit-msg`, the CI pipeline file(s), `.devcontainer/devcontainer.json`, the
`<workspace-name>.code-workspace` file, and the curated root `package.json`
scripts). Nothing else in the workspace — app/lib source, `project.json` targets
from `mnci add` — is ever touched, and it finishes by running Prettier over the
result, the same way `new` and every `add` do.

The `.code-workspace` file is the one partial case, and deliberately so: its
folders, settings and extensions are regenerated, but the **`tasks` array is read
back and carried through unchanged**. Those tasks are per-project state written by
`mnci add`, not overlay-owned, so regenerating them wholesale would wipe every
project's build/qa/start entry on upgrade.

`upgrade` also **deletes** things, which is stronger than the overwriting it
has always done — one more reason to run `git diff` first, as the command's own
output tells you to:

- `create-nx-workspace`'s `.prettierrc` and `.vscode/`, both superseded (by
  `.prettierrc.json`, which Prettier would otherwise never reach, and by the
  `.code-workspace` file).
- **every per-project `eslint.config.*` under `apps/`, `libs/` and
  `packages/`.** This is the migration path for a workspace generated before
  mnci owned linting: without it an upgrade would install the root config while
  each project kept linting against its own stale copy. The root config is never
  touched, and neither is a config anywhere outside those three directories.

```sh
mnci upgrade                          # re-apply from persisted config alone
mnci upgrade --agent windows-latest   # override one field; the override is
                                       # persisted too, so the next upgrade
                                       # remembers it
```

Where the options come from: `mnci new` now persists the full set it resolved
(`scope`, `registry`, `agent`, `variableGroup`, `ci`, the stack) into
`nx.json`'s `mnci` block — previously only the stack was kept. `upgrade`
reads that block back; an explicit flag on the `upgrade` command line always
wins over the persisted value. A workspace generated before this was
persisted (or hand-edited to remove a field) gets a clear, specific error
naming the one flag needed (`No npm scope found in nx.json's persisted
config. Pass --scope explicitly.`) rather than a prompt or a guess.

There is deliberately no diff preview or confirmation prompt built in:
`applyOverlay` is a plain, deterministic file-writer (same content in, same
content out, every time), and virtually every generated workspace is already
a git repo — **review the result with `git diff` before committing**, the
same way you'd review any other regenerated file. This does mean `upgrade`
will overwrite hand customizations to any of the files it owns (e.g. an extra
CI job appended by hand to the pipeline file) — `git diff` is exactly how
you'd notice and re-apply those on top.

## Stack: one choice asked up front

`mnci new` (run bare, or with flags) asks one question — the test runner. It is
stored where every later `mnci add` honours it, so the whole workspace stays one
stack:

| Question        | Options            | Default | Stored as / honoured via                                                                 |
| --------------- | ------------------ | ------- | ---------------------------------------------------------------------------------------- |
| `--test-runner` | `jest` \| `vitest` | `jest`  | `nx.json` generator `unitTestRunner` default; the hand-built function app follows it too |

**Linting and formatting are unified across the workspace, from exactly one
config file each.** The root `eslint.config.mjs` is three lines importing
[`@mnci/eslint-config`](../eslint-config/README.md); every `@nx/*` generator
drops a config into the project it creates, and `mnci add` deletes it. Projects
still get their `lint` target: `@nx/eslint/plugin` infers it by mapping config
_directories_ onto the project roots beneath them, so the root config covers
them all. (Verified, not assumed — and the e2e enforces both "every project has
a `lint` target" and "the root config genuinely reports violations in a project
with no config of its own", because a future Nx change there would silently
switch linting off workspace-wide.)

ESLint handles code quality only; **Prettier owns all formatting**, configured
for JavaScript Standard Style (no semicolons, single quotes, 2-space indents, no
trailing commas). `mnci` runs Prettier itself at the end of `new` and every
`add`, so a generated workspace passes its own `format:check` immediately — Nx's
generators emit semicolons and double quotes, and without that pass the first
commit buries every real change under generator noise.

One caveat worth knowing: `space-before-function-paren`, Standard's signature
rule, is **not** enforced. Prettier rewrites `function f (a)` to `function f(a)`
on every run and has closed the corresponding option permanently, so enabling it
would make `npm run lint` and `npm run format:check` mutually unsatisfiable.
Choosing Prettier means accepting its call there.

`npm run lint` checks code quality; `npm run format` (write) and
`npm run format:check` (CI-safe) handle formatting. **Both run in CI**, as
separate steps: ESLint is configured for correctness only and deliberately
reports nothing about formatting, so Prettier needs a gate of its own or the
whole formatting opinion is advisory and a workspace drifts out of compliance
with no signal anywhere.

TypeScript is not a question — every workspace runs the **dual compiler** from
[Nx's TS 7 guide](https://nx.dev/docs/technologies/typescript/guides/typescript-7):
`typescript` resolves to a TS 6 package (keeping the programmatic API that Nx's
graph/plugins, Vite, typescript-eslint and the editor need) while
`@typescript/native` provides TS 7's native `tsc`. The inferred
`typecheck`/`build` tasks then run on the **fast TS 7 compiler**, and Nx keeps
analysing config through the TS 6 API — no target rewiring, frozen per repo by
the lockfile. (A plain `typescript@7` install would break Nx, since TS 7 ships
no programmatic API yet; the two aliases are what make it work.)

- **Test runner**: passed straight to the `@nx/*` generators; the function app
  gets a matching `jest.config.mjs` (+ ts-jest) or `vitest.config.ts`.

## Layout convention = release scoping

| Directory          | Contents                                                       | Released?                              |
| ------------------ | -------------------------------------------------------------- | -------------------------------------- |
| `apps/`            | React / Node / Python / Go / Flutter apps (plain or Functions) | Never (packed into the drop)           |
| `packages/`        | Publishable npm libraries, plus Go and Dart packages           | Yes — `nx release`, per-package tags   |
| `python-packages/` | Publishable Python packages (hatchling wheels)                 | Yes — `twine upload` (Azure Artifacts) |
| `libs/`            | Internal libraries (TS, Python, Go or Dart), never published   | Never                                  |

The directory is very nearly the whole model — one exception, and it is a bug
fix rather than a nicety. `go-lib` also lives in `packages/`, but a Go package
has **no per-project manifest** (mnci puts every Go project in one root
`go.mod`), so Nx's default `versionActions` looks for a `package.json` that is
not there and aborts _while building the release graph_ — killing `nx release`
for the whole workspace, not just the Go project. It is therefore excluded with
`!tag:type:go-lib`, which is also the semantically correct call: one module
means its packages have no independent versions to bump. A publishable **Dart**
package in `packages/` needs no such exclusion — `pubspec.yaml` has a real
`version:` field, and `@mnci/nx-flutter` stamps a `versionActions` override that
reads it. Publishable Python packages get their own
`python-packages/` dir so the npm `nx release` (`packages/*`) is never entangled
with Python publishing.

Every kind builds to its own Nx-default output location (`apps/<name>/dist`,
`packages/<name>/dist`, ...) — no post-generation build-output rewiring for
any kind. `mnci add` is pure delegation to the official generators; each
one's own default is left exactly as-is.

## Published packages CAN depend on internal libraries

Import an internal lib from an npm-lib directly — and do **not** add it to the
npm-lib's `dependencies` (npm workspaces links every workspace member into the
root `node_modules` regardless):

```ts
// packages/sdk/src/lib/sdk.ts
import { utils } from '@demo/utils' // libs/utils — private, never published
```

It works because npm-libs are **rollup** bundles: `@nx/rollup`'s `withNx`
externalizes exactly what the manifest declares (`dependencies` +
`peerDependencies`), so real npm deps stay external and declared, while the
undeclared internal lib is compiled from source INTO the bundle — the private
name never reaches the published `package.json`. Trade-off: the published
output is a single bundle (no per-file deep imports).

React apps go the other way (Vite bundles everything by default), and the e2e
proves both directions for real: unlike the published `npm-lib`, which must
keep real npm dependencies **external** (declared, not bundled) for the
published tarball to install correctly downstream, a `react-app` build has no
install step at deploy/runtime, so it inlines **everything** — the private
internal lib AND real npm dependencies alike.

Node apps (`node-app`/`node-function-app`) are a third case: `@nx/node:application`'s
esbuild build is **non-bundled** — it transpiles each file individually and
mirrors the workspace tree into `dist`, so nothing is ever textually inlined.
A private internal lib is compiled by its own `tsc` build and copied into
`dist` at its own path (resolved by a real `require` at run time, the same
way npm workspaces resolve it during development); a real npm dependency
stays a real `require` too, resolved from `node_modules` — present locally,
or installed at deploy time (see "How Node apps work" below).

Cross-project imports (`@scope/lib`) resolve through **TypeScript project
references** under `--preset=ts`, and those references are maintained by
`nx sync`, not by the generators. `mnci add` runs `nx sync` for you right
after generation — but references also go stale **any time you hand-edit a
file to add a new cross-project import** later (nothing about that is an
`mnci add`, so that step can't catch it). For that case every generated
workspace sets `sync.applyChanges: true` in `nx.json`: `--preset=ts` already
registers the `@nx/js:typescript-sync` generator on the `build`/`typecheck`
targets, so instead of just _prompting_ ("Would you like to sync the
identified changes?") on your next `nx build`/`typecheck`/`affected`, Nx fixes
the references **automatically** — no prompt, no manual `npx nx sync`. A
brand-new package may still need one VSCode window reload to be picked up by
the TypeScript server.

`applyChanges` only affects _interactive_ runs, by design: CI always runs sync
generators in dry-run mode and fails instead of silently patching an ephemeral
checkout that never gets committed. That's what the pipeline's `nx sync:check`
step (below) surfaces early — if it fails, run `npx nx sync` locally and
commit the result.

## CI (Azure Pipelines and/or GitHub Actions, any agent OS)

`mnci new` asks which CI provider(s) to write a pipeline file for (`--ci`,
default `azure`): `azure` writes `azure-pipelines.yml`, `github` writes
`.github/workflows/ci.yml`, `both` writes both — pick `github` for a
GitHub-hosted repo, or `both` while migrating between the two. Whichever
provider(s), the pipeline does the **exact same thing**: both files are built
from the same shared guard scripts (`overlay.ts`'s `PYTHON_INSTALL_GUARD`,
`PACK_APPS_GUARD`, `releaseGuard`, `AFFECTED_OR_ALL_GUARD`), so they can never
drift on what CI actually runs — only the provider's own syntax differs. That
matters most for the last of those: the two providers detect a pull request
through different environment variables, so the guard reads both, and a
provider-specific copy would change _what CI verifies_ rather than merely how it
is spelled.

The pipeline contains **no bash and no PowerShell**: every step is a built-in
task/action or a single-line `git`/`npm`/`npx`/`node` command that `cmd.exe`
and `sh` execute identically, so it runs unchanged on Linux, macOS and Windows
agents. The build agent/runner is your choice at `mnci new` (`--agent`,
default `ubuntu-latest`): on Azure a Microsoft-hosted image
(`ubuntu-`/`windows-`/`macos-…`) becomes `pool.vmImage`, anything else a
self-hosted `pool.name`; on GitHub the same value is passed straight through
as `runs-on:` (GitHub's own hosted runner labels already match the common
Azure vmImage names, and a self-hosted label is just as valid there).

Every run (PR and main) installs dependencies, then runs `npm audit`
(non-blocking) and, once the Python toolchain is installed, `pip-audit`
(also non-blocking) — visibility, not enforcement: verified empirically that
a real `npm audit` on this monorepo's own tree flagged nothing but
already-latest upstream packages (`nx`, `verdaccio`) bundling their own not-
yet-patched transitive dependencies, nothing an edit to _this_ workspace's
manifest could fix. A hard-failing audit step would turn CI red for a
problem with no user-actionable fix, for as long as upstream took to patch
it — so both steps always exit 0 regardless of findings, surfacing results
as a clearly labelled section in every CI log instead. The actionable
response to a real finding (a targeted `overrides` entry on just the
vulnerable transitive package) is exactly what this monorepo's own
`fix(deps)` commit did — a manual, reviewed response, not something CI
attempts automatically.

Then `nx sync:check` (fails fast and clearly if the workspace wasn't
synced+committed locally — see above), then `npm run format:check`, then **one
verify step** running `lint,typecheck,test,build`. `typecheck` is in that list
because a bundler-built project strips types without reading them, so `build`
passing proves nothing about type correctness.

That step verifies the **affected** projects on a pull request and **every**
project on anything else — including a push to `main`, so a release is always
verified in full. There is deliberately no separate `npm run lint` step: that is
`nx run-many -t lint`, a strict subset of the list above, and on an
affected-scoped PR it would re-lint every project and throw the benefit away.
`format:check` does stay workspace-wide, because `prettier --check .` is one
invocation over the whole tree rather than a per-project target, so there is
nothing to narrow.

Every fallback in that step verifies **everything**: no PR target branch, an
unresolvable merge-base (shallow clone, absent remote branch), any non-PR run.
That direction is deliberate — resolving the base too wide costs a few minutes,
while resolving it too narrow means CI runs almost nothing, reports green and has
verified nothing. The base is a `git merge-base`, not either provider's "base SHA"
field and not the GitHub-only `nrwl/nx-set-shas`, so one mechanism serves both
providers and is correct in each by construction.

Pushes to `main` then:

- **Pack all apps** — each app's `package` target zips its build output into
  `dist/drop/<type>-<name>.zip` (e.g. `node-function-app-api.zip`,
  `react-app-web.zip`); the whole `dist/drop` is published as the **`drop`**
  artifact.
- **Tag the run per app** _(Azure only)_ — one build tag per zip, **exactly**
  `<type>-<name>` (derived from the zip filenames, so the tag can never drift
  from the artifact). A classic Azure release/CD pipeline keys its trigger off
  these; GitHub Actions has no equivalent mechanism, so the `drop` artifact
  (one zip per app inside it) is the portable substitute there.
- **Release — version, tag and publish** — one `npx nx release --yes` for both
  npm (`packages/*`) and Python (`python-packages/*`): version bump from
  conventional commits → `{projectName}@{version}` git tag pushed to `main`
  (tag-only, never a commit) → publish to the feed (npm via `.npmrc`, Python via
  `twine` when an Azure feed is configured — installed from the generated
  `requirements-dev.txt`, no uv, no Poetry). Reuses the base64 `PAT`, decoded to
  the raw token twine needs for the Python publish. Skipped cleanly when there
  is nothing to release. A guarded step installs the fixed Python toolchain
  (`ruff`/`pytest`/`build`/`twine`/`pip-audit`) before any Python target runs,
  skipped cleanly on a workspace with no Python projects. On a `--ci=github`
  workspace this same step also creates a **GitHub Release per project**, with
  a changelog Nx generates from conventional commits — `nx release` pushes the
  tag itself here (needs `GITHUB_TOKEN`, which GitHub Actions provides for
  free under the workflow's own `contents: write` permission), so there's no
  separate explicit `git push origin --tags` step on this provider. `--ci=azure`
  and `--ci=both` keep today's behaviour (no GitHub Release, explicit tag
  push) — GitHub Release creation only turns on when GitHub Actions is the
  _only_ configured provider, since that's the one case a `GITHUB_TOKEN` is
  guaranteed to exist.

### Publish auth

The generated `.npmrc` differs by registry kind, because the honest answer does.

**`--registry azure-artifacts`** routes the workspace's own scope to the feed and
supplies the feed's credentials:

```ini
@my:registry=https://pkgs.dev.azure.com/<org>/<proj>/_packaging/<feed>/npm/registry/
//pkgs.dev.azure.com/.../npm/registry/:username=AzureArtifacts
//pkgs.dev.azure.com/.../npm/registry/:_password=${PAT}
```

Scope routing is **real protection** here, not decoration: npm prefers a scope's
registry over the global one when publishing a scoped package, so `@my/*` cannot
reach npmjs.org by accident. Verified against a real registry — with only the
scope line set, npm reports `Publishing to <feed>` — and again from a generated
workspace, whose `npm publish --dry-run` targets the feed.

Only the scope is routed, deliberately. A global `registry=` would push every
install through the feed as well, so `npm ci` would need feed auth just to fetch
public packages; as generated, public dependencies still come from npmjs.org and
a developer with no `PAT` set can install normally.

**`--registry npm`** gets the auth line and nothing else:

```ini
//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}
```

There is no `@scope:registry` line, and the generated file explains why: npmjs.org
is already the default, so routing the scope there changes nothing — and calling
it protection against an accidental public publish would be false, because the
public registry is the intended target. Worth stating plainly because this file
previously claimed exactly that protection while emitting no routing line at all.

**npm auth** is the base64 `PAT`, read the same way on both providers but from
a different place: on Azure Pipelines, a **variable group**
(`--variable-group`, default `Build`) exposes it as `$(PAT)`; on GitHub
Actions it's a plain repository (or environment) **secret** named `PAT`, read
as `${{ secrets.PAT }}` — GitHub has no "variable group" concept, so unlike
Azure this needs no CLI-collected name, just a secret you create once in the
repo settings. Either way it's mapped as `env` on the npm steps and read by
the root `.npmrc`'s `_password` block — the PAT value never lands in a file.
No `npmAuthenticate@0` task (it would overwrite the hand-set password).

On Azure, two one-time grants are required (project admin): **Contribute** on
the repo for the _Project Collection Build Service_ account (tag push), and
**publish** rights on the feed for the PAT's owner. On GitHub, the workflow's
`permissions: contents: write` is what lets its own checkout token push the
release tag — no separate grant, but the job still needs that permission
line (already generated) and, for a fork-based PR, GitHub disables
write permissions by default (not a concern for pushes to `main` from the
repo itself, which is the only case this pipeline ever releases from).

**The one PAT, two different encodings — read this before wiring a third
protocol.** The same `PAT` value (`$(PAT)` on Azure, `secrets.PAT` on GitHub)
is base64-encoded throughout — that's the raw value Azure Artifacts' "Connect
to feed" instructions give you. npm's `.npmrc` `_password` field expects
exactly that pre-encoded form, so it's used as-is. `twine`/pypi basic auth, by
contrast, wants the **raw** token — so the shared `releaseGuard` fragment
(`overlay.ts`, used by both `azurePipelinesYaml` and `githubActionsYaml`)
explicitly _decodes_ the same `PAT`
(`Buffer.from(process.env.PAT, 'base64').toString()`) before handing it to
`TWINE_PASSWORD`. Both are correct for their protocol today, but it's an easy
trap to get backwards: if you ever wire a third registry protocol, check
whether it wants the pre-encoded or the raw form before assuming either
convention.

### Dependency updates (`.github/dependabot.yml`, `github`/`both` only)

A `github`/`both` workspace also gets `.github/dependabot.yml`: weekly update
PRs for `npm` (the root lockfile — covers every `packages/*` project),
`github-actions` (the generated workflow's own actions), and `pip` via
**glob** `directories` (`/apps/*`, `/python-packages/*`, `/libs/*`) rather
than one entry per project — Python projects don't exist yet at `mnci new`
time (`add python-*` writes them later), and a glob matching nothing yet is
not an error, so it starts covering Python dependencies automatically the
moment the first one is added, no `mnci upgrade` needed. Dependabot is
GitHub-native (no app/extension install, unlike Renovate), so it's written
only for `github`/`both` — an `azure`-only workspace gets no
`.github/dependabot.yml`, matching every other GitHub-only file this CLI
writes.

### Nx Cloud (`--nx-cloud`, opt-in)

`mnci new` never connects to Nx Cloud unless asked — `--nx-cloud` (or
answering "yes" to the interactive prompt) opts in; the flagless/`--yes`
default stays fully disconnected, exactly as before this existed. When
opted in, `mnci` passes `create-nx-workspace` a **named** `--nxCloud`
provider value derived from the chosen `--ci` (`azure`→`azure`,
`github`/`both`→`github`) — never the bare `--nxCloud=yes`. Verified
empirically: bare `yes` prompts "Will you be using GitHub as your git
hosting provider?" even with `--no-interactive` set, and exits without
creating the workspace at all when stdin isn't a TTY — a real
`create-nx-workspace` inconsistency, not something `mnci` can configure
around. The named-provider value sidesteps it and completes non-interactively
every time. The only visible effect of _which_ named value is chosen is a
throwaway CI workflow file `create-nx-workspace` writes as a side effect of
Cloud setup — this CLI's own overlay unconditionally overwrites whatever
lands at that path immediately after, so the pipeline you actually get is
always the same one described above, Nx Cloud or not.

Connecting still requires finishing setup in a browser: `create-nx-workspace`
prints a `https://cloud.nx.app/connect/…` URL to complete linking the
workspace to an Nx Cloud account (remote caching, CI insights, `nx
fix-ci`) — `mnci` does not automate that step.

## Dependency & risk notes

Being upfront about what mnci leans on, so it's a conscious trade-off rather
than a surprise:

- **Two Nx plugins this project builds and maintains** carry the most weight,
  both for the same reason — the ecosystem has no maintained, Nx-23-compatible
  option:
  - **`@mnci/nx-python-pip`** (`packages/nx-python-pip`): no maintained plugin
    supports pip. The obvious candidate, `@nxlv/python`, requires `uv`, which
    the company standardizing on this tool does not use.
  - **`@mnci/nx-flutter`** (`packages/nx-flutter`): `@nxrocks/nx-flutter`
    cannot even load on Nx 23 — it imports
    `@nx/workspace/src/utilities/fileutils`, removed in 23 — and there is no
    alternative. Its exposure is smaller than the Python plugin's, because
    scaffolding is delegated to the official `flutter create` rather than
    hand-maintained templates; what this project owns is the pub-workspace
    wiring, the targets and the release integration.

  Both trade third-party risk for a different, real one: **this project owns
  two extra packages' maintenance surface** (generators, executors, their own
  release cycles). Unlike official `@nx/*` plugins, if either needs fixes, this
  project owns them directly. That is the cost of the gaps in the ecosystem.

- **`@nx-go/nx-go` is a third-party plugin on a declared-incompatible range.**
  It declares `@nx/devkit ">= 20 < 23"` while this workspace runs Nx 23. That
  range is a plain dependency rather than a peer, so npm nests its own devkit
  copy and everything works — validated empirically against a real Nx 23.1.0
  workspace (generators, build, test, lint). It is still a version trap worth
  re-checking on Nx upgrades.
- **The TS7 dual-compiler aliases pin a very new, fast-moving dependency.**
  TypeScript 7's native compiler is recent; `TS_COMPILER_DEPENDENCIES` pins
  `npm:typescript@^7.0.2` / `npm:@typescript/typescript6@^6.0.2` specifically
  because the alias trick is what makes it work at all today (see "Stack"
  above). A semver-compatible upstream release could still change behavior or
  break the alias before the rest of the ecosystem (Nx, typescript-eslint)
  catches up — worth a periodic re-check, not a "set and forget."

## Known gaps (accepted for the experiment)

- **A scoped package on public npm has no accidental-publish protection**, and
  cannot: npmjs.org is the intended target there, so no `.npmrc` line could
  prevent it. Generate with `--registry azure-artifacts` if you need a scope kept
  off the public registry — that variant routes it (see **Publish auth** above).
- No `doctor`/`resurrect`/`spell` — out of scope until the model is proven.
- **Flutter apps build for web only.** Android would require the Android SDK and
  NDK on every build agent; iOS is impossible on a Linux agent regardless. Add
  other platforms per-app with `flutter create --platforms=...` — the generated
  `build` target only knows about web.
- Azure Functions Core Tools is only needed for **local** `func start` — never
  for `mnci add node-function-app`/`python-function-app` generation, since
  neither shells out to the `func` CLI.
- Function-app _deployment_ (e.g. `AzureFunctionApp@2`) is not wired into the
  pipeline; the `node-function-app-<name>.zip`/`python-function-app-<name>.zip`
  inside the published `drop` artifact is the deploy input. Deploying it means
  Azure's Oryx build installing real dependencies (`npm install`/`pip install`)
  from the zipped manifest — no `node_modules`/venv is bundled.
- Changelog **files** are off everywhere (unpushable under the tag-only
  model — `git.commit` stays `false`, so a written `CHANGELOG.md` would just
  be discarded at the end of every CI run). On a `--ci=github` workspace (and
  only that one — see below) each release still gets a real changelog: Nx
  generates it from conventional commits and posts it straight to a GitHub
  Release, with no file ever touched. `--ci=azure` and `--ci=both` fall back
  to the git tag history as the changelog, same as before.
- **No lock file for Python** — plain pip has none, matching the company
  standard this migration was for. A published wheel's `Requires-Dist` mirrors
  whatever specifier the `pyproject.toml` declares (e.g. `tomli>=2.0.0`)
  verbatim, not a resolved/pinned version the way `uv.lock` would have
  produced. `requirements-dev.txt` (the fixed `ruff`/`pytest`/`build`/`twine`/
  `pip-audit` toolchain) is unpinned for the same reason — pin it by hand if
  the workspace needs reproducible CI tool versions.
- venv management is left to the user (same spirit as never managing
  `node_modules` beyond `npm install`): `mnci` neither creates nor activates
  one. CI installs `requirements-dev.txt`, then editable-installs every
  Python project workspace-wide (see "Workspace-wide install" above),
  straight into whatever `<python>` resolves to on the agent (`python3` on
  POSIX, `python` on Windows — see above); locally, create your own venv
  (`python3 -m venv` / `python -m venv` on Windows) and run
  `npm run python:install` to reproduce the same two installs — the root
  script chains the identical two guards CI runs (see the scripts table
  above).

## How Node apps work (plain `@nx/node:application`, no Azure Functions plugin)

`node-app` and `node-function-app` are both the **official**
`@nx/node:application` generator (`--bundler=esbuild`) — no third-party Azure
Functions plugin, and no post-generation build-output rewiring.
`node-function-app` is exactly that generator plus a hand-written Azure
Functions v4 file overlay, the same split `python-app`/`python-function-app`
already use:

- **`node-app` framework choice** (`--framework`, default `none`): plain flag
  plumbing to the generator's own `express`/`fastify`/`koa`/`nest`/`none`
  choices — `mnci` adds no framework-specific logic of its own. Verified
  empirically that all four scaffold, build and test cleanly on Nx 23.1.0.
  One quirk worth knowing: `--framework=nest` silently overrides
  `--bundler=esbuild` — NestJS needs its own webpack build (decorator/DI
  metadata emission esbuild's transform-only approach can't produce), so a
  `nest` app's `dist/main.js` is a single webpack bundle instead of the
  esbuild non-bundled mirrored-tree + shim the other frameworks (and `none`)
  produce. The `package` target needs no framework branch either way — both
  shapes' runnable entry is `dist/main.js`, so zipping the whole `dist` folder
  works unchanged. `node-function-app` never accepts `--framework`: the Azure
  Functions v4 programming model (`app.http(...)` registration) runs its own
  request lifecycle, so a full HTTP server framework doesn't apply there.

- `build` = the generator's own `@nx/esbuild:esbuild` target, **non-bundled**
  (`bundle: false`): it transpiles each file individually and mirrors the
  workspace tree into `apps/<name>/dist` (e.g.
  `apps/<name>/dist/apps/<name>/src/main.js`), plus a `dist/main.js` shim that
  `require`s the compiled entry — verified empirically, and the one thing that
  makes `main.js` a stable, generator-provided deploy entry point regardless
  of the nested path. A private internal lib is compiled by its own `tsc`
  build and copied into `dist` at its own path; a real npm dependency stays a
  real `require`, resolved from `node_modules`.
- `test`/`lint` = the generator's own targets (`--unitTestRunner`/`--linter`
  passed straight through, same as every other kind) — nothing needs
  hand-wiring here.
- `package` (added by `mnci add`, not the generator) zips `apps/<name>/dist`
  into `dist/drop/node-app-<name>.zip` (`node-app`) — for `node-function-app`
  it additionally zips in `host.json` and the repaired `package.json` into
  `dist/drop/node-function-app-<name>.zip`. No `node_modules` is bundled
  either way: for the function app, Azure's Oryx build installs real
  dependencies from the zipped `package.json` at deploy time — the exact same
  model `python-function-app` already relies on for `requirements.txt`
  (verified empirically: a plain `npm install` in a simulated deploy folder,
  with no bundled `node_modules`, resolves and runs correctly once the
  dependency is declared).
- **`node-function-app` overlay**: `@azure/functions` is installed for real
  (a plain `@nx/node:application` app has no Azure dependency by default,
  unlike a plugin-generated one), an HTTP-triggered `app.http(...)` sample
  (v4 programming model) is written under `src/functions/`, `host.json` is
  added, and the manifest is repaired — `main: 'main.js'` (the dist shim) and
  `@azure/functions` added to `dependencies` for Azure's deploy-time install
  to find.
- **Convention** (both kinds): `src/main.ts` is the esbuild entry — add one
  import per function file you create under `src/functions/`, or it won't be
  reachable (and thus won't be transpiled into `dist`).

## How React apps work (one build per environment)

A React SPA bakes its config in at **build time** (`import.meta.env.VITE_*`),
so it needs a separate build per environment. `add react-app` wires that up
with Vite's own **modes**:

- Scaffolds `.env.dev`, `.env.uat`, `.env.prod` — put each environment's public
  `VITE_*` config there (these values ship in the browser bundle, so they are
  public by definition; real secrets never belong here). The files are
  committed (an allow-rule keeps them out of `.gitignore`).
- Adds `build-dev` / `build-uat` / `build-prod` targets, each
  `vite build --mode <env> --outDir dist-<env>`, so every environment gets its
  own compiled-in config. The default inferred `build` (single build) stays
  for local dev and the CI verify step.
- `package` builds all three and zips each into
  `dist/drop/react-app-<name>-<env>.zip` — **one artifact per environment**.

CI needs no change: the per-app tag step derives one build tag per zip, so you
get `react-app-<name>-dev` / `-uat` / `-prod`, and the classic release pipeline
deploys each environment from its own artifact + tag. Need different
environments? Edit `REACT_ENVIRONMENTS` in the generator.

## Python (`@mnci/nx-python-pip` — pip + Ruff + pytest + PyPA `build`/`twine`, no uv)

Python is the first non-JS language, and follows the same philosophy as every
other kind — pure delegation to a real Nx plugin generator — except the
plugin is one this project built and maintains itself:
[`@mnci/nx-python-pip`](../nx-python-pip) (`libs/nx-python-pip` in this same
monorepo). No maintained, Nx-23-compatible Python plugin supports pip
(verified empirically: the previous plugin, `@nxlv/python`, ships only uv and
Poetry providers; every alternative found on npm is either the same
uv/Poetry architecture or years stale), so rather than keep hand-authoring
Python projects forever inside `add/python.ts` (the position this repo was in
right after dropping `@nxlv/python`), the generation logic was extracted into
a proper, independently testable, independently publishable Nx plugin —
`add/python.ts` now just calls `nx g @mnci/nx-python-pip:<kind>`, the same
shape as `react-app`/`node-app`/`npm-lib`.

`@mnci/nx-python-pip` ships real `@nx/devkit` generators (`application`,
`library`, `internal-library`, `function-application`) and real TypeScript
executors (`build`, `test`, `lint`, `publish`) — not `nx:run-commands`
wrappers — so `nx-release-publish`'s `dryRun` arrives as a genuine typed
executor option (`nx release publish --dry-run` sets it automatically for
every custom executor, no argv-parsing trick needed), and internal-lib
vendoring resolves a dependency's location via the real Nx **project graph**,
not a hard-coded `libs/<name>` path. `mnci add python-*` installs it like any
other npm devDependency (`npm install --save-dev @mnci/nx-python-pip` —
no `nx.json` `plugins` registration needed, since its generators/executors
are explicit, not inference-based) and writes exactly one file itself:
`requirements-dev.txt` at the workspace root (the fixed `ruff`/`pytest`/
`build`/`twine`/`pip-audit` toolchain — install with `<python> -m pip
install -r requirements-dev.txt`), since the plugin is a generic Nx plugin
with no
opinion on how its own runtime dependencies land on a machine. There is **no
stack question** — Ruff (lint + format) and pytest are the standard, so they
are always used, invoked as `<python> -m <tool>` everywhere (not a
hard-coded venv path), so the exact same command works whether or not a venv
is activated. `<python>` resolves to `python3` on POSIX or `python` on
Windows (the standard python.org Windows installer registers no
`python3.exe`) — every guard script in the generated pipeline and every
`@mnci/nx-python-pip` executor makes this same platform check, never a
hard-coded name, so a `windows-latest` (or self-hosted Windows) agent works
identically to a Linux/macOS one.

| Kind                  | Location                 | Build / deploy                                                                                                                                                                                                                 |
| --------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `python-app`          | `apps/<name>`            | `python -m build` wheel (the plugin's `build` executor), zipped by mnci into `dist/drop/python-app-<name>.zip`                                                                                                                 |
| `python-function-app` | `apps/<name>`            | Azure Functions **v2** (`function_app.py` + `host.json` + `requirements.txt`); no `pyproject.toml`/wheel — the **source** is zipped by mnci into `dist/drop/python-function-app-<name>.zip` (no `func` CLI needed to generate) |
| `python-lib`          | `python-packages/<name>` | publishable wheel; the plugin's `publish` executor (`twine upload --skip-existing`)                                                                                                                                            |
| `python-internal-lib` | `libs/<name>`            | private shared code, lint + test only — no build/package target of its own                                                                                                                                                     |

- **Apps** get a `package` target — mnci's own CI packaging convention, not
  a generic plugin concern — merged into the plugin-written `project.json`
  after generation, fitting the existing CI unchanged: the pipeline's
  `apps/*` pack step tags them `python-app-<name>` / `python-function-app-
<name>` just like the TS apps.
- **Internal-lib vendoring** replaces `@nxlv/python`'s `bundleLocalDependencies`:
  plain pip has no bundled-local-dependency feature, so a project that imports
  a workspace-internal Python library needs a `vendor` entry (under
  `[tool.mnci-python-pip]`) in its own `pyproject.toml` (the pip-world
  counterpart of a `dependencies = [...]` entry — neither mnci nor the plugin
  wires cross-project Python dependencies automatically). `mnci add
python-vendor <consumer> --lib <name>` automates writing that entry —
  idempotent (safe to run twice), and works on any consumer with a
  `pyproject.toml` (app, publishable lib, or another internal lib), not just
  apps. The plugin's `build` executor reads the entry, resolves the named
  project's root via the **Nx project graph**, copies its module into a
  staged copy of the consuming project, and builds from there — so the
  resulting wheel contains the vendored module as a real top-level package.
  Verified empirically that this does **not** reproduce the old
  `@nxlv/python` bug where combining a vendored internal lib and a real
  external dependency on the same project silently dropped the external one
  from the wheel's metadata — both survive correctly.
- **Workspace-wide install** (mnci's own CI step, not the plugin's) — pip has
  no npm-workspaces-style hoisting, so mnci writes one: a guarded step
  editable-installs every Python project (`apps/*`, `python-packages/*`,
  `libs/*` — any with a `pyproject.toml`) into one shared environment in a
  single `pip install` call, plus `-r`-installs every function app's
  `requirements.txt`. This is the pip-world counterpart of `npm install`
  hoisting every workspace package into one root `node_modules`, and it is
  what lets a project that vendors an internal lib (see above) resolve that
  import at **lint/test/dev time**, not only inside the final wheel — the
  plugin's own `test` executor (`installEditable`) only editable-installs the
  project under test, not what it imports. Skipped cleanly on a workspace
  with no Python projects.
- **Release** is unified with npm: `nx release` scopes both `packages/*` and
  `python-packages/*` in one flat project list (deliberately not two named
  `release.groups` — Nx hard-errors the whole release when an explicit group
  matches zero projects, a real failure mode for a Python-only or npm-only
  workspace, verified empirically), so a Python package is **versioned from
  conventional commits and tagged** `{projectName}@{version}` exactly like an
  npm one — its `pyproject.toml` version bumps, tag-only (never a commit).
  The plugin's `library` generator sets a project-level
  `release.version.versionActions` override pointing at
  `@mnci/nx-python-pip/release/version-actions` (a `VersionActions`
  implementation — six methods, verified empirically against a real `nx
release version --dry-run`), which wins over the workspace's default
  (npm's) `versionActions` for that one project. **Publishing** reuses the
  registry: an Azure Artifacts feed is **multi-protocol**, so the same
  org/project/feed serves Python — the release step exports `TWINE_*` (URL +
  the base64 `PAT` decoded to the raw token twine needs, no second secret) and
  `nx release` publishes the wheels with `twine`. (On a public-npm workspace a
  Python package is still versioned + tagged, but publishing it needs
  user-provided `TWINE_*` — e.g. a PyPI token.)
- **CI** also runs `nx run-many -t lint,test,build`, so Python's ruff `lint`
  target runs alongside the JS ESLint build. One guarded pipeline step installs
  `requirements-dev.txt` first (the fixed toolchain), then a second installs
  every Python project workspace-wide (the workspace-wide install above) —
  both skipped cleanly when the workspace has no Python projects.

## Go (`@nx-go/nx-go` — one root `go.mod`, golangci-lint + `go test`)

Requires **Go 1.21+** on the machine and on the build agent; `mnci add go-*`
fails fast with an install link when `go` is not on the `PATH`. The generated
pipeline installs `golangci-lint` itself (see below).

| Kind              | Location          | Build / deploy                                                                                                                                                                                                |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `go-app`          | `apps/<name>`     | `go build` binary into `dist/apps/<name>/`, zipped by mnci into `dist/drop/go-app-<name>.zip`                                                                                                                 |
| `go-function-app` | `apps/<name>`     | same build; zipped into `dist/drop/go-function-app-<name>.zip`. The handler body is yours to write — AWS Lambda, Google Cloud Functions and Azure each want a different signature, and mnci does not pick one |
| `go-lib`          | `packages/<name>` | publishable **by git tag** — see below; lint + test targets only                                                                                                                                              |
| `go-internal-lib` | `libs/<name>`     | private shared code, lint + test only — a non-`main` package produces no binary                                                                                                                               |

- **One root `go.mod`**, matching how TS uses one root `package.json` and
  Python one root `requirements-dev.txt`. `add/go.ts` bootstraps it on the
  first Go `add` by running the plugin's `init` then `convert-to-one-mod`
  generators, in that order — `convert-to-one-mod` refuses once `go.work`
  lists any module, so it has to happen before the first Go project exists.
  Every Go project then shares that module and imports its siblings as
  `<module>/libs/<name>`, with no per-project manifests and no `replace`
  directives.
- **The `go.work` multi-module layout was rejected deliberately.** Besides
  splitting dependencies across per-project manifests, it is brittle: a
  single stale `use` entry — a project directory removed by hand — makes
  `go list -m -json` fail, and that breaks the **entire** Nx project graph,
  not just the Go projects. Verified empirically.
- **Targets are written explicitly** rather than inferred. `@nx-go/nx-go`
  supplies `build`/`test`/`lint` by inference, but keys that inference on a
  per-project `go.mod` — which single-module mode does not have, so nothing
  is inferred. mnci writes them into `project.json` instead, as it already
  does for most kinds.
- **Lint is `golangci-lint`, pinned deliberately.** The plugin's `lint`
  executor defaults to `go fmt`, which only reformats — a green lint step
  with that default would mean nothing. The generated target passes
  `linter: golangci-lint`, and `mnci add` warns (without failing) when the
  binary is missing locally, since CI installs its own.
- **Publishing a `go-lib` is a git tag, not a registry upload.** The whole
  repository is one module, so consumers depend on a library by import path
  at a repo-level version tag — `go get <module>/packages/<name>@v1.2.3`.
  That tag is the one `nx release` already creates, so no
  `nx-release-publish` target is written: there is nothing to push. The only
  real difference between `go-lib` and `go-internal-lib` is intent, recorded
  in the `type:go-lib` tag and the `packages/` location.
- **No publish-time dependency injection**, unlike Python's vendoring: `go
build` links statically, so the binary in the drop already contains
  everything it needs.
- **Build output is a directory**, `dist/apps/<name>/`, with the binary
  inside it. The executor's own default writes a bare file at
  `dist/apps/<name>`, which cannot be declared as an Nx `outputs` entry —
  Nx scans each declared output to cache it, and scanning a file fails with
  `ENOTDIR`. Building one level deeper keeps the root-`dist` convention and
  makes the target cacheable.
- **CI** runs Go through the same `nx run-many -t lint,test,build` as
  everything else. Two guarded steps precede it: `go mod download` (so a
  network failure reads as a dependency failure rather than a confusing
  build error), and a `golangci-lint` install via `go install` — no package
  manager, no sudo, same command on every agent OS — whose `GOPATH/bin` is
  then added to `PATH` for later steps. All three skip cleanly when the
  workspace has no root `go.mod`, and the linter install also skips when the
  agent already provides it.

## Flutter (`@mnci/nx-flutter` — one root `pubspec.yaml` pub workspace)

Requires the **Flutter SDK** (3.27+, for Dart 3.6+ pub workspaces) on the
machine; `mnci add flutter-*` fails fast with an install link when `flutter` is
not on the `PATH`. Unlike Python and Go, the SDK is **not** present on hosted
build agents, so the generated pipeline installs it itself (see below).

| Kind                   | Location          | Build / deploy                                                                                        |
| ---------------------- | ----------------- | ----------------------------------------------------------------------------------------------------- |
| `flutter-app`          | `apps/<name>`     | `flutter build web` bundle into `dist/apps/<name>/`, zipped into `dist/drop/flutter-app-<name>.zip`   |
| `flutter-lib`          | `packages/<name>` | publishable **by git tag** — see below; analyze + test targets only                                   |
| `flutter-internal-lib` | `libs/<name>`     | private shared code, analyze + test only — a Dart package is compiled into whatever app depends on it |

- **Dependencies are central, via a Dart pub workspace.** One root
  `pubspec.yaml` lists every project under `workspace:`, and each project
  carries `resolution: workspace`. A single `flutter pub get` at the root then
  resolves the whole graph into **one** `pubspec.lock` and **one**
  `.dart_tool/package_config.json` — pub actively deletes any per-package
  copies. This is the Flutter half of the same root-manifest model as the root
  `package.json` for TS, `requirements-dev.txt` for Python and `go.mod` for Go.
- **An internal library is consumed with a plain version constraint — no
  `path:`.** `dependencies: { core: ^0.0.1 }` resolves to the local package
  because it is a workspace member. That is also why Flutter needs **no
  vendoring step**: contrast `mnci add python-vendor`, which exists only
  because pip cannot bundle an unpublished sibling into a wheel. Flutter is in
  the Go camp here — nothing to weave in at build time.
- **Lint configuration is central too.** The workspace root owns one
  `analysis_options.yaml` (including `package:flutter_lints/flutter.yaml`), and
  each project's own file is a one-line relative `include:` of it, so a rule
  change lands in one place.
- **`flutter analyze --fatal-infos`, pinned explicitly.** `flutter analyze`
  already defaults `--fatal-infos` on — verified against 3.44.8, where
  `--no-fatal-infos` turns a failing lint run green. It is passed anyway
  because that default is the only thing making this a real gate: nearly every
  `flutter_lints` rule reports at _info_ severity. Worth knowing that plain
  `dart analyze` defaults the opposite way (it fails on errors and warnings but
  not infos), so swapping the command without carrying the flag across would
  silently stop enforcing anything.
- **Publishing a `flutter-lib` is a git tag, not a registry upload.** Azure
  Artifacts has no pub/Dart feed type, so a private pub registry is not
  available on this stack, and these packages are deliberately not pushed to
  pub.dev. `nx release` versions and tags them; no `nx-release-publish` target
  is written.
- **The publishable lib carries a `versionActions` override, and it is
  load-bearing.** Nx's default reads a `package.json`, which a Dart package
  does not have. Without the override `nx release` aborts while building the
  release graph — taking down the release of **every** project in the
  workspace, not just the Dart one. The plugin's `library` generator stamps
  `@mnci/nx-flutter/release/version-actions` on, which reads and writes
  `pubspec.yaml`'s `version:`.
- **Apps build for web only.** Web needs nothing beyond the Flutter SDK,
  whereas an Android build would drag the whole Android SDK and NDK onto every
  build agent. Other platforms can be added per-app later with
  `flutter create --platforms=...`.
- **CI** installs the SDK by shallow `git clone` at a pinned tag — Flutter's own
  documented install method, and the only one uniform across agents (the
  release archives differ by platform). It is cloned **outside** the workspace,
  under the agent's home directory: the SDK ships dozens of its own
  `pubspec.yaml` files, which inside the tree would pollute pub's resolution and
  give Nx thousands of extra files to glob. The SDK version is **pinned**
  (unlike `golangci-lint`'s `@latest`) because it determines the Dart version,
  and pub workspaces need Dart 3.6+. Three guarded steps precede the build —
  install, add to `PATH`, and one root `flutter pub get` — and all three skip
  cleanly when the workspace has no root `pubspec.yaml`; the install also skips
  when an SDK is already available.
