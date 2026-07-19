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
| Hand-written Azure Function templates            | `@nxazure/func` generators + executors                       |
| doctor/drift sync of tool-owned files            | Nothing to drift: v2 owns 5 small files, Nx owns the rest    |

## Commands (deliberately just two)

```sh
mnci2 new my-repo            # create a monorepo (prompts scope + registry)
mnci2 new my-repo --yes --registry npm --scope @my

cd my-repo
mnci2 add react-app web         # @nx/react (Vite + Jest)
mnci2 add function-app api      # @nxazure/func (TypeScript Azure Functions)
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
| `apps/`            | React / Azure Function / Python apps              | Never (packed into the drop) |
| `packages/`        | Publishable npm libraries (rollup-bundled)        | Yes — `nx release`, per-package tags |
| `python-packages/` | Publishable Python packages (uv/hatch wheels)     | Yes — `uv publish` (Azure Artifacts) |
| `libs/`            | Internal libraries (TS or Python), never published | Never                        |

No custom tags, no stamp file — the directory (and, for npm, the `private` flag)
are the whole model. Publishable Python packages get their own
`python-packages/` dir so the npm `nx release` (`packages/*`) is never entangled
with Python publishing.

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

Cross-project imports (`@scope/lib`) resolve through **TypeScript project
references** under `--preset=ts`, and those references are maintained by
`nx sync`, not by the generators. So `mnci2 add` runs `nx sync` for you after
each project — without it the references are stale and your editor cannot
autocomplete a lib you just added (you would have to run `npx nx sync` by
hand). A brand-new package may still need one VSCode window reload to be
picked up by the TypeScript server.

## CI (Azure DevOps only, any agent OS)

The pipeline contains **no bash and no PowerShell**: every step is a built-in
Azure task or a single-line `git`/`npm`/`npx`/`node` command that `cmd.exe`
and `sh` execute identically, so it runs unchanged on Linux, macOS and Windows
agents. The build agent is your choice at `mnci2 new` (`--agent`, default
`ubuntu-latest`): a Microsoft-hosted image (`ubuntu-`/`windows-`/`macos-…`)
becomes `pool.vmImage`, anything else a self-hosted `pool.name`.

Every run (PR and main) does one `nx run-many -t lint,test,build`. Pushes to
`main` then:

- **Pack all apps** — each app's `package` target zips its build output into
  `dist/drop/<type>-<name>.zip` (e.g. `function-app-api.zip`,
  `react-app-web.zip`); the whole `dist/drop` is published as the **`drop`**
  artifact.
- **Tag the run per app** — one build tag per zip, **exactly** `<type>-<name>`
  (derived from the zip filenames, so the tag can never drift from the
  artifact). A classic release/CD pipeline keys its trigger off these.
- **Publish packages + tag main** — `npx nx release --yes`: version bump from
  conventional commits → git tag pushed to `main` (tag-only, never a commit) →
  publish to the feed.
- **Publish Python packages** (Azure Artifacts only) — a guarded
  `nx run-many -t publish --projects=python-packages/*` (`uv publish`), skipped
  when there are none. Reuses the base64 `PAT`, decoded to the raw token uv
  needs.

**npm auth** is the base64 PAT from a **variable group** (`--variable-group`,
default `Build`): the group exposes `$(PAT)`, mapped as `env` on the npm steps
and read by the root `.npmrc`'s `_password` block — the PAT value never lands
in a file. Mark `PAT` secret in Library. No `npmAuthenticate@0` task (it would
overwrite the hand-set password). Two one-time grants are required (project
admin): **Contribute** on the repo for the *Project Collection Build Service*
account (tag push), and **publish** rights on the feed for the PAT's owner.

## Known gaps (accepted for the experiment)

- No `doctor`/`resurrect`/`spell` — out of scope until the model is proven.
- `add function-app` requires **Azure Functions Core Tools ≥4** on the PATH
  (`npm i -g azure-functions-core-tools@4`) — `@nxazure/func`'s generators
  shell out to the `func` CLI even at generation time. The CLI preflights
  this and tells you what to install.
- Function-app *deployment* (e.g. `AzureFunctionApp@2`) is not wired into the
  pipeline; the `function-app-<name>.zip` inside the published `drop` artifact
  is the deploy input.
- Changelog files are off (unpushable under the tag-only model); the git tag
  history is the changelog for now.

## How function apps work (plugin generators + esbuild single-file bundle)

A function app is just a Node.js app packed with `package.json` + `host.json`.
`@nxazure/func`'s **generators** work on Nx 23 and are what `add function-app`
uses; its **executors** (`build`/`start`/`publish`) all share a broken code
path on Nx 23 workspaces (their `prepare-build.js` mixes a relative
`rootDir: '.'` into absolute-resolved compiler options — "Paths must either
both be absolute or both be relative"), so v2 rewires the generated app to
the official `@nx/esbuild` executor instead:

- `build` = `@nx/esbuild:esbuild` emitting ONE self-contained CJS bundle to
  `dist/function-apps/<name>/main.cjs` — every dependency, `@azure/functions`
  and private internal libs included, is compiled in. The only external is
  `@azure/functions-core`, a virtual module the Functions host injects at run
  time. `host.json` + `package.json` (`main: "main.cjs"`) are copied in as
  assets, so the output folder IS the deployable — no `npm install`, ever.
- `start` = `func start` run inside `dist/function-apps/<name>` (after build)
  for local development.
- `test` = a self-contained `jest` run (the app's own `jest.config.mjs` +
  `tsconfig.spec.json`, ts-jest transform). The plugin-generated kinds get
  jest from their `--unitTestRunner=jest` generator; a hand-rewired function
  app has none, so v2 wires it — plus a dependency-free sample spec so
  `nx test <name>` passes out of the box.
- The manifest gets a real name (the generator leaves it empty, corrupting
  npm workspaces), `private: true`, and `@azure/functions` as a dependency.
- `package` = zip the bundle folder into `dist/drop/function-app-<name>.zip`
  (adm-zip, cross-platform) — the CI `drop` artifact, ready for
  `AzureFunctionApp@2` or any zip deploy.
- **Convention**: `src/main.ts` is the bundle entry — add one import per
  function file you create under `src/functions/`, or it won't be bundled.

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
  own compiled-in config. The default inferred `build` (single build) stays for
  local dev and the CI verify step.
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
- **Publishing** reuses the registry: an Azure Artifacts feed is
  **multi-protocol**, so the same org/project/feed serves Python. A guarded,
  main-only CI step runs `nx run-many -t publish --projects=python-packages/*`
  with `UV_PUBLISH_URL` + credentials from env. Auth reuses the base64 `PAT`
  variable, base64-decoded to the raw token uv/pypi need — no second secret.
  (Public-npm workspaces don't wire Python publishing; that would be a PyPI
  token. Conventional-commit auto-versioning of Python packages is a follow-up —
  this cut publishes the `pyproject.toml` version.)
- **CI** also runs `nx run-many -t lint,test,build`, so Python's ruff `lint`
  target runs alongside the JS build even on the oxlint stack (whose
  `npm run lint` only covers JS).
