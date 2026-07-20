# MoNecromanCI v2 (box-out)

> **Experiment**: rebuild MoNecromanCI's core value — an opinionated
> one-command NX monorepo with automatic commit-message versioning — as a
> **thin CLI over what Nx already ships**, instead of hand-rolling templates,
> configs and CI engines.

This package is the "box-out" rethink of [`monecromanci`](../monecromanci).
If promoted, it replaces v1's source and ships as `monecromanci@2.0.0`.
Until then it is private, and its binary is `mnci2` so both CLIs can coexist.

## The thesis

v1 hand-rolls almost everything: a template engine emitting ~15 files per
project, a packaged shared toolchain (`monecromanci-toolchain`), a 6-step CI
engine, a custom dist-package dependency injector, and a doctor/drift-sync
system to keep all of that consistent. Most of that now has a first-party (or
established community) Nx equivalent:

| v1 hand-rolled                                   | v2 uses instead                                             |
| ------------------------------------------------ | ----------------------------------------------------------- |
| Template engine + per-project config files       | `create-nx-workspace --preset=ts` + `nx g` plugin generators |
| `monecromanci-toolchain` shared configs          | The configs the Nx generators emit (one root ESLint/tsconfig) |
| `.build-templates/` 6-step CI engine             | `nx affected -t lint,test,build` + `nx release` (~60-line pipeline) |
| `generate-dist-package.mjs` dependency injection | `nx release` updates dependent versions natively             |
| Hand-written Azure Function templates            | `@nx/node:application` (plain Node app) + a thin Azure Functions v4 overlay |
| doctor/drift sync of tool-owned files            | Nothing to drift: v2 owns 5 small files, Nx owns the rest    |

## Commands (deliberately just two)

