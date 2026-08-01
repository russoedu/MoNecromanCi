# MoNecromanCI — Roadmap

Open work, grouped by theme. Each item states **what**, **why it matters**, the
**files** it touches, and **how to verify** it — so any of them can be picked up
without re-deriving the context first.

Ordering principle: items that close a gap between what the project _claims_ and
what it _does_ come before new capability. Several entries below were found by
running the real CLI and reading the real config rather than from the docs, and
those cite `file:line` so the claim can be re-checked.

**Done so far:** #1 (publish auth), #2 (`format:check` in CI), #4 (npm cache),
#6 (superseded-run handling), #8 (`react-lib`), #14 (dots in names),
#17 (`mnci upgrade`'s defects), #18 (`typecheck` in CI), #3 (`mnci doctor`),
#16 (registry resolution verified) — every P1 and P2 except #5 is closed.
**Next up:** #5 (`nx affected` for PR runs) wants care: a misconfigured affected
computation makes PR CI pass while broken, which is a silently weakened gate rather
than a visible failure, so it needs verifying across real pushes rather than
locally.

---

## 1. Promises the project doesn't currently keep

### 1. Wire publish authentication — ✅ done

The generated `.npmrc` was comments-only, so `npm publish` never authenticated in
any generated workspace while the CI dutifully exported a token nothing consumed.
The headline release feature stopped one step short.

The blocker was never difficulty — it was the scope-routing decision, because the
wrong choice is **worse than the empty file**: a half-wired `.npmrc` looks like
protection while providing none, which is the exact mistake this file's own
history records. So the two registry kinds get deliberately different files.

**`azure-artifacts`: scope routing plus feed credentials.** `@<scope>:registry`
sends both resolution and `npm publish` of `@<scope>/*` to the feed, because npm
prefers a scope's registry over the global one when publishing a scoped package.
That is real protection — `@<scope>/*` cannot reach npmjs.org by accident.

**`npm`: the auth line only, no routing.** npmjs.org is already the default, so
routing the scope there changes nothing, and presenting it as accidental-publish
protection would be false — the public registry _is_ the target. The generated
file says so, rather than carrying a line that looks protective.

Only the scope is routed, never a global `registry=`, so `npm ci` does not need
feed auth to fetch public packages.

Verified against real registries rather than from docs, which mattered because the
whole decision rests on npm's publish-registry resolution order:

- With only `@demo:registry` set, a real `npm publish` reported
  `Publishing to http://localhost:4873/` and the package landed in Verdaccio —
  not npmjs.org. That is the protection claim, proven.
- A generated `azure-artifacts` workspace's `npm publish --dry-run` reported
  `Publishing to https://pkgs.dev.azure.com/.../myfeed/npm/registry/`, while
  `npm config get registry` stayed `https://registry.npmjs.org/`.
- With `PAT` unset, `npm install` of a public dependency still succeeded — so an
  unresolved env var breaks nothing locally and no token is needed for daily work.

Not verified, and deliberately not attempted: a real publish to npmjs.org from the
`npm` variant. That would be an actual public release of a throwaway package. Its
correctness rests on the token line being read (confirmed) and npmjs.org being the
resolved target (confirmed).

### 2. Enforce Prettier somewhere automatic — ✅ done

Formatting used to be enforced **nowhere**: `format:check` existed only as a root
script, absent from both pipelines, and the overlay wrote only a `commit-msg`
hook. So mnci deleted Nx's `.prettierrc` specifically to make its own formatting
opinion take effect, then never checked that it held.

