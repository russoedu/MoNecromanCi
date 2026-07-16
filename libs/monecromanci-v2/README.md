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

Everything else is plain Nx: `nx serve web`, `nx run-many -t lint,test,build`,
`nx release --dry-run`, `nx graph`.

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
   `commit-msg` hook, and `azure-pipelines.yml`.
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

## CI (Azure DevOps only, ~60 lines)

PRs run `nx affected -t lint,test,build`. Pushes to `main` additionally run
`nx release --yes`: version bump from commit messages → tag pushed → publish.
Two one-time grants are required (project admin): **Contribute** on the repo
for the *Project Collection Build Service* account (tag push), and the
**Contributor** role on the Artifacts feed (publish).

## Known gaps (accepted for the experiment)

- No `doctor`/`resurrect`/`spell` — out of scope until the model is proven.
- `add function-app` requires **Azure Functions Core Tools ≥4** on the PATH
  (`npm i -g azure-functions-core-tools@4`) — `@nxazure/func`'s generators
  shell out to the `func` CLI even at generation time. The CLI preflights
  this and tells you what to install.
- `@nxazure/func@2.1.0` peers on `@nx/js@^22` while fresh workspaces get
  Nx 23: installation works (the generated `.npmrc` carries
  `legacy-peer-deps=true`) and **generation works**, but its `build` executor
  currently fails against Nx 23 TS-solution workspaces ("Paths must either
  both be absolute or both be relative"). Tracked as a PENDING e2e check —
  promote to enforced when the plugin catches up with Nx 23.
- Function-app *deployment* is not in the pipeline; `nx run <app>:publish`
  (via `@nxazure/func`) is the manual follow-up.
- Changelog files are off (unpushable under the tag-only model); the git tag
  history is the changelog for now.