```sh
mnci2 new my-repo            # create a monorepo (prompts scope + registry)
mnci2 new my-repo --yes --registry npm --scope @my

cd my-repo
mnci2 add react-app web         # @nx/react (Vite + Jest)
mnci2 add node-app svc          # @nx/node (plain Node app, esbuild)
mnci2 add node-function-app api # @nx/node + an Azure Functions v4 overlay
mnci2 add npm-lib sdk           # @nx/js publishable lib -> packages/
mnci2 add internal-lib utils    # @nx/js private lib -> libs/

# Python (via @nxlv/python — uv + Ruff + pytest)
mnci2 add python-app svc            # uv app -> apps/ (wheel, zipped into the drop)
mnci2 add python-function-app fn    # Azure Functions (Python v2) -> apps/
mnci2 add python-lib shared         # publishable -> python-packages/ (uv publish)
mnci2 add python-internal-lib core  # private shared lib -> libs/
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
   `commit-msg` hook, `azure-pipelines.yml`, and the curated root scripts.
4. Installs the chosen **stack** (see below), `husky` + `@commitlint/*` for
   real, so versions resolve at generation time.

## Stack: two choices asked up front

`mnci2 new` (run bare, or with flags) asks two questions — the linter and the
test runner. Each is stored where every later `mnci2 add` honours it, so the
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
| `python-packages/` | Publishable Python packages (uv/hatch wheels)     | Yes — `uv publish` (Azure Artifacts) |
| `libs/`            | Internal libraries (TS or Python), never published | Never                        |

No custom tags, no stamp file — the directory (and, for npm, the `private` flag)
are the whole model. Publishable Python packages get their own
`python-packages/` dir so the npm `nx release` (`packages/*`) is never entangled
with Python publishing.

Every kind builds to its own Nx-default output location (`apps/<name>/dist`,
`packages/<name>/dist`, ...) — v2 does no post-generation build-output
rewiring for any kind. `mnci2 add` is pure delegation to the official
generators; each one's own default is left exactly as-is.

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
`nx sync`, not by the generators. `mnci2 add` runs `nx sync` for you right
after generation — but references also go stale **any time you hand-edit a
file to add a new cross-project import** later (nothing about that is an
`mnci2 add`, so that step can't catch it). For that case every generated
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

## CI (Azure DevOps only, any agent OS)

The pipeline contains **no bash and no PowerShell**: every step is a built-in
Azure task or a single-line `git`/`npm`/`npx`/`node` command that `cmd.exe`
and `sh` execute identically, so it runs unchanged on Linux, macOS and Windows
agents. The build agent is your choice at `mnci2 new` (`--agent`, default
`ubuntu-latest`): a Microsoft-hosted image (`ubuntu-`/`windows-`/`macos-…`)
becomes `pool.vmImage`, anything else a self-hosted `pool.name`.

Every run (PR and main) first does `nx sync:check` (fails fast and clearly if
the workspace wasn't synced+committed locally — see above), then one
`nx run-many -t lint,test,build`. Pushes to `main` then:

- **Pack all apps** — each app's `package` target zips its build output into
  `dist/drop/<type>-<name>.zip` (e.g. `node-function-app-api.zip`,
  `react-app-web.zip`); the whole `dist/drop` is published as the **`drop`**
  artifact.
- **Tag the run per app** — one build tag per zip, **exactly** `<type>-<name>`
  (derived from the zip filenames, so the tag can never drift from the
  artifact). A classic release/CD pipeline keys its trigger off these.
- **Release — version, tag and publish** — one `npx nx release --yes` for both
  npm (`packages/*`) and Python (`python-packages/*`): version bump from
  conventional commits → `{projectName}@{version}` git tag pushed to `main`
  (tag-only, never a commit) → publish to the feed (npm via `.npmrc`, Python via
  `uv` when an Azure feed is configured). Reuses the base64 `PAT`, decoded to the
  raw token uv needs for the Python publish. Skipped cleanly when there is
  nothing to release.

**npm auth** is the base64 PAT from a **variable group** (`--variable-group`,
default `Build`): the group exposes `$(PAT)`, mapped as `env` on the npm steps
and read by the root `.npmrc`'s `_password` block — the PAT value never lands
in a file. Mark `PAT` secret in Library. No `npmAuthenticate@0` task (it would
overwrite the hand-set password). Two one-time grants are required (project
admin): **Contribute** on the repo for the *Project Collection Build Service*
account (tag push), and **publish** rights on the feed for the PAT's owner.

**The one PAT, two different encodings — read this before wiring a third
protocol.** The same `$(PAT)` variable is base64-encoded throughout — that's
the raw value Azure Artifacts' "Connect to feed" instructions give you. npm's
`.npmrc` `_password` field expects exactly that pre-encoded form, so it's used
as-is. `uv`/pypi basic auth, by contrast, wants the **raw** token — so the
Python publish step in `azurePipelinesYaml` explicitly *decodes* the same
`$(PAT)` (`Buffer.from(process.env.PAT, 'base64').toString()`) before handing
it to `UV_PUBLISH_PASSWORD`. Both are correct for their protocol today, but
it's an easy trap to get backwards: if you ever wire a third registry
protocol, check whether it wants the pre-encoded or the raw form before
assuming either convention.

## Dependency & risk notes

Being upfront about what mnci2 leans on, so it's a conscious trade-off rather
than a surprise:

- **Two unofficial, small-team Nx plugins carry real weight**:
  [`@nxlv/python`](https://github.com/lucasvieirasilva/nx-plugins)
  (every Python kind) and [`oxc-standard`](https://github.com/JohnDeved/ox-standard)
  (the oxlint/oxfmt StandardJS preset) — neither is `@nx`-scoped/officially
  maintained. Azure Function generation deliberately avoids a third: it uses
  the **official** `@nx/node:application` plus a small hand-written Azure
  Functions v4 file overlay (see "How Node apps work" below) instead of a
  third-party Azure Functions plugin — one less unofficial dependency, and no
  generator-level workaround needed. If either of the two remaining plugins
  stalls or breaks compatibility with a future Nx major, that surface needs a
  real maintenance response, not just a version bump.
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
  for `mnci2 add node-function-app`/`python-function-app` generation, since
  neither shells out to the `func` CLI.
- Function-app *deployment* (e.g. `AzureFunctionApp@2`) is not wired into the
  pipeline; the `node-function-app-<name>.zip`/`python-function-app-<name>.zip`
  inside the published `drop` artifact is the deploy input. Deploying it means
  Azure's Oryx build installing real dependencies (`npm install`/`pip install`)
  from the zipped manifest — no `node_modules`/venv is bundled.
- Changelog files are off (unpushable under the tag-only model); the git tag
  history is the changelog for now.
- **A Python project that imports both a private internal lib AND a real
  external PyPI dependency loses the external one.** Verified empirically:
  `@nxlv/python`'s build executor correctly vendors an imported internal lib's
  source into the wheel (`bundleLocalDependencies`) and, on its own, correctly
  keeps a real dependency declared (`Requires-Dist`, pinned) — but combining
  both on the *same* project silently drops the real dependency from the
  built wheel's metadata entirely, so `pip install`ing it doesn't pull the
  real dependency in and the package breaks at import time. This is a
  `@nxlv/python` limitation, not an mnci2 config gap — there is no known
  workaround today beyond keeping the two separate (e.g. re-exporting the
  external usage through the internal lib instead of importing it directly
  in the same project).

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
  passed straight through, same as every other kind) — unlike the old
  function app, nothing needs hand-wiring here.
- `package` (added by `mnci2 add`, not the generator) zips `apps/<name>/dist`
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

## Python (uv + Ruff + pytest via `@nxlv/python`)

Python is the first non-JS language, and follows the same philosophy: the
**industry-standard toolchain**, no per-project boilerplate. On the first
`add python-*` mnci2 installs [`@nxlv/python`](https://github.com/lucasvieirasilva/nx-plugins)
and registers it in `nx.json` with **uv** as the package manager (the
`--preset=ts` repo has no `uv.lock` to auto-detect, so it is set explicitly).
There is **no stack question** — Ruff (lint + format) and pytest are the
standard, so they are always used (`--linter=ruff --unitTestRunner=pytest`,
`hatch` build backend → wheel).

| Kind | Location | Build / deploy |
| ---- | -------- | -------------- |
| `python-app` | `apps/<name>` | `@nxlv/python:build` wheel, zipped into `dist/drop/python-app-<name>.zip` |
| `python-function-app` | `apps/<name>` | Azure Functions **v2** (`function_app.py` + `host.json` + `requirements.txt`); the **source** is zipped into `dist/drop/python-function-app-<name>.zip` (no `func` CLI needed to generate) |
| `python-lib` | `python-packages/<name>` | publishable wheel; a `publish` target (`uv publish`) |
| `python-internal-lib` | `libs/<name>` | private shared code, bundled into consumers' wheels |

- **Apps** get a `package` target that fits the existing CI unchanged — they
  own a `project.json`, so the pipeline's `apps/*` pack step tags them
  `python-app-<name>` / `python-function-app-<name>` just like the TS apps.
- **Release** is unified with npm: `nx release` scopes both `packages/*` and
  `python-packages/*`, so a Python package is **versioned from conventional
  commits and tagged** `{projectName}@{version}` exactly like an npm one — its
  `pyproject.toml` version bumps, tag-only (never a commit). Each project's own
  `versionActions` (the `@nxlv/python` one the plugin stamps) reads/writes the
  right manifest. **Publishing** reuses the registry: an Azure Artifacts feed is
  **multi-protocol**, so the same org/project/feed serves Python — the release
  step exports `UV_PUBLISH_*` (URL + the base64 `PAT` decoded to the raw token
  uv needs, no second secret) and `nx release` publishes the wheels with `uv`.
  (On a public-npm workspace a Python package is still versioned + tagged, but
  publishing it needs user-provided `UV_PUBLISH_*` — e.g. a PyPI token.)
- **CI** also runs `nx run-many -t lint,test,build`, so Python's ruff `lint`
  target runs alongside the JS build even on the oxlint stack (whose
  `npm run lint` only covers JS).
