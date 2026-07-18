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
mnci2 add react-app web      # @nx/react (Vite + Jest)
mnci2 add function-app api   # @nxazure/func (TypeScript Azure Functions)
mnci2 add npm-lib sdk        # @nx/js publishable lib -> packages/
mnci2 add internal-lib utils # @nx/js private lib -> libs/
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
4. Installs `husky` + `@commitlint/*` for real, so versions resolve at
   generation time.

## Layout convention = release scoping

| Directory    | Contents                                    | Released?                    |
| ------------ | ------------------------------------------- | ---------------------------- |
| `apps/`      | React apps, Azure Function apps             | Never                        |
| `packages/`  | Publishable npm libraries (rollup-bundled)  | Yes — `nx release`, per-package tags |
| `libs/`      | Internal libraries (buildable, `private`)   | Never                        |

No custom tags, no stamp file — the directory and the npm `private` flag are
the whole model.

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

## CI (Azure DevOps only, ~100 lines, any agent OS)

The pipeline contains **no bash and no PowerShell**: every step is a built-in
Azure task or a single-line `git`/`npm`/`npx`/`node` command that `cmd.exe`
and `sh` execute identically, so it runs unchanged on Linux, macOS and
Windows agents. The two places that would normally need shell logic are
portable instead: a `node -e` one-liner guards the release while `packages/*`
is still empty, and function-app packaging is a plain artifact publish of
`dist/function-apps/` (the esbuild build already emits self-contained
deployable folders).

PRs run `nx affected -t lint,test,build` against the target branch. Pushes to
`main` additionally build all deployables, publish `dist/function-apps/` as
the `function-apps` artifact, and run `nx release --yes`: version bump from
commit messages → tag pushed → publish. Two one-time grants are required
(project admin): **Contribute** on the repo for the *Project Collection Build
Service* account (tag push), and the **Contributor** role on the Artifacts
feed (publish).

## Known gaps (accepted for the experiment)

- No `doctor`/`resurrect`/`spell` — out of scope until the model is proven.
- `add function-app` requires **Azure Functions Core Tools ≥4** on the PATH
  (`npm i -g azure-functions-core-tools@4`) — `@nxazure/func`'s generators
  shell out to the `func` CLI even at generation time. The CLI preflights
  this and tells you what to install.
- Function-app *deployment* (e.g. `AzureFunctionApp@2`) is not wired into the
  pipeline; the published `function-apps` build artifact is the deploy input.
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
- **Convention**: `src/main.ts` is the bundle entry — add one import per
  function file you create under `src/functions/`, or it won't be bundled.
- CI publishes `dist/function-apps/` as the `function-apps` build artifact —
  each subfolder is ready for `AzureFunctionApp@2` or any zip/folder deploy.
