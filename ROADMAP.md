# MoNecromanCI — Roadmap

Open work, grouped by theme. Each item states **what**, **why it matters**, the
**files** it touches, and **how to verify** it — so any of them can be picked up
without re-deriving the context first.

Ordering principle: items that close a gap between what the project _claims_ and
what it _does_ come before new capability. Several entries below were found by
running the real CLI and reading the real config rather than from the docs, and
those cite `file:line` so the claim can be re-checked.

**Done so far:** #1 (publish auth), #2 (`format:check` in CI), #4 (npm cache),
#5 (`nx affected` on PRs), #6 (superseded-run handling), #8 (`react-lib`),
#14 (dots in names), #17 (`mnci upgrade`'s defects), #18 (`typecheck` in CI),
#3 (`mnci doctor`), #16 (registry resolution verified) — which closes **§1 and §2
entirely**: every gap between what the project claimed and what it did.

**#19 (all of a–e, §9)** and **#20** (the fake `typecheck` targets, §8) are also
done — the linting package now covers type-aware rules, JSX accessibility, Vitest's
globals and intra-project import cycles. #20 was found _while_ doing #19a, and
turning its gate on immediately exposed pre-existing type errors in both plugins:
specs in `nx-flutter` and `nx-python-pip` had been type-checked by nothing at all.

Go e2e coverage (§6) is done too — the suite now drives all four Go kinds, so every
project kind mnci ships is exercised end to end on a machine with its toolchain.

**Open, all P2:** #9 (container kind), #10 (e2e test projects), #11 (devcontainer),
#12 (multi-project `dev up`), #15 (`--preset` composition), and the leftovers under
#19e (`eslint-plugin-regexp`, TOML, `eslint-plugin-n`'s fuller set). Plus #7 and #13
at P3. **No P1 is open.**

