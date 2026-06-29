# nx-magic

An interactive CLI that creates and **fixes** NX monorepos — Node + TypeScript,
Jest, ESLint, real VSCode `.ts` debugging, and a complete CI pipeline (Azure
DevOps **and/or** GitHub Actions), with near-zero per-project configuration.

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

```sh
nx-magic new [name]     # scaffold a brand-new monorepo (prompts: CI provider, registry, scope, …)
nx-magic add [type]     # internal-lib | publishable-lib | cli-tool | function-app | node-app | react-app | vue-app | svelte-app | nextjs-app
nx-magic doctor [--fix] # detect (and with --fix, repair) tool-owned config drift
nx-magic update         # doctor --fix + re-stamp the template version
```

`new` is fully scriptable: `nx-magic new demo --yes --ci github --registry github-packages --owner acme`.

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

## Developing nx-magic

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
# In VSCode: open demo.code-workspace, set a breakpoint in a *.test.ts, run
# "Debug Jest (current file)" → it should pause on the breakpoint.
```
