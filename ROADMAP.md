# MoNecromanCI — Roadmap

Open work, grouped by theme. Each item states **what**, **why it matters**, the
**files** it touches, and **how to verify** it — so any of them can be picked up
without re-deriving the context first.

Ordering principle: items that close a gap between what the project _claims_ and
what it _does_ come before new capability. Several entries below were found by
running the real CLI and reading the real config rather than from the docs, and
those cite `file:line` so the claim can be re-checked.

**If only three get done:** publish auth (#1), `format:check` in CI (#2), and
`react-lib` (#8). All small; each closes something the project already implies.

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

### 2. Enforce Prettier somewhere automatic — P1

Formatting is currently enforced **nowhere**, in this repo or in generated ones:

- `format:check` exists only as a root script (`overlay.ts:664`). It is not a CI
  step in either provider — the only lint step is `npm run lint`
  (`overlay.ts:1384` Azure, `:1604` GitHub).
- The overlay writes only `.husky/commit-msg` (`overlay.ts:1903`). There is no
  `pre-commit` hook, despite `packages/cli/README.md` describing formatting as
  "left as a local/pre-commit step".

So mnci deletes Nx's `.prettierrc` specifically to make its own formatting
opinion take effect, then never checks that it holds. A workspace drifts out of
compliance silently.

- **Fix:** add `npm run format:check` to both pipelines, and/or write a
  `pre-commit` hook running Prettier over staged files.
- **Care:** any CI change must be mirrored in **both** providers — the anti-drift
  test in `overlay.test.ts` asserts the guard bodies stay byte-identical.
- **Verify:** commit a deliberately mis-formatted file; CI must fail.

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

### 14. Allow `.` in project and workspace names — P1

`assertValidProjectName` (`packages/cli/src/util/names.ts:28`) enforces
`^[a-z][a-z0-9-]*$`, so `mnci add node-app my.service` fails outright. Dots are a
normal, widely-used naming convention and a preferred working style here.

This is **not** just a regex widening — a name is used in several roles at once,
and dots are safe in most but not all of them:

| Role                                   | Dot-safe?      | Action                                                                                                                                                          |
| -------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filesystem path (`apps/<name>`)        | Yes            | but reject `.`, `..`, and leading/trailing dots (a leading dot also makes a hidden directory)                                                                   |
| npm package name                       | Yes            | `socket.io` and `lodash.merge` are precedent                                                                                                                    |
| Nx project name, `nx run <name>:build` | Yes            | none                                                                                                                                                            |
| Release tag `{projectName}@{version}`  | Mostly         | git refs forbid `..` and a trailing `.`                                                                                                                         |
| Drop zip `<kind>-<name>.zip`           | Yes            | CI derives the build tag with `path.basename(f, '.zip')`, so it still matches the artifact                                                                      |
| **Python module identifier**           | **No**         | a dot is the package separator. `pythonModuleName` (`nx-python-pip/src/internal/pythonProject.ts:13`) maps only `-`→`_` today and must map `.` too              |
| **Dart package name**                  | **No**         | pub requires `[a-z_][a-z0-9_]*` and rejects the pubspec outright otherwise. `dartPackageName` (`nx-flutter/src/internal/dartPackageName.ts`) needs the same fix |
| Go package identifier                  | Needs checking | declared in source rather than derived from the directory — confirm what `@nx-go/nx-go` emits for a dotted directory                                            |

So the work is: widen the charset, explicitly forbid the degenerate dot cases,
and extend both name-transform helpers. Both already have the `-`→`_` precedent,
so the shape of the fix is established — the risk is forgetting one of them,
since Dart fails loudly but a wrong Python module name fails subtly (bad
`packages` list in the wheel).

- **Verify:** generate `my.service` for a Python kind and a Flutter kind, then
  build both and inspect the wheel contents and `pubspec.yaml`.

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
