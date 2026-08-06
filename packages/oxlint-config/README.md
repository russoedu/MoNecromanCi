<p align="center">
  <img src="../../assets/logo.svg" alt="mnci" width="160">
</p>

# @mnci/oxlint-config

> The same lint and style opinion as [`@mnci/eslint-config`](../eslint-config),
> on the Rust toolchain. **oxlint + oxfmt, one root config, and a promise:
> anything the ESLint stack accepts passes here too.**

## The promise, and its direction

**Anything `@mnci/eslint-config` accepts must pass `oxlint`.** That is the
contract, and the direction is the whole point:

- This config is allowed to be more **permissive**. It unavoidably is — 246 of
  the ESLint config's rules have no oxlint implementation.
- It is never allowed to be **stricter**, because that is the case where a
  codebase which lints clean today starts failing tomorrow, on files nobody
  touched.

Verified the strongest way available: `oxlint` with this config reports **0
findings** across `packages/` in the mnci monorepo, which is ESLint-clean —
every path the ESLint `lint` targets cover, e2e scripts included. (The first
measurement of this covered `packages/*/src` only and quietly missed
`packages/cli/e2e`, which turned up a third divergence. Measure the paths CI
actually lints.)
`tests/parity.spec.ts` pins it on fixtures, every one of them a pattern that has
actually broken a generated workspace's lint at some point in this project's
history.

## What that cost, honestly

Literal rule parity is **not** achievable, and saying otherwise would be the kind
of claim this project has been burned by before. Measured against the ESLint
config's resolved rules for a project `.ts`:

|                                  | Rules   |
| -------------------------------- | ------- |
| Enabled by `@mnci/eslint-config` | 452     |
| oxlint implements natively       | 206     |
| **Absent from oxlint**           | **246** |

The 246 break down as 169 `unicorn`, 56 `regexp`, and a tail of `yml`, `tsdoc`,
`@stylistic` and `n`.

### How most of the gap is closed anyway

**oxlint's `jsPlugins` runs real ESLint plugins**, so `unicorn` and `regexp` are
not reimplementations here — they are `eslint-plugin-unicorn` and
`eslint-plugin-regexp` themselves, at the **same versions** `@mnci/eslint-config`
depends on. That closes 225 of the 246, and closes them exactly rather than
approximately.

oxlint's own partial `unicorn` port is deliberately **off**: running both would
report one defect twice under two different names, and would apply a rule set 169
rules short of the one the ESLint stack uses.

Costs, stated rather than buried:

- **The bridge is alpha**, explicitly outside semver per oxlint's docs.
- **It boots Node and loads the plugins**: ~2.1s versus ~0.07s for the native path
  alone on this repo's CLI source. Still roughly 3x faster than the ESLint run it
  replaces, but "instant" stops being true.

### What genuinely cannot be carried over

**oxlint only parses JS/TS/JSX/Vue.** A JS plugin can supply rules but not a
_language_, so these have no oxlint story at all — verified, not assumed
(`eslint-plugin-yml` loads through the bridge and then exposes no rules, and
oxlint would not parse a `.yaml` file even if it did):

| Not linted            | Covered by `@mnci/eslint-config` via                   |
| --------------------- | ------------------------------------------------------ |
| YAML                  | `eslint-plugin-yml` — including your CI pipeline files |
| TOML                  | `eslint-plugin-toml` — `pyproject.toml` syntax errors  |
| Markdown, CSS, HTML   | `@eslint/markdown`, `@eslint/css`, `@html-eslint`      |
| JSON / JSONC          | `eslint-plugin-jsonc`                                  |
| Publishable manifests | `@nx/dependency-checks`                                |
| TSDoc                 | `eslint-plugin-tsdoc`                                  |

**oxfmt still formats JSON, YAML, Markdown and CSS** — it just does not lint
them. If YAML correctness matters to you (a duplicate key silently changes a
build), keep `@mnci/eslint-config` for those file types and use this package for
JS/TS.

### Three measured divergences

All are rules switched **off** with the evidence attached in
`configs/divergences.js`, each a different failure mode:

| Rule                                  | What differs                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `unicorn/consistent-function-scoping` | whole-rule behaviour; only reproduces on a large real file                              |
| `unicorn/no-array-sort`               | an **option** (`allowExpressionStatement`) ESLint honours and the bridge appears not to |
| `unicorn/prefer-blob-reading-methods` | a plain **false positive** — flags `AdmZip#readAsText`, unrelated to `FileReader`       |

The second is the most dangerous kind: a rule whose options do not apply is
stricter than configured _everywhere_ it runs. The third generalises — a rule that
wants type information and does not get it is not merely less useful, it is
**wrong**, and a class of `unicorn` rules is in that position under the bridge.

### Type-aware rules are opt-in, and that is a correctness decision

