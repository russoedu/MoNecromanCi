# Reusable NX monorepo build templates

A zero-configuration Azure DevOps pipeline for NX monorepos. It detects the
*affected* projects, classifies them from their NX **tags**, then builds + zips +
drops apps and publishes libraries. Versions are managed manually in each
`package.json`. Designed to be copied verbatim into any NX monorepo — the only
per-project input is a tag.

## How a project is classified

Classification is driven entirely by NX tags (set in each `project.json`). Use one
canonical `type:*` tag per project; legacy descriptive tags are still recognised
through the alias table in [`lib/context.mjs`](lib/context.mjs).

| Canonical tag | Category | What the pipeline does when affected |
|---|---|---|
| `type:function-app` | Azure Function app | `nx build` → generate runtime `package.json` (vendoring internal libs) → prod install → zip → drop |
| `type:react-app` | Frontend app | branch-aware build → zip each produced output dir → drop |
| `type:publishable-lib` | npm package | publish at the `package.json` version (skip if already published) → docs |
| `type:internal-lib` | Internal/vendored lib | docs only; vendored into apps that import it |
| `ci:ignore` | Excluded from CI | added *alongside* a `type:*` tag; wins over it for this pipeline (build/test/publish are skipped), but `monecromanci doctor` still classifies the project from its `type:*` tag and keeps its config in sync — `ci:ignore` only opts a project out of CI, never out of doctor |

> Versioning is manual: set the `version` in each project's `package.json`. The
> pipeline never bumps versions, tags, or commits — it just publishes whatever
> version is on disk (and skips versions already on the registry). Apps use their
> `package.json` version for the build number and the function-app runtime manifest.

## Pipeline steps

Each step's logic lives in its `NN-*.mjs` script here; the Azure/GitHub steps
that invoke them live in the single `azure-pipelines.yml` / `ci.yml` entry
file instead of per-stage YAML wrappers.

| Step | File | Responsibility |
|---|---|---|
| 01 | `01-preparation.mjs` | `npm ci` (first), resolve git range + affected set, classify, write `01-preparation.context.json`, print the **execution plan**, emit gating variables |
| 02 | `02-quality-control.mjs` | `nx affected -t lint,test,build`; publish test + coverage |
| 03 | `03-package-apps.mjs` | build/zip/drop affected function apps and React apps |
| 04 | `04-publish-libs.mjs` | publish affected publishable libs at their `package.json` version (master/main, non-PR) |
| 05 | `05-publish-documentation.mjs` | build + upload TypeDoc for affected libs |
| 06 | `06-summary.mjs` | render the markdown build summary (always runs) |

`lib/` holds the shared modules: `_h.mjs` (logging, shelling out, Azure variables,
JSON), `nx.mjs` (local-binary NX wrapper + git base/head), `context.mjs`
(classification + the persisted context model + `selectAffected` filters).

## Key reliability decisions

- **`npm ci` runs before affected detection** so NX computes the project graph with
  the workspace's pinned version. NX is always invoked via the local
  `node_modules/.bin/nx` (never `npx --yes`, which can download a different version).
- **Windows-safe shelling.** Commands are full strings run through the platform
  shell with explicit escaping; git ranges use `~1` (never `^`, a `cmd` escape char);
  zip destinations are passed to PowerShell via an env var to avoid nested quoting.
- **Idempotent publish** — step 04 skips any version already on the registry, so
  re-runs are safe and publishing only happens when you bump a `package.json` version.

## Debugging without a push (run locally after `npm ci`)

- `npm run pipeline:plan` — runs step 01 locally, prints the execution plan and
  writes `01-preparation.context.json`. Use it to confirm classification + affected
  detection before pushing.
- `npm run pipeline:package` — runs step 03 against `./.pipeline-out` (skips the
  registry prod-install) to exercise build/zip/drop with full logs.

## Reusing in another repo

See [`../APPLY.md`](../APPLY.md) for the full guide. In short:

1. Copy `.build-templates/` and `azure-pipelines.yml`.
2. Tag each `project.json` with a `type:*` tag (add `ci:ignore` alongside it to
   keep a project out of CI without opting it out of doctor), and set a real
   `version` in every project's `package.json`.
3. Add `.npmrc` and the pipeline secrets (`NODE_AUTH_TOKEN`, optional `saDevConnectionString`).
