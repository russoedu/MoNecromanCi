<p align="center">
  <img src="../../assets/logo.svg" alt="mnci" width="160">
</p>

# @mnci/eslint-config

> The lint **and** format opinion every `mnci`-generated monorepo uses. **One
> ESLint config, at the root, for every language in the workspace — code
> quality, type-aware rules and JavaScript Standard Style formatting, in one
> tool.**
>
> There is no Prettier and no oxfmt. `eslint --fix` is the formatter, which is
> what makes `space-before-function-paren` — Standard's signature rule —
> enforceable at all: every Prettier-compatible formatter rewrites
> `function f (a)` back to `function f(a)`, so a config that both enabled the
> rule and ran such a formatter was mutually unsatisfiable.

## Why this exists

`mnci` generates opinionated monorepos, and code quality is one of the opinions.
It used to be delivered badly: `create-nx-workspace`'s bare `@nx/eslint-plugin`
default landed at the root, each `nx g` generator dropped another
`eslint.config.mjs` into its own project, and the richer rules the project
actually wanted lived only in mnci's own repo — never in anything it generated.

This package is that opinion, packaged. A generated workspace gets two files:

```js
// eslint.config.mjs
import mnci from '@mnci/eslint-config'

export default mnci({ workspaceRoot: import.meta.dirname })
```

```js
// .prettierrc.mjs
export { default } from '@mnci/eslint-config/prettier'
```

…and nothing else. No per-project configs.

Shipping it as a package rather than as template strings means an upgrade reaches
existing workspaces through `npm update`, the plugins are _this_ package's
dependencies instead of two dozen devDependencies in every generated workspace,
and the config is independently testable — which it is, against the real `eslint`
and `prettier` binaries.

## What it covers

Two halves of one decision, which is why they are one package.

**ESLint here is correctness and code quality only. Prettier owns every
formatting question**, and `eslint-config-prettier` is composed last so no rule
here can fight it. Splitting the two across packages would mean a version pair
free to drift until `npm run lint` and `npm run format:check` contradict each
other; keeping them together makes that impossible rather than merely unlikely.

### The ESLint blocks

Every block carries a `name`, which is how you find it (`eslint --inspect-config`)
and how you override it. The generated `eslint.config.mjs` ships this same table
as a comment, so it is readable without opening node_modules.

| Block name                               | Covers                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `mnci/ignores`                           | paths never linted — `dist`, `coverage`, `.venv`, `__pycache__`, `.dart_tool`                  |
| `mnci/base`                              | JS/TS correctness — `@eslint/js`, `eslint-plugin-unicorn`, `-promise`, `-n`, `-unused-imports` |
| `typescript-eslint/*`                    | `typescript-eslint`'s own recommended blocks (its names, not ours)                             |
| `mnci/typescript`, `…/declarations`      | TS rules on top of them, no type information needed                                            |
| `mnci/type-aware`, `…/declarations`      | the rules that DO read types — see below                                                       |
| `mnci/import-graph`                      | import cycles — `eslint-plugin-import-x`                                                       |
| `mnci/react`                             | JSX/TSX — `@eslint-react/eslint-plugin`, `-react-hooks`, `-react-refresh`, `-jsx-a11y`         |
| `mnci/regexp/recommended`, `mnci/regexp` | regex correctness incl. catastrophic backtracking — `eslint-plugin-regexp`                     |
| `mnci/json`, `mnci/jsonc`, `mnci/json5`  | `eslint-plugin-jsonc` — comments allowed in `.jsonc`/`tsconfig.json`, forbidden in `.json`     |
| `mnci/yaml/recommended/*`, `mnci/yaml`   | `eslint-plugin-yml` — your CI pipeline files                                                   |
| `mnci/toml/base/*`                       | `eslint-plugin-toml` — **parsing only**, see below                                             |
| `mnci/markdown`                          | `@eslint/markdown` (GitHub-flavoured)                                                          |
| `mnci/css`                               | `@eslint/css`                                                                                  |
| `mnci/html`                              | `@html-eslint/eslint-plugin`, incl. its a11y rules                                             |
| `mnci/tests`                             | `*.spec`/`*.test` relaxations — `eslint-plugin-jest`, plus Vitest's `vi`/`vitest` globals      |
| `mnci/nx-dependency-checks`              | `@nx/eslint-plugin` on publishable packages' manifests — only when `workspaceRoot` is passed   |
| `mnci/prettier-compat`                   | `eslint-config-prettier` — switches off every rule Prettier owns. **Composed last.**           |
| `mnci/stylistic`                         | the three Standard rules Prettier does not touch — see below                                   |