`npm run format:check` is now a step in both generated pipelines (and in this
repo's own workflow), placed after `Lint` and before the `run-many`. ESLint here
is correctness-only — `eslint-config-prettier` is composed last in
`@mnci/eslint-config` — so it reports nothing whatsoever about formatting, which
is why Prettier needs a gate of its own rather than riding along with lint.

Verified against a real generated workspace: clean immediately after `mnci new`,
still clean after adding `npm-lib`, `internal-lib` and `react-app` (the
generators emit semicolons and double quotes; `runPrettier()` normalises them),
exits non-zero on a deliberately mis-formatted file, and green again after
`npm run format`.

Still open, deliberately deferred: a `pre-commit` hook running Prettier over
staged files. CI is the gate that matters; a local hook is convenience on top.

### 3. `mnci doctor` — ✅ done

Previously parked as "out of scope until the model is proven". This session proved
it twice: the ESLint drift in #82 was a documented invariant that silently did not
hold, and the `mnci upgrade` defects in #17 shipped past a type error TypeScript had
already flagged.

`mnci doctor` is **read-only** — it never edits the workspace — and every failing
finding names the command that fixes it, usually `mnci upgrade`. It exits non-zero
when anything failed, so it works as a CI step as well as a local command.

Eight checks, each corresponding to an invariant that has **actually** been
violated in this repo or a workspace it generated. That is the bar for adding one:
a check nobody has ever needed is noise that trains people to ignore the output.

| Check                                  | Why it exists                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Exactly one root ESLint config         | The config fragmented twice: every `@nx/*` generator writes one                                                                       |
| No per-project ESLint configs          | Same, from the other direction — each project lints against whichever config sits nearest                                             |
| No stray `.prettierrc`                 | Invisible failure: it outranks `.prettierrc.json`, so the whole formatting opinion is discarded while both files look fine            |
| `@nx/eslint/plugin` registered         | Without it `npm run lint` exits 0 while linting nothing — a green check proving nothing                                               |
| Resolved `eslint` major                | The #82 bug exactly: manifests declared `^10` while the docs said 9, and only the **installed** version revealed it                   |
| `.npmrc` matches the recorded registry | Meaningful now that #1 landed: the two registry kinds get different files, and an Azure workspace additionally needs its scope routed |
| `versionActions` overrides             | Highest blast radius — its absence aborts `nx release` for the **entire** workspace, not the offending project                        |
| `nx sync:check`                        | The one check that shells out, because only Nx can answer it                                                                          |

Verified against real workspaces rather than fixtures alone. On a real generated
workspace it found a genuine drift — an `.npmrc` predating #1, so publishing could
not authenticate — reported `run \`mnci upgrade\``, and passed all eight after that
upgrade was applied. Exit codes confirmed 1 then 0. An `azure-artifacts`workspace
exercises the scope-routing branch instead, and planted faults (a per-project
config, a stray`.prettierrc`) are both caught with their remedies.

---

## 2. CI that "just works"

Four cheap wins, all originally verified absent:

| Item                                | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | P   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 4. ~~`cache: npm` on `setup-node`~~ | ✅ done — both providers now cache npm downloads keyed on the lockfile. GitHub uses `setup-node`'s own `cache: npm`; Azure has no equivalent, so it gets the documented `Cache@2` pattern plus `npm_config_cache` relocating the cache into the pipeline workspace (the default `~/.npm` is outside the cacheable area). `Agent.OS` is in the key because a cached native module built for one OS is not reusable on another                                                                                                                               | —   |
| 5. Use `nx affected` for PR runs    | The `affected` root script exists (`overlay.ts:635`) but CI runs `run-many` over everything on every PR — arguably the whole point of Nx on a monorepo. Needs `nrwl/nx-set-shas` for base/head SHAs                                                                                                                                                                                                                                                                                                                                                        | P2  |
| 6. ~~`concurrency` group~~          | ✅ done — GitHub gets a concurrency group whose `cancel-in-progress` is an **expression**, not a flat `true`: a superseded PR run is cancelled, but a run on `main` queues instead, because cancelling one part-way can leave a release tag pushed with the publish half done, which no rerun repairs. Azure gets `batch: true` on the main trigger (its nearest YAML equivalent, and it also stops two `nx release` runs racing for a tag); PR-run cancellation there is a branch-policy setting with no YAML form, so it is documented rather than faked | —   |
| 7. Deploy stage                     | The drop zip is currently the handoff; an optional per-kind deploy would close the loop (see also §6)                                                                                                                                                                                                                                                                                                                                                                                                                                                      | P3  |

---

## 3. More project kinds

The two real holes first.

### 8. `react-lib` — ✅ done

There was no React library kind at all, so a shared component library could not
be built: `npm-lib` and `internal-lib` are both `@nx/js`, with no JSX support.

Two kinds now, following the family convention every other language already uses
(`python-lib`/`python-internal-lib`, `go-lib`/`go-internal-lib`, …):
**`react-lib`** (publishable → `packages/`) and **`react-internal-lib`**
(private → `libs/`), both delegating to `@nx/react:library --bundler=rollup`.

`rollup` rather than the generator's own `none` default is load-bearing twice
over: it is what lets a published package compile a private internal lib _into_
its bundle without the private name reaching the published manifest, and it keeps
the internal kind **buildable**, which `@nx/enforce-module-boundaries` requires
before any publishable lib may import it. (`tsc` is not an option here — this
generator's enum is `none | vite | rollup`.)

**Two real defects surfaced while verifying, both fixed:**

1. `@nx/react:library --bundler=rollup` writes `types: './dist/index.esm.d.ts'`
   while its build emits `dist/index.d.ts`. The referenced file never exists, so
   every consumer failed with `TS7016: Could not find a declaration file` — a
   React lib was unusable as a typed dependency. `repairTypesPath` repoints both
   the `types` field and `exports['.'].types`, guarded on the exact wrong value so
   an upstream fix is not overwritten. Same class as the `node-function-app`
   manifest `main` bug.
2. The rollup config the generator writes contains `url({ limit: 10000 })`, which
   tripped `unicorn/numeric-separators-style`, so a freshly added React lib failed
   `npm run lint` on a file the user never touched. That rule is now off in
   `@mnci/eslint-config` — it is pure formatting (outside this config's
   correctness-only scope, and Prettier does not rewrite numeric separators) and
   not a Standard rule, so the same "not earning its keep" test two other unicorn
   rules are already off for.

Verified on a real workspace: `lint,typecheck,test,build` green across six
projects in four languages, with a publishable `react-lib` importing a private
`react-internal-lib` through a real JSX component — the private component
**inlined** into the published bundle, and `@demo/design` absent from both the
bundle and the published manifest's dependencies.

### 9. Container / Docker kind — P2

Nothing in `packages/cli/src` mentions a Dockerfile. Without one, nothing reaches
Kubernetes, Azure Container Apps, or Cloud Run — probably the single biggest kind
gap for real deployment.

### 10. e2e test projects — P2

Both `reactApp.ts:174` and `node.ts:79` pass `--e2eTestRunner=none` explicitly,
so Nx's standard paired e2e project is actively switched off. A `<name>-e2e`
Playwright project (via `@nx/playwright`) is the conventional pairing.

### Lower priority

- **.NET / C#** — plausible given how Azure-DevOps-centric the tool is
- **Infrastructure as code** — Bicep or Terraform kind
- **Docs site** — Docusaurus/Astro, including for the monorepo itself
- **Angular / Vue / Svelte** — React is currently the only frontend framework

---

## 4. Local development

### 11. Generate a devcontainer — P2

The toolchain matrix is Node + Python + Go + Flutter. CI installs the Flutter SDK
itself (pinned, shallow clone, outside the workspace); **locally the user is on
their own**. A generated `.devcontainer` is what makes a local environment
actually match CI — a strong fit for the "just works" promise, and the natural
home for the Go and Flutter toolchains too.

### 12. Multi-project `dev up` — P2

`<name>:start` is per-project only. The most common real monorepo need is running
a frontend and the API it calls **together**. Nx's `continuous` task support
(already used by the custom `start` targets, e.g. `goStartTarget`) is the
mechanism.

### 13. `nx migrate` integration — P3

`mnci upgrade` re-applies mnci's own overlay but does nothing about upgrading Nx
itself, which stays a manual `nx migrate latest`. Worth folding in as an explicit
flag rather than leaving implicit.

---

## 5. Naming

### 14. Allow `.` in project and workspace names — ✅ done

`assertValidProjectName` used to enforce `^[a-z][a-z0-9-]*$`, so
`mnci add node-app my.service` failed outright. It now accepts
`^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$` — dots permitted, with the four positions
that break a downstream consumer still rejected (leading, trailing, repeated,
and all-dots). Requiring at least one `[a-z0-9-]` after every dot rules out all
four without a separate check per case.

A name is used in several roles at once, and dots are safe in most but not all:

| Role                                   | Dot-safe? | Outcome                                                                                                                                                                                                                                  |
| -------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filesystem path (`apps/<name>`)        | Yes       | verified — `apps/my.service` is fine                                                                                                                                                                                                     |
| npm package name                       | Yes       | verified — `@demo/my.sdk` builds and `npm pack`s (`socket.io` is precedent)                                                                                                                                                              |
| Nx project name, `nx run <name>:build` | Yes       | verified                                                                                                                                                                                                                                 |
| Release tag `{projectName}@{version}`  | Yes       | verified — `nx release --dry-run` resolves `@demo/my.sdk` and `my.pysvc`, and still excludes `go-lib`                                                                                                                                    |
| Drop zip `<kind>-<name>.zip`           | Yes       | `path.basename(f, '.zip')` still matches the artifact                                                                                                                                                                                    |
| **Python module identifier**           | **No**    | fixed — `pythonModuleDirectory` now maps `.`→`_`. A surviving dot is _valid syntax meaning something else_ (a submodule of a package that does not exist), so it fails **quietly**: wrong hatchling `packages` entry, unimportable wheel |
| **Dart package name**                  | **No**    | fixed — `dartPackageName` now maps `.`→`_`. pub requires `[a-z_][a-z0-9_]*` and rejects the pubspec outright, so this one fails loudly                                                                                                   |
| Go package identifier                  | Yes       | **no change needed** — Nx's own `names()` already treats a dot as a word separator, so `@nx-go/nx-go` writes `package mygolib` for `my.golib`. Verified against the real plugin and a real `go build`/`vet`/`test`                       |

Verified against a real generated workspace named `my.workspace` containing
`npm-lib my.sdk`, `python-lib my.pysvc` and `go-lib my.golib`: `run-many
-t lint,test,build` green across all three, the wheel contains `my_pysvc/` and
imports cleanly from a fresh venv with no phantom `my` package, and Go compiles.
Flutter is covered by unit tests only — no SDK on this machine.

### 17. Fix `mnci upgrade`'s three defects — ✅ done

Found while verifying #14, all pre-existing and all in the one command whose
whole job is carrying overlay fixes into existing workspaces:

1. **It wrote a file literally named `undefined.code-workspace`.**
   `resolveOverlayOptions` was declared `: OverlayOptions` but returned an object
   with no `workspaceName`, so `applyOverlay` interpolated `undefined` into the
   filename.
2. **So the real `.code-workspace` was never refreshed** — the one mnci-owned
   file an upgrade could not carry a fix into, which is precisely the gap
   `upgrade` exists to close.
3. **It never ran Prettier**, unlike `new` and every `add`, so it left the
   `nx.json` it had just rewritten mis-formatted and the workspace failing its
   own `format:check` — now a CI gate (#2).

`workspaceName` is now persisted in the `mnci` block, with a fallback chain for
workspaces generated before that existed: persisted value → an existing
`*.code-workspace` filename (skipping `undefined.code-workspace`, or a workspace
carrying the old junk would resolve its name as the string `undefined` forever) →
the directory basename. The root manifest name is deliberately not in the chain —
it is `@<scope>/source`, which carries the scope, not the workspace name.

**Fixing (1) exposed a fourth defect that it had been masking.** With the
filename corrected, upgrade began rewriting the real file — and
`vscodeWorkspace()` emits an empty `tasks` array, so it **destroyed every
per-project VS Code task `mnci add` had registered** (verified: a real
three-project workspace lost all five). The `tasks` array is per-project state,
not overlay-owned, so `applyOverlay` now reads it back and carries it through
while still regenerating the folders/settings/extensions it does own. The
JSONC-tolerant reader both layers need moved to `util/fsx.ts` as
`readCodeWorkspace`, replacing the private copy in `add/shared.ts`.

Verified on a real workspace generated before the fix (so it exercised the
filename fallback and carried genuine junk): the junk file is gone, the real file
survives with its tasks intact, `workspaceName` is now persisted for future runs,
and `format:check` passes immediately after an upgrade.

### 18. Run `typecheck` in CI — ✅ done

`npm run typecheck` reported **14 TypeScript errors on `main`** that CI never
noticed, because the pipeline ran `lint,test,build` and `typecheck` was not among
them. `tsup` builds with esbuild, which strips types without reading them, so
nothing in the pipeline type-checked the code at all.

Not hypothetical: one of the 14 was `commands/upgrade.ts` — the exact
missing-`workspaceName` bug fixed in #17. TypeScript already knew.

All 14 are now fixed (#17 took the one production error; the rest were test-file
issues: two missing `ProjectKind` imports, four stale `rootScripts({...})` calls
against a function that takes no parameters, and one duplicate `workspaceName`
key in an object literal — harmless at runtime, but a real smell TS catches). The
`run-many` in both providers, this repo's own workflow, and the `affected` script
now carry `typecheck`, and there is a root `typecheck` script.

The gate was verified to be real rather than assumed, in both directions:

- With the fixes stashed, `nx run-many -t typecheck` **fails** on `@mnci/cli` —
  so it genuinely would have caught the #17 bug.
- In a real generated workspace, a planted `const x: number = 'a string'` in an
  `npm-lib` **builds green** and **fails typecheck** — the exact gap, since
  esbuild/swc never read the annotation.

A generated workspace passes the new gate out of the box (`typecheck` runs for
its TS projects; Python and Go correctly have no such target).

---

## 6. Known gaps already documented

Carried over from `mnci-details.md` §12 so this file is the single list.

| Gap                                          | Note                                                                                                                                      | P   |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --- |
| **Go has no e2e coverage**                   | Real unit tests and real CI wiring, but the e2e never drives it. The Flutter section's SDK-present/`SKIPPED` pattern would work unchanged | P2  |
| `go-function-app` has no `:start`            | Writes no `host.json`/custom-handler config, so there is nothing for `func start` to attach to                                            | P3  |
| Function-app deployment not wired            | The drop zip is the deploy input; no `AzureFunctionApp@2`-style step                                                                      | P3  |
| Flutter apps build web only                  | Android needs the SDK + NDK on every agent; iOS is impossible on Linux                                                                    | P3  |
| Python has no lock file                      | Plain pip has none, and `requirements-dev.txt` is unpinned — deliberate, but revisit if reproducible CI is wanted                         | P3  |
| `flutter-lib` / `go-lib` publish by tag only | Azure Artifacts has no pub/Dart feed type                                                                                                 | —   |

---

## 7. Idea-level

### 15. Composition, not just kinds — P2

Everything above is per-project. The bigger leap for "easy to create different
types of code" is **composition**: a `mnci new --preset` that scaffolds a whole
_shape_ — web + api + shared lib, already wired together — instead of one `add`
at a time. That is a different value proposition from a longer kind list, and
it's where a scaffold stops being a generator and becomes a starting point.

### 16. Confirm `@mnci/eslint-config` resolves from the registry — ✅ done

Before it was first published, generating a workspace required packing it locally
and pointing `MNCI_ESLINT_CONFIG_SPEC` at the tarball, or `npm install` 404'd at
step one. That made this the one path nothing had ever exercised — including every
verification in this session, all of which used the tarball override.

Verified with the overrides explicitly unset, which is what a real user gets:

- `mnci new` completes, and the generated manifest declares `^0.1.0`
  (`ESLINT_CONFIG_VERSION`) resolving to **0.1.3 from the registry**.
- `mnci add internal-lib` works with no override either.
- The published config genuinely lints: a planted `const unused = 1` and
  `const bad: any = 2` are reported as `unused-imports/no-unused-vars` and
  `@typescript-eslint/no-explicit-any`. Resolving is not the same as loading, and
  loading is not the same as enforcing — so all three were checked.
- `mnci doctor` passes all seven checks on the result.

Note the caret semantics, since they are easy to misread: `^0.1.0` on a `0.x`
package allows `0.1.x` only, so a future `0.2.0` would **not** be picked up by
`npm update` in existing workspaces and would need `ESLINT_CONFIG_VERSION` bumped
deliberately. That is the intended behaviour for a pre-1.0 package whose minor
bumps may break rules, but it does mean the "an upgrade reaches existing
workspaces through `npm update`" claim holds only within a minor.
