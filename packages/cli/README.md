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

| Hand-rolled elsewhere                            | This CLI uses instead                                        |
| ------------------------------------------------ | ----------------------------------------------------------- |
| Template engine + per-project config files       | `create-nx-workspace --preset=ts` + `nx g` plugin generators |
| A shared toolchain package for configs           | The configs the Nx generators emit (one root ESLint/tsconfig) |
| A custom multi-step CI engine                    | `nx affected -t lint,test,build` + `nx release` (~60-line pipeline) |
| A dist-package dependency injector               | `nx release` updates dependent versions natively             |
| Hand-written Azure Function templates            | `@nx/node:application` (plain Node app) + a thin Azure Functions v4 overlay |
| doctor/drift sync of tool-owned files             | Nothing to drift: this CLI owns 5 small files, Nx owns the rest |

## Commands (deliberately just three)

```sh
mnci new my-repo            # create a monorepo (prompts scope + registry)
mnci new my-repo --yes --registry npm --scope @my

cd my-repo
mnci add react-app web         # @nx/react (Vite + Jest)
mnci add node-app svc          # @nx/node (plain Node app, esbuild)
mnci add node-function-app api # @nx/node + an Azure Functions v4 overlay
mnci add npm-lib sdk           # @nx/js publishable lib -> packages/
mnci add internal-lib utils    # @nx/js private lib -> libs/

# Python (@mnci/nx-python-pip — pip + Ruff + pytest + PyPA build/twine, no uv)
mnci add python-app svc            # app -> apps/ (wheel, zipped into the drop)
mnci add python-function-app fn    # Azure Functions (Python v2) -> apps/
mnci add python-lib shared         # publishable -> python-packages/ (twine upload)
mnci add python-internal-lib core  # private shared lib -> libs/

mnci upgrade                  # re-apply the latest overlay (see below)
mnci upgrade --agent windows-latest   # ...with an explicit override
```

Everything else is plain Nx, surfaced as a small curated set of root scripts —
each a single cross-platform command:

| Script                | Runs                            |
| --------------------- | ------------------------------- |
| `npm run build`       | `nx run-many -t build`          |
| `npm run lint`        | `nx run-many -t lint`           |
| `npm run test`        | `nx run-many -t test`           |
| `npm run affected`    | `nx affected -t lint,test,build` (vs `main`) |
| `npm run graph`       | `nx graph`                      |
| `npm run release:preview` | `nx release --dry-run`      |
| `prepare`             | `husky` (commit-msg lint hook)  |

## What `new` actually does

1. `npx create-nx-workspace@latest <name> --preset=ts` — npm workspaces +
   TypeScript project references. Libraries get **no `project.json`**; targets
   are inferred from each project's tsconfig/package.json.
2. Patches `nx.json` with the release opinion (the only config Nx has no
   default for): independent versioning from **conventional commits**,
   `{projectName}@{version}` tags, **tag-only git** (`commit: false`) — nothing
   is ever pushed to `main`; future runs resolve versions from tag names.
3. Writes `.npmrc` (Azure Artifacts feed or public npm — scope routing makes
   accidental public publishes impossible), `commitlint.config.mjs`, a husky
   `commit-msg` hook, the chosen CI provider's pipeline file(s)
   (`azure-pipelines.yml` and/or `.github/workflows/ci.yml`, `--ci`, default
   `azure`; `github`/`both` also gets `.github/dependabot.yml` — weekly
   dependency-update PRs), and the curated root scripts.
4. Installs the chosen **stack** (see below), `husky` + `@commitlint/*` for
   real, so versions resolve at generation time.

## `mnci upgrade`: re-applying the overlay to an existing workspace

Every fix to `overlay.ts` — a release-config correction, a CI guard rewritten,
a new Windows code path — only ever reached *future* `mnci new` calls until
this existed; nothing let an already-generated workspace pick one up.
`mnci upgrade`, run from the workspace root, closes that gap: it resolves the
same options `new` would have and calls the exact same `applyOverlay` `new`
itself calls — the one function that does every bit of `mnci`-owned file
writing (`nx.json`'s `release`/`sync`/`generators`/`mnci` blocks, `.npmrc`,
`commitlint.config.mjs`, `.husky/commit-msg`, the CI pipeline file(s), and the
curated root `package.json` scripts). Nothing else in the workspace — app/lib
source, `project.json` targets from `mnci add` — is ever touched.

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