`configs/named.js` fills a name in for the blocks upstream presets ship
anonymously, keeping any name upstream does provide. A test resolves the real
config and fails if any block is unnamed or if two share a name; another test, in
`@mnci/cli`, fails if the generated comment and the real config disagree.

### Formatting (`prettier.js`)

JavaScript Standard Style, as Prettier options: `semi: false`,
`singleQuote: true`, `trailingComma: 'none'`, `arrowParens: 'avoid'`,
`printWidth: 100`, `tabWidth: 2`.

Consumed as a shareable config, exactly like the rules:

```js
// .prettierrc.mjs
export { default } from '@mnci/eslint-config/prettier'
```

**`.prettierrc.mjs`, and mnci deletes `.prettierrc` and `.prettierrc.json`.**
Prettier's precedence runs `.prettierrc` → `.prettierrc.json` → … →
`.prettierrc.mjs`, so a leftover file of either earlier kind wins outright and
silently reinstates whatever it says. That is not a hypothetical: mnci wrote
`.prettierrc.json` while `create-nx-workspace` wrote `.prettierrc`, and the
result was that mnci's entire formatting opinion was discarded in every
generated workspace until `prettier.resolveConfig` was used to find out why.

`trailingComma: 'none'` is worth calling out, because getting it wrong is quiet
in both directions: Prettier's own default is `'all'`, and this repo itself
carried `'es5'` in a config it never published — so mnci was formatted against an
opinion it did not ship, across 86 files, and nothing reported it. The Prettier
spec now pins every option by running the real binary against fixtures.

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

### Regex and TOML

**`eslint-plugin-regexp`** runs `flat/recommended` minus four rules. The value is
`no-super-linear-backtracking`: a regex can be perfectly correct and still take
exponential time on a crafted input, which is a real denial of service in anything
matching user data and completely invisible to review. Nothing else here looks
inside a regex.

The four exclusions are a crash, not a preference. `no-legacy-features`,
`no-missing-g-flag`, `no-useless-dollar-replacements` and `no-useless-flag`
opportunistically reach for TypeScript type information and **throw** when the TS
parser is present without type-aware services — which is the normal case for any
`.ts` file outside `{apps,libs,packages}/<name>/src`, since that is the only scope
`configs/typeAware.js` covers. A crash takes down linting for the whole file rather
than reporting one problem. See `configs/regexp.js` for why they are off globally
rather than narrowing the block's scope.

**`eslint-plugin-toml` is `flat/base` — the parser and no style rules.** mnci writes
`pyproject.toml` for every Python project and nothing read those files, so a syntax
error only surfaced later as a confusing hatchling or pip failure. `flat/base` makes
it a fatal parse error instead.

`flat/standard` was measured and rejected: it is almost entirely formatting
(`indent`, `key-spacing`, `quoted-keys`, `array-bracket-spacing`), which is outside
this config's scope — and it reports **six** `toml/array-bracket-spacing` errors on
the `pyproject.toml` that `@mnci/nx-python-pip` itself generates. Every Python
workspace would have failed `npm run lint` on a file the user never wrote. A test
pins the generated content as clean so that cannot be reintroduced.

This does mean TOML _formatting_ is unenforced. Deliberately — Prettier has no TOML
support, and the available alternative measured worse than nothing.

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
// eslint.config.mjs
import mnci from '@mnci/eslint-config'

