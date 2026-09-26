# @mnci/nx-python-pip

An Nx plugin for **pip-native** Python projects — plain `pip`, Ruff, pytest
and the standard PyPA `build`/`twine` tools. No uv, no Poetry, no lock file.

## Why

No maintained, Nx-23-compatible Python plugin supports pip: the closest
existing option, [`@nxlv/python`](https://github.com/lucasvieirasilva/nx-plugins),
ships only `uv` and Poetry providers, and every alternative found on npm is
either the same uv/Poetry architecture or years stale. If your organization
standardizes on plain pip (no uv, no Poetry), this plugin fills that gap.

It was built for and is used by [`@mnci/cli`](../cli)'s `mnci add python-*`
commands, but has no dependency on `@mnci/cli` — any Nx 21+ workspace can
install and use it directly.

## Install

```sh
npm install --save-dev @mnci/nx-python-pip
```

No `nx.json` `plugins` registration needed — its generators and executors
are explicit (resolved via `generators.json`/`executors.json`, plain Node
module lookup), not inference-based.

You will also need the actual Python tools this plugin's executors shell out
to: `python3 -m pip install build twine ruff pytest` (`python -m pip ...` on
Windows — see below) — or pin them in your own `requirements-dev.txt` /
`requirements-dev.in`. The plugin has no opinion on _how_ those land on a
machine — same way `@nx/js`'s executors assume `node` is already there.

## Generators

| Generator              | Location default | Writes                                                                                                                                                                                                 |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `application`          | `apps/<name>`    | `pyproject.toml` (hatchling, incl. a strict `[tool.mypy]`) + `project.json` (`lint`/`typecheck`/`test`/`build`) + a sample module and pytest                                                                                                     |
| `library`              | `libs/<name>`    | Same as `application`, plus `nx-release-publish` (twine) and a project-level `release.version.versionActions` override                                                                                 |
| `internal-library`     | `libs/<name>`    | `lint`/`typecheck`/`test` only — no `build`/publish; meant to be **vendored** into a consumer's wheel, not built or released on its own                                                                            |
| `function-application` | `apps/<name>`    | Azure Functions **v2** programming model (`function_app.py` + `host.json` + `requirements.txt` + a tested pure helper) — no `pyproject.toml`/build target, since the deployable is source, not a wheel |

```sh
nx g @mnci/nx-python-pip:application my-app
nx g @mnci/nx-python-pip:library my-lib --directory=packages/my-lib
nx g @mnci/nx-python-pip:internal-library my-shared-lib
nx g @mnci/nx-python-pip:function-application my-function-app
```

## Executors

| Executor  | Runs                                                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `build`   | `python -m build` — vendoring-aware (see below)                                                                                        |
| `test`    | `python -m pip install -e .` (unless `installEditable: false`) then `python -m pytest`                                                 |
| `lint`    | `python -m ruff check .`                                                                                                               |
| `typecheck` | `python -m mypy .` — strictness comes from the project's own `[tool.mypy]`, never from flags here, so a hand-run `mypy` matches the target |
| `publish` | `python -m twine upload --skip-existing dist/*`, reading `TWINE_USERNAME`/`TWINE_PASSWORD`/`TWINE_REPOSITORY_URL` from the environment — **skipped entirely for a project this release did not version** (see below) |

Every command is invoked as `<python> -m <tool>`, never a hard-coded venv
path, so the exact same command works whether or not you've activated a
virtualenv — this plugin never creates or manages one itself. `<python>` is
resolved per platform (`pythonCommand` in `src/internal/pythonCommand.ts`):
`python3` on POSIX, `python` on Windows, since the standard python.org
Windows installer registers only `python.exe` — a hard-coded `python3` fails
outright there.

`publish` accepts a real, typed `dryRun` option — `nx release publish
--dry-run` sets it automatically on every `nx-release-publish` executor, so
a dry run cleanly previews the twine command instead of running it.

**A project with no new version is not published.** `nx release publish` hands
every `nx-release-publish` task the version data its version step produced, and
`publish` skips any project whose `newVersion` is `null` — the same thing
`@nx/js:release-publish` does, and for a sharper reason here. `nx release` is
normally configured tag-only (`release.git.commit: false`), so an untouched
project's `pyproject.toml` keeps its scaffold version for ever; publishing it on
every release of its *neighbours* therefore uploads `0.0.1` over and over, and
`--skip-existing` reduces that to a warning and exit 0, so nobody sees it. On a
package PyPI has never seen it is worse than noise: the upload **creates** the
project at the scaffold version, and each one spends a slot in PyPI's
new-project rate limit — which is how a workspace adding several Python packages
earns a `429 Too Many Requests` on the one release it actually meant to publish.

A dry run reports the same skip, so a preview matches the run it previews. When
no version data is passed at all (`nx release publish` invoked on its own,
without the version step), nothing has been claimed about any project, so every
project publishes.

## Type checking

Every generated project carries a `typecheck` target and a **strict**
`[tool.mypy]` block in its own `pyproject.toml`. The name matters: a generated
workspace's CI already verifies `lint,typecheck,test,build`, and Nx **skips**
projects that have no target of a given name and still exits 0 — so before
this, Python was type-checked by nothing while the workspace reported green.

`strict = true` is measured rather than aspirational: the sample module and
test this plugin writes are both fully annotated, so a freshly generated
project passes `mypy --strict` with no findings.

There is exactly one relaxation, `disable_error_code = ["import-untyped"]`.
Importing a library that ships no type stubs otherwise fails on code you wrote
normally and cannot fix. It is deliberately narrower than
`ignore_missing_imports`: a module that genuinely cannot be resolved still
fails, as `import-not-found`, so a typo'd or un-installed import does not
silently become `Any`. Note that a **vendored** internal lib is one of those —
it resolves only after the workspace-wide editable install (`npm run
python:install` in an `@mnci/cli` workspace), the same precondition the `test`
target already has.

Both are ordinary settings in a file you own: relax or tighten per project by
editing the block.

## Internal-lib vendoring

Plain pip has no bundled-local-dependency feature (the equivalent of
`@nxlv/python`'s `bundleLocalDependencies`). To have a project's built wheel
bundle an internal library's module as a real top-level package, hand-add a
`vendor` entry to the consuming project's `pyproject.toml`:

```toml
[tool.mnci-python-pip]
vendor = ["my-shared-lib"]
```

The `build` executor resolves `my-shared-lib`'s root via the **real Nx
project graph** (not a hard-coded path), copies its module directory into a
staged copy of the project being built, patches the staged
`pyproject.toml`'s `[tool.hatch.build.targets.wheel] packages` list to
include it, and builds from there. No cross-project dependency is ever wired
automatically by this plugin — the entry above is always a hand-edit as far
as it's concerned. If you're using `@mnci/cli`, `mnci add python-vendor
<consumer> --lib my-shared-lib` writes exactly that edit for you
(idempotently); this package itself stays that CLI-agnostic — reading the
entry, not writing it.

Verified empirically that vendoring an internal lib and declaring a real
external PyPI dependency on the _same_ project works correctly together —
the combination that silently dropped the external dependency's metadata
under `@nxlv/python`'s `bundleLocalDependencies` does not reproduce here.

## Versioning (`nx release`)

The `library` generator sets:

```json
"release": { "version": { "versionActions": "@mnci/nx-python-pip/release/version-actions" } }
```

on the generated project. This is a hand-written implementation of Nx's
`VersionActions` interface that reads/writes the `version = "..."` line
under `pyproject.toml`'s `[project]` table — verified empirically against a
real `nx release version --dry-run`, both the disk-fallback and
git-tag-based resolution paths. Internal-lib dependencies are vendored, not
registry references, so dependency-version tracking is a no-op (the same
branch `@nxlv/python`'s own reference implementation takes for bundled
dependencies).

## Known gaps

- No lock file — plain pip has none. A published wheel's `Requires-Dist`
  mirrors whatever specifier `pyproject.toml` declares (e.g. `tomli>=2.0.0`)
  verbatim, not a resolved/pinned version.
- Vendored internal-lib imports are only resolvable inside the **built**
  wheel — not from a plain `pip install -e .` dev environment, since
  vendoring happens at `build` time only. A project whose pytest-covered
  code imports a vendored internal lib needs its own test-isolation
  strategy; the `test` executor makes no attempt to solve this (it only
  editable-installs the project under test, never what it imports). A
  workspace can solve it at the workspace level instead, by
  editable-installing every Python project (not just the one under test)
  into one shared environment — the pip-world counterpart of `npm install`
  hoisting every workspace package into one root `node_modules`. `@mnci/cli`
  does exactly this as a guarded CI step; see its README.
- venv management is left to the user — same spirit as never managing
  `node_modules` beyond `npm install`.
