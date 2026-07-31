# MoNecromanCI — Roadmap

Open work, grouped by theme. Each item states **what**, **why it matters**, the
**files** it touches, and **how to verify** it — so any of them can be picked up
without re-deriving the context first.

Ordering principle: items that close a gap between what the project _claims_ and
what it _does_ come before new capability. Several entries below were found by
running the real CLI and reading the real config rather than from the docs, and
those cite `file:line` so the claim can be re-checked.

**If only three get done:** publish auth (#1), ~~`format:check` in CI (#2)~~
(done), and `react-lib` (#8). All small; each closes something the project
already implies.

---

## 1. Promises the project doesn't currently keep

### 1. Wire publish authentication — P1

The generated `.npmrc` is comments-only (`npmrcContent`, `overlay.ts:143`), so
`npm publish` never authenticates in any generated workspace. This hollows out
the headline feature: `nx release` versions and tags correctly, then cannot
actually publish.

The asymmetry is the tell — mnci publishes _itself_ fine (this repo has a real
root `.npmrc` with `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`), while
nothing it generates can. The CI token export (`NODE_AUTH_TOKEN` / `PAT`) is
already in place and the overlay's own comment says completing this is roughly a
one-line change.

- **Files:** `packages/cli/src/overlay.ts` (`npmrcContent`), the publish-path
  assertions in `packages/cli/e2e/cli.e2e.mjs`
- **Care:** decide scope routing (`@scope:registry`) deliberately. The old file
  claimed scope routing prevented accidental public publishes while emitting no
  such line — do not reintroduce a safety property that isn't real.
- **Verify:** a generated workspace publishes to a local Verdaccio registry
  (already a devDependency here) end to end.

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

### 3. `mnci doctor` — P2

Previously parked as "out of scope until the model is proven". It's proven: the
ESLint drift fixed in #82 was exactly this class of bug — a documented invariant
(`pinned to ESLint 9`) that silently did not hold, because four package manifests
still said `^10.8.0` and that is what actually resolved.

Checks worth having, all cheap and all derived from existing invariants:

- exactly one ESLint config, at the root; none under `{apps,libs,packages}/*`
- no stray `.prettierrc` outranking `.prettierrc.json`
- `@nx/eslint/plugin` registered in `nx.json`
- resolved `eslint` major inside the supported range (the #82 bug)
- `nx sync` clean
- `.npmrc` consistent with the recorded registry choice
- every publishable Dart/Python lib still carries its `versionActions` override
  (its absence breaks release for the _whole_ workspace)

- **Files:** new `packages/cli/src/commands/doctor.ts`, wired in `cli.ts`

---

## 2. CI that "just works"

Four cheap wins, all verified absent:

| Item                             | Detail                                                                                                                                                                                              | P   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| 4. `cache: npm` on `setup-node`  | `overlay.ts:1524-1526` passes only `node-version`, so every run reinstalls cold                                                                                                                     | P2  |
| 5. Use `nx affected` for PR runs | The `affected` root script exists (`overlay.ts:635`) but CI runs `run-many` over everything on every PR — arguably the whole point of Nx on a monorepo. Needs `nrwl/nx-set-shas` for base/head SHAs | P2  |
| 6. `concurrency` group           | Superseded PR pushes keep burning runner minutes                                                                                                                                                    | P3  |
| 7. Deploy stage                  | The drop zip is currently the handoff; an optional per-kind deploy would close the loop (see also §6)                                                                                               | P3  |

---

## 3. More project kinds

The two real holes first.

### 8. `react-lib` — P1

There is no React library kind at all, so a **shared component library cannot be
built today**: `npm-lib` and `internal-lib` are both `@nx/js`, with no JSX
support. `@nx/react:library` is the obvious delegate, and the existing
`npm-lib`/`internal-lib` split (publishable vs private) is the pattern to mirror.

- **Files:** new `packages/cli/src/commands/add/reactLib.ts`, plus the
  `ProjectKind` union, `PROJECT_KINDS`, and a `switch` case in `add.ts` (a
  missing case is a compile-time error, so it can't be half-done)

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

### 16. Confirm `@mnci/eslint-config` resolves from the registry — P1, quick

It was first published as `0.1.2` on 2026-07-31. Before that, generating a
workspace required packing it locally and pointing `MNCI_ESLINT_CONFIG_SPEC` at
the tarball, or `npm install` 404'd at step one. The overlay pins `^0.1.0`
(`ESLINT_CONFIG_VERSION`), which `0.1.2` satisfies — but **this path has never
been exercised**, since the package didn't exist publicly until now.

- **Verify:** run `mnci new` with no `MNCI_ESLINT_CONFIG_SPEC` override and
  confirm the install resolves and the root config loads.