export default mnci({ workspaceRoot: import.meta.dirname })
```

`workspaceRoot` is optional. Passing it enables the `@nx/dependency-checks`
block for `packages/*` and `libs/*`, which needs to scan for `private: true`
manifests. Omit it in a workspace with no publishable npm packages.

```js
// .prettierrc.mjs
export { default } from '@mnci/eslint-config/prettier'
```

## Overriding a rule

Do this in your own config. **Do not edit this package inside `node_modules`, and
do not fork it** — it is a dependency, so `npm update` carries rule fixes in the
way it carries any other, and an override survives that while an edit does not.

Flat config is order-dependent and later blocks win, so an override is a block
appended after the spread. Name it, so the config inspector shows where the change
came from:

```js
import mnci from '@mnci/eslint-config'

export default [
  ...mnci({ workspaceRoot: import.meta.dirname }),
  {
    name: 'local/legacy-app-allows-any',
    files: ['apps/legacy/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' }
  }
]
```

To find out which block turned a rule on in the first place:

```bash
npx eslint --inspect-config              # every block, by name
npx eslint --print-config path/to/file   # the merged result for one file
```

Individual blocks are exported too, if you need to recompose rather than append:

```js
import { base, typescript, react, ignores } from '@mnci/eslint-config'
```

Prettier options are overridden by spreading rather than re-exporting:

```js
// .prettierrc.mjs
import mnci from '@mnci/eslint-config/prettier'

export default { ...mnci, printWidth: 120 }
```

```bash
npx prettier --find-config-path path/to/file   # which config file applies
```

### One override that cannot work

`space-before-function-paren` — see below. Prettier reverses it on every run, so
switching it on makes `npm run lint` and `npm run format:check` impossible to
satisfy at the same time.

## ESLint 10

The stack is on ESLint **10** and `eslint-plugin-unicorn` **v72**. Getting there
was never about ESLint — it was about two plugins, and both were resolved by
measurement rather than by waiting.

**`eslint-plugin-react` is gone.** React correctness comes from
`@eslint-react/eslint-plugin`, a maintained rewrite whose peer range is
`eslint: "*"`. The incumbent had no ESLint 10 release at all: its peer range
stopped at `^9.7`, and on 10 it threw `contextOrFilename.getFilename is not a
function` while loading `react/display-name`, killing linting for every `.tsx`
file in the workspace.

Hooks stay with `eslint-plugin-react-hooks`. `@eslint-react` reimplements them
and ships a config to switch the React team's plugin off in favour of its own;
this config does the reverse, and switches off the two `@eslint-react` rules
that duplicate it so a single defect is never reported twice.

**`eslint-plugin-jsx-a11y` stays, on a peer override.** Its latest release
(6.10.2) peers at `^3 … ^9`, so `npm install` ERESOLVEs on ESLint 10 — but the
cap is **stale, not a real incompatibility**. Measured on `eslint@10.8.0`: with

```json
"overrides": { "eslint-plugin-jsx-a11y": { "eslint": "$eslint" } }
```

in the **root** manifest (npm ignores `overrides` anywhere else, which is why a
config package cannot fix this for itself and mnci writes it), the plugin
installs and its rules still fire. `mnci` generates that entry; remove it the
moment jsx-a11y ships a release declaring ESLint 10.

**Four unicorn v72 rules are off, and the reasons are counts, not taste.** The
upgrade surfaced 92 problems on this repo and not one was a defect:
`name-replacements` (35), `no-top-level-assignment-in-function` (19) and
`consistent-boolean-name` (13) rename a team's own vocabulary or condemn the
standard per-test fixture idiom — all three were predicted in `configs/base.js`
before they could fire. `no-incorrect-template-string-interpolation` (10) reads
Nx's own `{workspaceRoot}` tokens as forgotten `${...}`, so it cannot be right
about any code that writes Nx config. The remaining 25 findings were **fixed**,
not switched off.

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
- **Tests shell out to the real `eslint` and `prettier` binaries.** Asserting on a
  flat config's object shape proves nothing, because a later block can silently
  disable an earlier rule; asserting on the exported Prettier object proves nothing
  either, because the interesting failure is a config Prettier _finds_ and then
  ignores. Every test runs a real fixture through a real binary and asserts on what
  came back.
- **`prettier` is a dependency here, not a peer.** Unlike `eslint`, nothing in this
  package extends a Prettier plugin or needs to match a consumer's major, and a
  workspace should not have to declare a formatter to be formatted correctly.