## Stack: two choices asked up front

`mnci new` (run bare, or with flags) asks two questions — the linter and the
test runner. Each is stored where every later `mnci add` honours it, so the
whole workspace stays one stack:

| Question       | Options            | Default | Stored as / honoured via |
| -------------- | ------------------ | ------- | ------------------------ |
| `--linter`     | `eslint` \| `oxlint` | `eslint` | `nx.json` generator `linter` default (`none` for oxlint) + a typed `oxlint.config.mts` + `oxfmt.config.mts` (both from the [oxc-standard](https://github.com/JohnDeved/ox-standard) preset) + the `oxlint` / `oxfmt` root scripts |
| `--test-runner`| `jest` \| `vitest` | `jest`  | `nx.json` generator `unitTestRunner` default; the hand-built function app follows it too |

TypeScript is not a question — every workspace runs the **dual compiler** from
[Nx's TS 7 guide](https://nx.dev/docs/technologies/typescript/guides/typescript-7):
`typescript` resolves to a TS 6 package (keeping the programmatic API that Nx's
graph/plugins, Vite, typescript-eslint and the editor need) while
`@typescript/native` provides TS 7's native `tsc`. The inferred
`typecheck`/`build` tasks then run on the **fast TS 7 compiler**, and Nx keeps
analysing config through the TS 6 API — no target rewiring, frozen per repo by
the lockfile. (A plain `typescript@7` install would break Nx, since TS 7 ships
no programmatic API yet; the two aliases are what make it work.)

- **Linter**: ESLint is a per-project Nx target; oxlint is a single
  workspace-wide binary. Either way `npm run lint` (and the CI) is
  linter-agnostic, so nothing downstream branches. Under oxlint a publishable
  package's private-lib import needs no dependency-check override (that rule is
  ESLint-only), so none is written.
  - The oxlint stack installs **[oxc-standard](https://github.com/JohnDeved/ox-standard)**
    (which brings `oxlint` + `oxfmt`) and generates two `.mts` configs that use
    its **JavaScript Standard Style** preset: `oxlint.config.mts` *extends*
    `oxc-standard`'s rule set (unicorn + React + react-perf + TypeScript + oxc),
    and `oxfmt.config.mts` mirrors its formatting (no semicolons, single quotes,
    2-space, `es5` trailing commas, avoid arrow parens). That gives the full
    Standard experience — **linting *and* formatting** — since oxlint (a linter)
    does not enforce layout.
  - Formatting is `npm run format` (write) and `npm run format:check` (CI-safe,
    no writes). Nx generators emit semicolon/double-quote code, so run
    `npm run format` once after scaffolding to normalise a new workspace to
    Standard Style. (CI stays lint/test/build only — formatting is left as a
    local/pre-commit step so the pipeline needs no linter-specific branch.)
- **Test runner**: passed straight to the `@nx/*` generators; the function app
  gets a matching `jest.config.mjs` (+ ts-jest) or `vitest.config.ts`.

## Layout convention = release scoping

| Directory          | Contents                                          | Released?                    |
| ------------------ | ------------------------------------------------- | ---------------------------- |
| `apps/`            | React / Node / Python apps (plain or Azure Functions) | Never (packed into the drop) |
| `packages/`        | Publishable npm libraries (rollup-bundled)        | Yes — `nx release`, per-package tags |
| `python-packages/` | Publishable Python packages (hatchling wheels)    | Yes — `twine upload` (Azure Artifacts) |
| `libs/`            | Internal libraries (TS or Python), never published | Never                        |

No custom tags, no stamp file — the directory (and, for npm, the `private` flag)
are the whole model. Publishable Python packages get their own
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
targets, so instead of just *prompting* ("Would you like to sync the
identified changes?") on your next `nx build`/`typecheck`/`affected`, Nx fixes
the references **automatically** — no prompt, no manual `npx nx sync`. A
brand-new package may still need one VSCode window reload to be picked up by
the TypeScript server.

`applyChanges` only affects *interactive* runs, by design: CI always runs sync
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
`PACK_APPS_GUARD`, `releaseGuard`), so they can never drift on what CI
actually runs — only the provider's own syntax differs.

The pipeline contains **no bash and no PowerShell**: every step is a built-in
task/action or a single-line `git`/`npm`/`npx`/`node` command that `cmd.exe`
and `sh` execute identically, so it runs unchanged on Linux, macOS and Windows
agents. The build agent/runner is your choice at `mnci new` (`--agent`,
default `ubuntu-latest`): on Azure a Microsoft-hosted image
(`ubuntu-`/`windows-`/`macos-…`) becomes `pool.vmImage`, anything else a
self-hosted `pool.name`; on GitHub the same value is passed straight through
as `runs-on:` (GitHub's own hosted runner labels already match the common
Azure vmImage names, and a self-hosted label is just as valid there).

Every run (PR and main) first does `nx sync:check` (fails fast and clearly if
the workspace wasn't synced+committed locally — see above), then one
`nx run-many -t lint,test,build`. Pushes to `main` then:

- **Pack all apps** — each app's `package` target zips its build output into
  `dist/drop/<type>-<name>.zip` (e.g. `node-function-app-api.zip`,
  `react-app-web.zip`); the whole `dist/drop` is published as the **`drop`**
  artifact.
- **Tag the run per app** *(Azure only)* — one build tag per zip, **exactly**
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
  (`ruff`/`pytest`/`build`/`twine`) before any Python target runs, skipped
  cleanly on a workspace with no Python projects.

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
the repo for the *Project Collection Build Service* account (tag push), and
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
explicitly *decodes* the same `PAT`
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

## Dependency & risk notes

Being upfront about what mnci leans on, so it's a conscious trade-off rather
than a surprise:

- **One unofficial, small-team third-party Nx plugin carries real weight**:
  [`oxc-standard`](https://github.com/JohnDeved/ox-standard) (the oxlint/oxfmt
  StandardJS preset) — not `@nx`-scoped/officially maintained. Neither Azure
  Function generation nor any Python kind pulls in a *third-party* Nx plugin:
  Node apps use the **official** `@nx/node:application` plus a small
  hand-written Azure Functions v4 file overlay (see "How Node apps work"
  below), and Python uses **`@mnci/nx-python-pip`** — a real Nx plugin this
  project built and maintains itself (`libs/nx-python-pip` in this same
  monorepo), after `@nxlv/python` (the previous Python plugin) turned out to
  require `uv`, which the company standardizing on this tool does not use,
  and no maintained alternative supports pip. That trades third-party risk
  for a different, real one: **this project now owns a second package's
  maintenance surface** (generators, executors, its own release cycle) —
  worth being explicit about, since it did not exist before this migration.
  If `oxc-standard` stalls or breaks compatibility with a future Nx major,
  that surface needs a real maintenance response, not just a version bump.
- **The TS7 dual-compiler aliases pin a very new, fast-moving dependency.**
  TypeScript 7's native compiler is recent; `TS_COMPILER_DEPENDENCIES` pins
  `npm:typescript@^7.0.2` / `npm:@typescript/typescript6@^6.0.2` specifically
  because the alias trick is what makes it work at all today (see "Stack"
  above). A semver-compatible upstream release could still change behavior or
  break the alias before the rest of the ecosystem (Nx, typescript-eslint)
  catches up — worth a periodic re-check, not a "set and forget."

## Known gaps (accepted for the experiment)

- No `doctor`/`resurrect`/`spell` — out of scope until the model is proven.
- Azure Functions Core Tools is only needed for **local** `func start` — never
  for `mnci add node-function-app`/`python-function-app` generation, since
  neither shells out to the `func` CLI.
- Function-app *deployment* (e.g. `AzureFunctionApp@2`) is not wired into the
  pipeline; the `node-function-app-<name>.zip`/`python-function-app-<name>.zip`
  inside the published `drop` artifact is the deploy input. Deploying it means
  Azure's Oryx build installing real dependencies (`npm install`/`pip install`)
  from the zipped manifest — no `node_modules`/venv is bundled.
- Changelog files are off (unpushable under the tag-only model); the git tag
  history is the changelog for now.
- **No lock file for Python** — plain pip has none, matching the company
  standard this migration was for. A published wheel's `Requires-Dist` mirrors
  whatever specifier the `pyproject.toml` declares (e.g. `tomli>=2.0.0`)
  verbatim, not a resolved/pinned version the way `uv.lock` would have
  produced. `requirements-dev.txt` (the fixed `ruff`/`pytest`/`build`/`twine`
  toolchain) is unpinned for the same reason — pin it by hand if the
  workspace needs reproducible CI tool versions.
- venv management is left to the user (same spirit as never managing
  `node_modules` beyond `npm install`): `mnci` neither creates nor activates
  one. CI installs `requirements-dev.txt`, then editable-installs every
  Python project workspace-wide (see "Workspace-wide install" above),
  straight into whatever `<python>` resolves to on the agent (`python3` on
  POSIX, `python` on Windows — see above); locally, create your own venv
  (`python3 -m venv` / `python -m venv` on Windows) and reproduce the same
  two installs by hand (`pip install -r requirements-dev.txt`, then
  `pip install -e <dir>` for each Python project).

## How Node apps work (plain `@nx/node:application`, no Azure Functions plugin)

`node-app` and `node-function-app` are both the **official**
`@nx/node:application` generator (`--bundler=esbuild --framework=none`) — no
third-party Azure Functions plugin, and no post-generation build-output
rewiring. `node-function-app` is exactly that generator plus a hand-written
Azure Functions v4 file overlay, the same split `python-app`/
`python-function-app` already use:

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
`build`/`twine` toolchain — install with `<python> -m pip install -r
requirements-dev.txt`), since the plugin is a generic Nx plugin with no
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

| Kind | Location | Build / deploy |
| ---- | -------- | -------------- |
| `python-app` | `apps/<name>` | `python -m build` wheel (the plugin's `build` executor), zipped by mnci into `dist/drop/python-app-<name>.zip` |
| `python-function-app` | `apps/<name>` | Azure Functions **v2** (`function_app.py` + `host.json` + `requirements.txt`); no `pyproject.toml`/wheel — the **source** is zipped by mnci into `dist/drop/python-function-app-<name>.zip` (no `func` CLI needed to generate) |
| `python-lib` | `python-packages/<name>` | publishable wheel; the plugin's `publish` executor (`twine upload --skip-existing`) |
| `python-internal-lib` | `libs/<name>` | private shared code, lint + test only — no build/package target of its own |

- **Apps** get a `package` target — mnci's own CI packaging convention, not
  a generic plugin concern — merged into the plugin-written `project.json`
  after generation, fitting the existing CI unchanged: the pipeline's
  `apps/*` pack step tags them `python-app-<name>` / `python-function-app-
  <name>` just like the TS apps.
- **Internal-lib vendoring** replaces `@nxlv/python`'s `bundleLocalDependencies`:
  plain pip has no bundled-local-dependency feature, so a project that imports
  a workspace-internal Python library needs a hand-added `vendor` entry (under
  `[tool.mnci-python-pip]`) in its own `pyproject.toml` (the pip-world
  counterpart of hand-wiring a `dependencies = [...]` entry — neither mnci
  nor the plugin wires cross-project Python dependencies automatically). The
  plugin's `build` executor reads that entry, resolves the named project's
  root via the **Nx project graph**, copies its module into a staged copy of
  the consuming project, and builds from there — so the resulting wheel
  contains the vendored module as a real top-level package. Verified
  empirically that this does **not** reproduce the old `@nxlv/python` bug
  where combining a vendored internal lib and a real external dependency on
  the same project silently dropped the external one from the wheel's
  metadata — both survive correctly.
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
  target runs alongside the JS build even on the oxlint stack (whose
  `npm run lint` only covers JS). One guarded pipeline step installs
  `requirements-dev.txt` first (the fixed toolchain), then a second installs
  every Python project workspace-wide (the workspace-wide install above) —
  both skipped cleanly when the workspace has no Python projects.
