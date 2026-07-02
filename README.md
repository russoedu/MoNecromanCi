# MoNecromanCI

> **MO**no(repo) + **NECROMAN**cy + **CI**. The CLI command is `monecromanci` (short alias `mnci`).

An interactive CLI that **summons**, **conjures**, **raises** and **validates** NX
monorepos — Node + TypeScript, Jest, ESLint, real VSCode `.ts` debugging, and a
complete CI pipeline (Azure DevOps **and/or** GitHub Actions), with near-zero
per-project configuration.

It generates nine project kinds and keeps every repo's tool-owned config in sync:

| Kind              | What you get                                                            |
| ----------------- | ----------------------------------------------------------------------- |
| `internal-lib`    | Source-resolved (`main → src/index.ts`) so you step into it while debugging and "find references" works across libs. |
| `publishable-lib` | Published via `nx release`; `dist/package.json` gets **real, resolved dependencies** even though all deps live in the root. |
| `cli-tool`        | A publishable lib that also ships a bundled `bin` (esbuild + shebang).   |
| `function-app`    | Azure Functions v4, `.configurations/{dev,uat,prod}.json`, `clean:config` whitespace-strip, attach-debugging. |
| `node-app`        | A framework-agnostic TS HTTP server (node:http) you extend with Express/Koa/Fastify/Nest/…; built, dependency-traced and zipped like a function app. |
| `react-app`       | Vite with `dev`/`uat`/`prod` builds (`dist-dev`/`dist-uat`/`dist-prod`) and browser debugging. |
| `vue-app`         | Vue 3 + Vite, same multi-env builds.                                    |
| `svelte-app`      | Svelte 5 + Vite, same multi-env builds.                                 |
| `nextjs-app`      | Full-stack Next.js (App Router). Per-env builds assemble `dist-<env>` in **server** (standalone) or **static-export** mode (`NEXT_OUTPUT`). |

## Commands

Run it **bare** to get the interactive menu — every command, one arrow-key pick away:

```sh
monecromanci        # or mnci — choose Summon, Conjure, Resurrect, Raise, Ascend or Ritual interactively
```

Every command also keeps its plain name and gains a necromancy-themed alias (in the
comment below) — use whichever reads better to you:

```sh
monecromanci new [name]       # summon    · scaffold a brand-new monorepo (prompts: CI provider, registry, scope, …)
monecromanci add [type]       # conjure   · internal-lib | publishable-lib | cli-tool | function-app | node-app | react-app | vue-app | svelte-app | nextjs-app
monecromanci resurrect        # adopt     · adopt an existing monorepo: detect its projects and apply the canonical config
monecromanci doctor [--fix]   # raise/fix · detect (and with --fix, repair) tool-owned config drift
monecromanci update           # ascend    · doctor --fix + re-stamp the template version
monecromanci validate [--all] # ritual    · run lint/test/build locally (nx affected; --all = run-many) before pushing to CI
```

`new` is fully scriptable: `monecromanci new demo --yes --ci github --registry github-packages --owner acme`.

## Resurrect an existing monorepo

`resurrect` brings a repo that wasn't born from MoNecromanCI under management.
It scans `apps/` and `libs/`, guesses each project's kind from its files and
dependencies (host.json, next/vue/svelte/react deps, `bin` entries,
`publishConfig`, …) and **asks you to confirm every guess** — the signals help,
but you decide. After a hard are-you-sure confirmation it shows a checkbox list
of the confirmed projects (`a` selects all, `i` inverts, space toggles one),
then applies the canonical tool-owned config to the root and each selected
project, merges missing `scripts`/`workspaces`/`engines` into your manifests
(drifted scripts are reported, never overwritten), and pins the toolchain
versions the generated ESLint config requires. **Your source code is never
touched** — no sample files are planted. Projects you leave unselected stay
unmanaged and are offered again the next time you run `resurrect`; repo-level
prompts pre-fill from what it detects (CI files, registry URLs, scope,
`engines.node`, git default branch).

## CI providers & registry (chosen per repo)

`new` prompts for a **CI provider** — `azure`, `github`, or `both` — and a **package
registry** — Azure Artifacts, GitHub Packages, or public npm (defaulting to match
the CI). The `.build-templates/*.mjs` are the single engine for **both** providers;
only a thin wrapper differs: `azure-pipelines.yml` and/or `.github/workflows/ci.yml`.
The `.npmrc`, each publishable project's `publishConfig`, and the nx-release docs
are generated to match the registry.

## What's centralised

One root `package.json` holds **all** dependencies. The root owns `nx.json`
(with `nx release`), `tsconfig.base.json`, `tsconfig.jest.json`, a Jest preset
factory, a **non-type-checked** ESLint flat config (standard/no-semi + @stylistic
+ unicorn + React + Jest + TSDoc + JSON/JSONC/JSON5 + YAML + Markdown), the
`.code-workspace`, and a vendored CI pipeline. Per-project config is 2–4 tiny files.

## Debugging (works on the TypeScript, including into libs)

The `.code-workspace` ships **breakpoint-capable** configs at the workspace top
level (where VSCode actually reads them): "Debug Jest (current file)"
(`--runInBand`, `resolveSourceMapLocations: null`, source maps on), a Function/Node
App attach config (`:9229`), and browser configs for Vite (`:5173`) and Next.js
(`:3000`) — plus the `Orta.vscode-jest` extension for per-test Debug lenses.

## Developing MoNecromanCI

```sh
npm install --legacy-peer-deps   # ESLint 10 leads some plugins' peer ranges
npm run build                    # tsup bundle + copy assets to dist/
npm run lint
npm test
```

### Verify the generated output end-to-end

```sh
node dist/cli.js new demo --yes --registry npm --lib helpers
cd demo
node ../dist/cli.js add nextjs-app web   # or any other kind
npm install
npm run lint && npm test && npm run build
node ../dist/cli.js validate             # (ritual) nx affected -t lint test build
# In VSCode: open demo.code-workspace, set a breakpoint in a *.test.ts, run
# "Debug Jest (current file)" → it should pause on the breakpoint.
```
