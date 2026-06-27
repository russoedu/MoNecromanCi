# nx-magic

An interactive CLI that creates and **fixes** NX monorepos for Azure DevOps —
Node + TypeScript, Jest, ESLint, VSCode debugging, and a complete Azure pipeline,
with near-zero per-project configuration.

It generates five project kinds and keeps every repo's tool-owned config in sync:

| Kind              | What you get                                                            |
| ----------------- | ----------------------------------------------------------------------- |
| `internal-lib`    | Source-resolved (`main → src/index.ts`) so you step into it while debugging and "find references" works across libs. |
| `publishable-lib` | Published to Azure Artifacts via `nx release`; `dist/package.json` gets **real, resolved dependencies** even though all deps live in the root. |
| `cli-tool`        | A publishable lib that also ships a bundled `bin` (esbuild + shebang).   |
| `function-app`    | Azure Functions v4, `.configurations/{dev,uat,prod}.json`, `clean:config` whitespace-strip, attach-debugging. |
| `react-app`       | Vite with `dev`/`uat`/`prod` builds (`dist-dev`/`dist-uat`/`dist-prod`) and browser debugging. |

## Commands

```sh
nx-magic new [name]     # scaffold a brand-new monorepo (interactive)
nx-magic add [type]     # add internal-lib | publishable-lib | cli-tool | function-app | react-app
nx-magic doctor [--fix] # detect (and with --fix, repair) tool-owned config drift
nx-magic update         # doctor --fix + re-stamp the template version
```

## What's centralised

One root `package.json` holds **all** dependencies. The root owns `nx.json`
(with `nx release`), `tsconfig.base.json`, `tsconfig.jest.json`, a Jest preset
factory, a lighter **non-type-checked** ESLint flat config (standard/no-semi +
@stylistic + unicorn + React + Jest + JSON/JSONC/JSON5 + YAML + Markdown), the
`.code-workspace`, and a vendored `.build-templates/` Azure pipeline. Per-project
config is 2–4 tiny files.

## Debugging (works on the TypeScript, including into libs)

The `.code-workspace` ships **breakpoint-capable** configs (at the workspace top
level, where VSCode actually reads them): "Debug Jest (current file)"
(`--runInBand`, `resolveSourceMapLocations: null`, source maps on), a Function App
attach config (`:9229`), and a React browser config — plus the `Orta.vscode-jest`
extension for per-test Debug lenses.

## Developing nx-magic

```sh
npm install
npm run build      # tsup bundle + copy assets to dist/
npm run lint
npm test
```

### Verify the generated output end-to-end

```sh
node dist/cli.js new demo        # answer the prompts (scope @demo, etc.)
cd demo
npm install
npm run lint && npm test && npm run build
# In VSCode: open demo.code-workspace, set a breakpoint in a *.test.ts, run
# "Debug Jest (current file)" → it should pause on the breakpoint.
npx nx-magic add internal-lib shared
npm run pipeline:package         # local dry-run of the packaging step
```
