<p align="center">
  <img src="../../assets/logo.svg" alt="mnci" width="160">
</p>

# @mnci/eslint-config

> The shared ESLint flat config every `mnci`-generated monorepo uses. **One
> config, at the root, for every language in the workspace.**

## Why this exists

`mnci` generates opinionated monorepos, and linting is one of the opinions. It
used to be delivered badly: `create-nx-workspace`'s bare `@nx/eslint-plugin`
default landed at the root, each `nx g` generator dropped another
`eslint.config.mjs` into its own project, and the richer rules the project
actually wanted lived only in mnci's own repo — never in anything it generated.

This package is that opinion, packaged. A generated workspace gets:

```js
// eslint.config.mjs
import mnci from '@mnci/eslint-config'

export default mnci({ workspaceRoot: import.meta.dirname })
```

…and nothing else. No per-project configs.

Shipping it as a package rather than a template string means an upgrade reaches
existing workspaces through `npm update`, the plugins are _this_ package's
dependencies instead of a dozen devDependencies in every generated workspace,
and the config is independently testable — which it is, against the real
`eslint` binary.

## What it covers

Correctness and code quality only. **Formatting is Prettier's job**, and
`eslint-config-prettier` is composed last to guarantee no rule here fights it.

| Area                 | Plugin                                                     |
| -------------------- | ---------------------------------------------------------- |
| JS/TS correctness    | `@eslint/js`, `typescript-eslint`, `eslint-plugin-unicorn` |
| Node + promises      | `eslint-plugin-n`, `eslint-plugin-promise`                 |
| Unused code          | `eslint-plugin-unused-imports` (auto-removes on `--fix`)   |
| React                | `eslint-plugin-react`, `react-hooks`, `react-refresh`      |
| JSX accessibility    | `eslint-plugin-jsx-a11y` (`recommended`)                   |
| JSON / JSONC / JSON5 | `eslint-plugin-jsonc`                                      |
| YAML                 | `eslint-plugin-yml`                                        |
| Markdown             | `@eslint/markdown`                                         |
| CSS                  | `@eslint/css`                                              |
| HTML                 | `@html-eslint/eslint-plugin` (incl. its a11y rules)        |
| Tests                | `eslint-plugin-jest` + Vitest's `vi`/`vitest` globals      |
| Type-aware TS        | `typescript-eslint` with `projectService` — see below      |
| Import graph         | `eslint-plugin-import-x` — cycles within a project         |

### Type-aware rules (`configs/typeAware.js`)

A small curated set that reads **types**, so it catches what nothing else in the
stack can — most importantly a dropped `await`, which type-checks cleanly, passes
any test that does not happen to race, and then loses an error in production:
`no-floating-promises`, `no-misused-promises`, `await-thenable`,
`no-unnecessary-type-assertion`, `unbound-method`, plus four narrow ones.

Deliberately **not** `recommendedTypeChecked`. Measured against the mnci monorepo
that preset reported 67 problems and most were not bugs — `require-await` fires on
every Nx executor, which must be `async` to satisfy Nx's contract regardless of its
body. The curated set reported 10, all real. A rule nobody can satisfy just teaches
people to reach for `eslint-disable`.

Two things about it are load-bearing:

- **Scoped to `apps/*/src`, `libs/*/src`, `packages/*/src`** — not every `.ts`
  file. A file belonging to no tsconfig is a **fatal parse error**, which
  suppresses every other rule for that file _and_ fails the build. Restricting the
  rules to the directories where generated projects live (all of which get a
  tsconfig) makes that impossible rather than merely unlikely. A stray script at
  the workspace root keeps all the non-type-aware rules instead of breaking.
  `allowDefaultProject` is not used: it is fatal in the other direction too, so a
  glob wide enough to catch real strays breaks properly configured files.
- **`no-misused-promises` exempts JSX attributes, and only those.**
  `onClick={async () => { await save() }}` is the universal React idiom while
  React's prop types declare a void return, so the default setting fails a fresh
  `react-app` on a file the user wrote normally. The sub-check that catches real
  bugs — an async callback passed to `Array.filter` — stays on.

Cost: roughly 5s → 8s on a whole-workspace lint, because it builds a real TS
program. It therefore needs project references in order, which `nx sync:check`
already guarantees in CI before the lint step.

### Import-graph rules (`configs/importGraph.js`)

`no-cycle` and `no-self-import`, scoped to project source. Specifically the
**intra-project** gap: `@nx/enforce-module-boundaries` polices edges _between_
projects, cycles included, but nothing looked inside a project. A cycle among one
project's own modules runs until it doesn't — whichever module evaluates second sees
a half-initialised namespace.

Two things are load-bearing, and both fail _silently_ if changed:

- **`settings['import-x/parsers']` is required for `no-cycle` to do anything at
  all.** `languageOptions.parser` says how to parse the file being linted; it says
  nothing about how import-x parses the files it _follows_. Without the mapping every
  `.ts` dependency is unparseable, traversal stops at depth one, and the rule reports
  nothing — ever. `no-unresolved` does not need it, which is why the gap is easy to
  miss.
- **The TypeScript resolver is not optional.** With import-x's default Node resolver
  this reported 179 errors on the mnci monorepo, all false: Node cannot resolve an
  extensionless relative TypeScript import. `createTypeScriptImportResolver` gets no
  `project` option, so it finds each file's nearest tsconfig itself — a generated
  workspace's tsconfigs cannot be enumerated up front.

**`no-unresolved` is switched off deliberately**, and cannot be enabled in this
layout. A project consumes an internal lib by scoped name (`@scope/core`); npm
workspaces symlinks it, but its manifest points at `./dist`, which does not exist
until that dependency is **built** — and `lint` does not depend on `build`. The `ts`
preset has no tsconfig `paths` to fall back on either. So a completely correct
cross-project import resolves to nothing on disk. `tsc` already reports unresolved
_typed_ imports, and the workspace runs `typecheck` in CI.

### The stylistic exceptions

Prettier covers most of JavaScript Standard Style (no semicolons, single
quotes, 2-space indent, no trailing commas). Three Standard rules sit in
territory Prettier never touches at all, so they live in
`configs/stylistic.js`, composed **after** `eslint-config-prettier` so it
cannot switch them back off:

| Rule                          | Why Prettier can't do it       |
| ----------------------------- | ------------------------------ |
| `spaced-comment`              | never edits comment bodies     |
| `lines-between-class-members` | preserves whatever you wrote   |
| `unicode-bom`                 | passes a BOM through unchanged |

The list was derived by diffing `eslint-config-standard`'s stylistic rules
against `eslint-config-prettier`'s disable list, not by guesswork. That
ordering — stylistic last — is covered by a regression test.

### Why `space-before-function-paren` is not here

It is Standard's signature rule and the obvious omission. It is deliberate.

`eslint-config-prettier` disables that rule because it **conflicts** with
Prettier, not because it is redundant: Prettier emits `function f(a)` and
rewrites `function f (a)` back on every run, while the rule demands the
opposite. Enabling it makes `npm run lint` and `npm run format:check` mutually
unsatisfiable — a real ping-pong, verified by round-tripping a file through
both binaries, not a theoretical concern. Prettier has closed the corresponding
option permanently, so there is no version to wait for.

Choosing Prettier as the formatter means accepting its call here. mnci does,
and a regression test asserts the rule stays off so nobody re-adds it in good
faith later.

## Usage

```js
import mnci from '@mnci/eslint-config'

export default mnci({ workspaceRoot: import.meta.dirname })
```

`workspaceRoot` is optional. Passing it enables the `@nx/dependency-checks`
block for `packages/*` and `libs/*`, which needs to scan for `private: true`
manifests. Omit it in a workspace with no publishable npm packages.

Individual blocks are exported too, if you need to recompose:

```js
import { base, typescript, react, ignores } from '@mnci/eslint-config'
```

## ESLint 9, deliberately

The stack is pinned to ESLint **9**, and `eslint-plugin-unicorn` to **v61**
(the last line supporting it). Not conservatism — the plugins decide:

- `eslint-plugin-react` has no ESLint 10 release. Its latest peer range stops
  at `^9.7`, and on 10 it throws `contextOrFilename.getFilename is not a
function` while loading `react/display-name`, which kills linting for every
  `.tsx` file in the workspace.
- `@nx/react`'s generator pins `eslint-plugin-import@2.31.0`, which caps at 9
  too — on 10 the install fails outright.

Three unicorn rules this config would otherwise switch off —
`name-replacements`, `consistent-boolean-name` and
`no-top-level-assignment-in-function` — do not exist in v61, so they are not
listed: ESLint rejects a config that names a rule its plugin does not have.
`configs/base.js` says which, so a future upgrade re-adds them deliberately
instead of rediscovering why they suddenly fire.

## Notes

- **No build step.** This is plain ESM that consumers load directly. Compiling
  it would only create a way for the published config to drift from the source.
- **`@nx/eslint-plugin` is an optional peer.** Its version has to track the
  workspace's own Nx version, and the `dependency-checks` block is skipped
  entirely when it is absent — so the config still works outside Nx.
- **Tests shell out to the real `eslint` binary.** Asserting on a flat config's
  object shape proves nothing, because a later block can silently disable an
  earlier rule. Every test lints a real fixture and asserts on what was actually
  reported.