`@mnci/eslint-config` keeps the widest reach of anything here, which is worth
remembering for the #19e leftovers: it is a published package, so within a minor its
improvements land in existing workspaces through `npm update` alone, with no
`mnci upgrade` and no regenerated files (see the caret caveat in #16).

**One limitation of #5 worth knowing before picking anything up.** Nx's affected
graph has no edge from a project to `@mnci/eslint-config`, because the lint config
is resolved from the root `eslint.config.mjs` rather than imported by project
source. So PR #100 — which changed the shared lint config — re-linted only
`eslint-config` and `cli`, not `nx-flutter` or `nx-python-pip`. Bounded rather than
dangerous: a push to `main` verifies everything, so a breakage surfaces at merge
instead of on the PR. Worth remembering when changing anything cross-cutting that
Nx cannot see: check locally with `nx run-many` before trusting a green PR.

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
repo's own workflow), placed after `nx sync:check` and before the verify step
(#5 later removed the standalone `Lint` step it originally sat after). ESLint here
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

| Item                                 | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | P   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 4. ~~`cache: npm` on `setup-node`~~  | ✅ done — both providers now cache npm downloads keyed on the lockfile. GitHub uses `setup-node`'s own `cache: npm`; Azure has no equivalent, so it gets the documented `Cache@2` pattern plus `npm_config_cache` relocating the cache into the pipeline workspace (the default `~/.npm` is outside the cacheable area). `Agent.OS` is in the key because a cached native module built for one OS is not reusable on another                                                                                                                               | —   |
| 5. ~~Use `nx affected` for PR runs~~ | ✅ done — see [§5 below](#5-nx-affected-for-pr-runs--done)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —   |
| 6. ~~`concurrency` group~~           | ✅ done — GitHub gets a concurrency group whose `cancel-in-progress` is an **expression**, not a flat `true`: a superseded PR run is cancelled, but a run on `main` queues instead, because cancelling one part-way can leave a release tag pushed with the publish half done, which no rerun repairs. Azure gets `batch: true` on the main trigger (its nearest YAML equivalent, and it also stops two `nx release` runs racing for a tag); PR-run cancellation there is a branch-policy setting with no YAML form, so it is documented rather than faked | —   |
| 7. Deploy stage                      | The drop zip is currently the handoff; an optional per-kind deploy would close the loop (see also §6)                                                                                                                                                                                                                                                                                                                                                                                                                                                      | P3  |

### 5. `nx affected` for PR runs — ✅ done

Both providers now verify **only the affected projects on a pull request, and
every project on anything else** — one step, one shared guard
(`AFFECTED_OR_ALL_GUARD` in `overlay.ts`), byte-identical in
`azure-pipelines.yml` and `.github/workflows/ci.yml`.

Three decisions are load-bearing:

**Every failure path falls back to `run-many`, never to nothing.** This was the
stated risk when the item was written, and it drove the design rather than being
checked afterwards. Resolving the base too _wide_ costs a few minutes; resolving
it too _narrow_ means CI runs almost nothing, reports green, and has verified
nothing — a silently weakened gate, which is strictly worse than a slow one. So a
missing target ref, an unresolvable merge-base (shallow clone, absent remote
branch) and any non-PR run all take the full path.

**`main` needs no special case.** Neither provider sets a pull-request target
branch on a push, so a release run always verifies everything — it falls out of
the fallback instead of being a second condition to keep in step with the first.

**`git merge-base`, not `nrwl/nx-set-shas`** (which this item originally proposed).
`nx-set-shas` is GitHub-only, so using it would have meant two different
mechanisms deciding what CI verifies, in the one place where drift between
providers changes the gate itself rather than its spelling. A merge-base is
correct in both by construction, and needs no action from a marketplace. The
guard also reads both providers' PR variables (`GITHUB_BASE_REF`,
`SYSTEM_PULLREQUEST_TARGETBRANCH`) and strips Azure's `refs/heads/` prefix, since
Azure sends a full ref where GitHub sends a bare branch name.

`format:check` deliberately stays workspace-wide: `prettier --check .` is one
invocation over the whole tree, not a per-project Nx target, so there is nothing
to narrow and formatting is never checked in part. The standalone `npm run lint`
step is gone — it was `nx run-many -t lint`, a strict subset of the verify step's
target list, and on an affected-scoped PR it would have re-linted every project
and discarded most of the benefit.

**How it was verified.** Not by reading the generated YAML — the six new tests
_execute_ the real guard against a real git repository with a stub `npx` on PATH
recording which Nx command it chose, covering: not-a-PR → `run-many`; a GitHub PR
→ `affected --base=<merge-base>`; Azure's full ref → the _same_ base; an
unresolvable branch → `run-many`; a failing exit status propagating on both paths;
and the command surviving YAML parsing unchanged in both providers. Both branches
were then mutation-tested (removing the `refs/heads/` strip, and removing the
fallback) to confirm the tests actually fail when the guard breaks. Affected
_selection_ was checked separately on a real generated workspace: changing a
depended-on internal lib marks it **and** its consumer, changing one project
marks only that project, changing nothing marks nothing.

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

| Gap                                          | Note                                                                                                                                                                                                                                                                                                                                                                 | P   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| ~~**Go has no e2e coverage**~~               | ✅ done — the e2e drives all four kinds: one root `go.mod` and no `go.work`, every target written explicitly, a cross-project import with no vendoring, real `go build`/`go test`, a `golangci-lint` run, a packaged binary in the drop zip, and `nx release` surviving a `go-lib`. Gated on the toolchain and reported `SKIPPED` when absent, exactly as Flutter is | —   |
| `go-function-app` has no `:start`            | Writes no `host.json`/custom-handler config, so there is nothing for `func start` to attach to                                                                                                                                                                                                                                                                       | P3  |
| Function-app deployment not wired            | The drop zip is the deploy input; no `AzureFunctionApp@2`-style step                                                                                                                                                                                                                                                                                                 | P3  |
| Flutter apps build web only                  | Android needs the SDK + NDK on every agent; iOS is impossible on Linux                                                                                                                                                                                                                                                                                               | P3  |
| Python has no lock file                      | Plain pip has none, and `requirements-dev.txt` is unpinned — deliberate, but revisit if reproducible CI is wanted                                                                                                                                                                                                                                                    | P3  |
| `flutter-lib` / `go-lib` publish by tag only | Azure Artifacts has no pub/Dart feed type                                                                                                                                                                                                                                                                                                                            | —   |

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

---

## 8. Gates that still don't gate

### 20. Two packages have a fake `typecheck` target — ✅ done

Found while adding a tsconfig for #19a, and it undercuts #18. Nx **disables** an
inferred `typecheck` target when a project's tsconfig sets `noEmit: true`, and it
does so by replacing the command with an `echo`:

```
$ npx nx show project @mnci/nx-flutter --json
typecheck: echo "The 'typecheck' target is disabled because one or more project
references set 'noEmit: true' in their tsconfig. Remove this property to resolve…"
```

`@mnci/nx-flutter` and `@mnci/nx-python-pip` both set `noEmit: true`, so both have
this stub. Their `typecheck` **passes by printing a message**. Only `@mnci/cli` has
a real one, and only because it runs `tsc --noEmit` through a package script
instead of the inferred target.

So #18 ("run `typecheck` in CI") is half-delivered: CI does run
`-t lint,typecheck,test,build`, and for two of four projects the typecheck step is
theatre. Both are _published_ plugins, which makes this the highest-consequence
open item — the same shape as the `.prettierrc` that silently outranked
`.prettierrc.json`, and as the `@nx/eslint/plugin` check `mnci doctor` exists for.

**The fix follows `@mnci/cli`'s existing pattern** rather than touching the build:
each plugin gets a `tsconfig.typecheck.json` plus a `typecheck` package script
(`tsc --noEmit -p tsconfig.typecheck.json`), which is exactly how `cli` already has
a real one. `noEmit: true` and the contradictory `emitDeclarationOnly: true` are
gone from the base tsconfig — `tsconfig.lib.json` overrode both anyway, so they
were dead config whose only effect was setting this trap.

**Turning the gate on immediately found pre-existing type errors in both
plugins** — the proof it mattered. `tsconfig.lib.json` excludes `*.spec.ts`, so
every spec file in both packages had been type-checked by _nothing_:

- `toSorted` (ES2023) and `Object.hasOwn` (ES2022) used against `lib: es2021`,
  cascading into `TS7006` implicit-`any` on the comparator parameters
- five stale `as unknown as Buffer` casts in `nx-python-pip`, now
  `as unknown as ReturnType<typeof readFileSync>` so they track `@types/node`
  instead of going stale again

**The newer `lib` went into `tsconfig.typecheck.json` only, not the base.** Bumping
the base to `es2023` was tried first and **changed the published output**: class
property initializers stop being downlevelled into constructor assignments and
become native class fields, which is a `[[Set]]` → `[[Define]]` semantics change in
a class that `extends` Nx's `VersionActions`. Almost certainly benign, but not
worth risking in two published packages when the only driver was _spec_ files —
which are excluded from the build. Verified by diffing `dist/` before and after:
with the newer lib confined to the typecheck config, the emitted output is
**byte-identical**.

**Verified by planting a type error in each plugin's specs, watching typecheck
fail, and removing it** — the practice this item exists to demand, since a green
`typecheck` was exactly the symptom.

**No `mnci doctor` check was added, and that is deliberate.** Doctor's stated bar is
an invariant that has actually been violated in this repo _or a workspace it
generated_, and this one cannot occur in a generated workspace: neither mnci's own
source nor any `@nx/*` generator writes `noEmit` into a tsconfig (checked, not
assumed). Adding a check for something unreachable is the noise that trains people
to ignore the output. Still missing, and worth having: an automated guard that a
`typecheck` target is not a disabled stub. CI cannot catch this class by running
the target — the stub _passes_.

---

## 9. The linting package

### 19. Make `@mnci/eslint-config` a more complete linting package — ✅ done (a–e)

`@mnci/eslint-config` already covers JS/TS, React, JSON/JSONC/JSON5, YAML,
Markdown, CSS, HTML and test files as one root config, and it is the piece with
the widest reach in the whole project: it is a published package, so within a
minor its improvements land in every existing workspace through `npm update`
alone — no `mnci upgrade`, no regenerated files, nothing for the user to review.
That makes it the best place to invest, and also the place where a mistake
propagates furthest, so each addition below wants the same treatment the config
already gets: composed, then run against the real `eslint` binary on a file that
should fail and a file that should not.

The gaps below were each checked against the current source rather than guessed,
so they can be picked up in any order and priced independently.

**a. Type-aware TypeScript rules — ✅ done.** The suspected-obsolete blocker was
obsolete: `projectService: true` discovers each file's tsconfig itself, so the
"a generated monorepo cannot know its tsconfigs up front" reason no longer
applies. `configs/typeAware.js` now ships a **curated** set —
`no-floating-promises`, `no-misused-promises`, `await-thenable`,
`no-unnecessary-type-assertion`, `unbound-method` and four narrow ones.

Not `recommendedTypeChecked`: measured against this monorepo it reported 67
problems, mostly not bugs (`require-await` fires on every `nx-python-pip`
executor, which must be `async` to satisfy Nx's contract; `no-unsafe-*` fires
throughout the generator specs). The curated set reported 10, all real — including
a genuine floating promise at `packages/cli/src/cli.ts`.

Two decisions came out of verification rather than design:

- **The rules are scoped to `{apps,libs,packages}/*/src/**`, not every `.ts`.** A
  file in no tsconfig is not skipped by the project service — it is a **fatal
  parse error**, which suppresses every other rule for that file _and_ fails the
  build. Applying the rules workspace-wide made four of this package's own tests
  report `FATAL`. `allowDefaultProject`, the documented escape hatch, fails in
  both directions (a listed file that _is_ covered is also fatal — `*.config.ts`
  broke `packages/cli/tsup.config.ts`), so scoping to the directories that are
  guaranteed to have a tsconfig is the only option that cannot misfire.
- **`no-misused-promises` needs `checksVoidReturn: { attributes: false }`.** A
  freshly generated `react-app` with `onClick={async () => { await save() }}` —
  the universal React idiom — failed `npm run lint` on a file the user wrote
  normally. Found by generating a real workspace and adding a real react-app, not
  by reading the rule docs. Only that sub-check is off; the one that catches real
  bugs (an async callback passed to `Array.filter`) is still on, and a test proves
  each half independently.

Cost, measured: whole-repo lint goes from ~5s to ~8s. It also now depends on
project references being in order, which CI already guarantees via `nx sync:check`
before it lints.

**b. JSX accessibility — ✅ done.** `eslint-plugin-jsx-a11y` (`recommended`) now
applies to every `.jsx`/`.tsx` file, composed in `configs/react.js`. There were two
React project kinds and **zero** a11y rules reaching a single line of JSX:
`@html-eslint/require-img-alt` covers `**/*.html` only, so an `<img>` inside a
component was checked by nothing. Accessibility is a correctness concern in the same
sense a dropped `await` is, so it belongs in this config's scope.

Also corrects the docs: the coverage table said "HTML + a11y", true of `.html` and
not of JSX. It now lists the two separately.

Verified on a real generated workspace rather than fixtures alone, because the risk
here was `recommended` failing a freshly generated `react-app` — Nx's own
`NxWelcome` component is a large slab of markup, exactly the shape that trips a11y
rules. It lints **clean out of the box**, and a planted `<img>` with no `alt` plus an
anchor used as a button report four real violations (`alt-text`,
`anchor-is-valid`, `click-events-have-key-events`,
`no-static-element-interactions`). Mutation-tested: removing the rule spread fails
the new test.

**c. Vitest's own globals — ✅ done.** `vi` and `vitest` are now declared alongside
Jest's globals, and `vitest.*` config files join the `jest.*` entry in the `files`
list. Narrow in practice — the vitest stack generates `.ts` specs, and `no-undef` is
off for TypeScript — but `vi.fn()` in a `.js` spec really did report
`'vi' is not defined`, which is a failure on a file the user wrote normally.

**d. Import-graph correctness — ✅ done, with one rule deliberately off.**
`eslint-plugin-import-x` (ESLint 9 compatible) now provides `no-cycle` and
`no-self-import`, scoped to project source. This is specifically the
**intra-project** gap: `@nx/enforce-module-boundaries` polices edges _between_
projects, including cycles in the project graph, but nothing looked inside a
project, so a cycle among one project's own modules was reported by nothing. It
runs until it doesn't — whichever module evaluates second sees a half-initialised
namespace.

**Two traps found by running it, both of which would have shipped a rule that
looks enabled and isn't:**

1. **`no-cycle` needs `settings['import-x/parsers']`, and without it reports
   nothing — ever.** `languageOptions.parser` tells ESLint how to parse the file
   being linted; it says nothing about how import-x should parse the files it
   _follows_. Without the mapping every `.ts` dependency is unparseable, traversal
   stops at depth one, and the rule is silently inert. `no-unresolved` does **not**
   need it (it resolves paths, never parses), which is exactly why the gap is easy
   to miss: one rule works while the other is dead. `@typescript-eslint/parser` is
   now an explicit dependency so this never depends on hoisting.
2. **The Node resolver is unusable here.** With `import-x`'s default resolver this
   reported **179** errors on the mnci monorepo, every one false: Node cannot
   resolve an extensionless relative TypeScript import (`./pythonProject` →
   `pythonProject.ts`). `createTypeScriptImportResolver` is given **no `project`
   option**, so it discovers each file's nearest tsconfig itself — the same reason
   `projectService: true` works in #19a, and verified the same way.

**`no-unresolved` is off, and that is structural rather than a tuning choice.** In
an mnci workspace a project consumes an internal lib by scoped name
(`@scope/core`), npm workspaces symlinks it, and that manifest points at
`./dist/index.js` — which does not exist until the dependency is **built**. `lint`
does not depend on `build`, and the `ts` preset has no tsconfig `paths` to fall
back on (cross-project imports resolve through project references, which a
filesystem resolver cannot follow). Verified on a real generated workspace: a
publishable lib re-exporting `@scope/core` reported it unresolved — a false
positive on the internal-lib feature central to the whole scaffold. So the rule is
switched **off explicitly**, and a test pins it there, rather than being left
unconfigured for someone to enable in good faith. Little is lost: `tsc` reports an
unresolved _typed_ import and CI runs `typecheck`; the remaining gap is a
side-effect-only import whose file has moved.

Verified on a real generated workspace after the change: the cross-project import
lints clean, and a planted intra-project cycle is reported. Both traps are
mutation-tested.

**e. Comments in `tsconfig.json` — ✅ done, and subtler than it looked.**
`tsconfig*.json` and `*.code-workspace` were **already** listed as JSONC, yet a
commented `tsconfig.json` still failed with 8 `jsonc/no-comments` errors. The cause:
those files also match `**/*.json`, whose block enables the rule, and the JSONC
preset merely _omits_ it rather than setting it to `'off'` — so in flat config the
earlier `'error'` survives. Fixed by switching it off explicitly, with
`.vscode/*.json` added to the same block. Both directions are tested: comments
allowed in the JSONC family, still an error in a plain `.json`.

**Still open under e:** `eslint-plugin-regexp` (catastrophic backtracking and dead
alternatives are genuine correctness bugs, and squarely in this config's scope);
TOML, since mnci writes `pyproject.toml` files and no rule reads them;
`eslint-plugin-n` is already a dependency and wired for a handful of rules, so its
`recommended` set may be under-used.

**Two constraints any addition must respect** — both already load-bearing, both
easy to break from here:

1. **Correctness only, never formatting.** `eslint-config-prettier` is composed
   LAST and the stylistic block after it holds only rules Prettier never touches.
   A new plugin's `recommended` set will bring formatting rules with it; they must
   land _before_ `prettierConfig` so it can switch them off. Adding one after it
   makes `npm run lint` and `npm run format:check` mutually unsatisfiable — the
   exact trap `space-before-function-paren` documents.
2. **ESLint 9, decided by the plugins.** Any candidate whose peer range excludes
   9 is not an option yet, whatever its merits.