`mnci({ typeAware: true })` adds them. Off by default because measured on this
ESLint-clean repo they report **8 findings** — five `no-unnecessary-type-assertion`
on casts ESLint accepts (its type-aware block resolves a different tsconfig for
spec files, which `tsconfig.lib.json` excludes), two bridged `unicorn` rules, and
one `tsconfig-error`. All stricter than the ESLint stack, which is the one thing
this package promises not to be. So the promise holds for the default
configuration, and the stricter mode is a conscious opt-in with a known cost.

## Usage

`oxlint.config.ts`, which is the **only** shareable-config route oxlint offers:

```ts
import { defineConfig } from 'oxlint'
import mnci from '@mnci/oxlint-config'

export default defineConfig({ extends: [mnci()] })
```

`.oxlintrc.json` **cannot** do this. Its `extends` takes _paths_, resolved
relative to the config file, so `extends: ["@mnci/oxlint-config"]` fails with
`No such file or directory` — oxlint looks for `./@mnci/oxlint-config`. Verified
both ways.

```jsonc
// .oxfmtrc.json — formatting, migrated from the same Standard opinion
{
  "semi": false,
  "singleQuote": true,
  "trailingComma": "none",
  "arrowParens": "avoid",
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false
}
```

Or import it, so the two cannot drift:

```js
// oxfmt.config.js
export { default } from '@mnci/oxlint-config/oxfmt'
```

### Type-aware rules need a flag

```bash
oxlint --type-aware        # no-floating-promises and friends
```

Without it those rules are **inert** — they are listed but do nothing, so a
workspace that forgets the flag silently loses the most valuable rule in the set.
`oxlint-tsgolint` is a dependency of this package so the flag works out of the
box; without it oxlint fails loudly with `Failed to find tsgolint executable`,
which is at least better than failing quietly.

## Formatting: oxfmt, not Prettier

Same seven options as `@mnci/eslint-config/prettier`, because it is the same
opinion. oxfmt names each one identically to Prettier and even offers
`oxfmt --migrate=prettier`.

**Verified as a replacement rather than assumed to be one:** byte-identical output
to Prettier on `.json`, `.yaml`, `.md`, `.css` and `.ts` samples, and on 61 of
this repo's real already-Prettier-formatted files it diverged on exactly **one** —
how a multi-line union after `as` is broken, where oxfmt uses the leading-`|` form
and Prettier wraps inline. Switching formatters reformats that pattern; that is
the honest cost, not a reason to avoid the swap.

**It also formats `.toml`, which Prettier cannot** — `prettier` on a `.toml` exits
with `No parser could be inferred for file`. That is the one file type where the
two differ in what they can parse at all, and it closes the gap
`@mnci/eslint-config`'s parser-only TOML block documents as unenforceable.

Speed is the other reason to make the swap, stated at the scale it actually holds:
**46ms against ~1.5s on a single file**, and **2.3s against 14.6s** checking this
whole monorepo — about 6x, not the ~30x the per-file figure implies. Prefer the
whole-repo number when deciding; it is the one a contributor waits on.

`tests/oxfmt.spec.ts` diffs the two binaries on every fixture, and asserts this
package's option set `toEqual` the ESLint package's — so the two halves of the
project cannot drift into disagreeing.

`space-before-function-paren` still cannot be enforced, for exactly the reason the
sibling package documents: oxfmt emits `function f(a)` like Prettier, so a rule
demanding `function f (a)` makes lint and format mutually unsatisfiable.

## Which package should I use?

|                                 | `@mnci/eslint-config` | `@mnci/oxlint-config`          |
| ------------------------------- | --------------------- | ------------------------------ |
| JS/TS correctness               | 452 rules             | 206 native + 225 bridged       |
| YAML/TOML/MD/CSS/HTML/JSON lint | yes                   | **no**                         |
| Type-aware rules                | yes                   | opt-in, not yet at parity      |
| Formatting                      | Prettier              | oxfmt                          |
| Formats `.toml`                 | **no** (no parser)    | yes                            |
| Whole-repo format check         | 14.6s                 | **2.3s**                       |
| Whole-repo lint, this monorepo  | ~6s                   | ~2s                            |
| Maturity                        | stable                | oxfmt pre-1.0, JS bridge alpha |

Use the ESLint one when coverage matters more than speed, this one when the
reverse holds. They are not mutually exclusive — running oxlint locally for the
fast feedback loop and ESLint in CI for full coverage is a coherent setup, and the
parity promise is what makes it safe.

## Notes

- **No build step.** Plain ESM that oxlint loads directly, same as the sibling
  package. A build would only create a way for the published config to drift.
- **`oxlint` is a peer**, not a dependency: its version has to be the workspace's.
- **`configs/leaks.js` is not cruft.** oxlint enables a plugin's whole rule set
  the moment the plugin is listed — and enables `unicorn`, `typescript` and `oxc`
  even when they are _not_. Those 111 `off` entries are what keeps the rule set
  equal to the ESLint config's instead of a superset of it. Adding a rule to
  `@mnci/eslint-config` means **removing** its entry there.
