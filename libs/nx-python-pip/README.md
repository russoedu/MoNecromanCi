# @mnci/nx-python-pip

An Nx plugin for **pip-native** Python projects — plain `pip`, Ruff, pytest
and the standard PyPA `build`/`twine` tools. No uv, no Poetry, no lock file.

## Why

No maintained, Nx-23-compatible Python plugin supports pip: the closest
existing option, [`@nxlv/python`](https://github.com/lucasvieirasilva/nx-plugins),
ships only `uv` and Poetry providers, and every alternative found on npm is
either the same uv/Poetry architecture or years stale. If your organization
standardizes on plain pip (no uv, no Poetry), this plugin fills that gap.

It was built for and is used by [`monecromanci-v2`](../monecromanci-v2)'s
`mnci2 add python-*` commands, but has no dependency on mnci2 — any Nx 21+
workspace can install and use it directly.

## Install

```sh
npm install --save-dev @mnci/nx-python-pip
```

No `nx.json` `plugins` registration needed — its generators and executors
are explicit (resolved via `generators.json`/`executors.json`, plain Node
module lookup), not inference-based.

You will also need the actual Python tools this plugin's executors shell out
to: `python3 -m pip install build twine ruff pytest` (or pin them in your own
`requirements-dev.txt` / `requirements-dev.in`). The plugin has no opinion on
*how* those land on a machine — same way `@nx/js`'s executors assume `node`
is already there.

## Generators

| Generator | Location default | Writes |
| --- | --- | --- |
| `application` | `apps/<name>` | `pyproject.toml` (hatchling) + `project.json` (`lint`/`test`/`build`) + a sample module and pytest |
| `library` | `libs/<name>` | Same as `application`, plus `nx-release-publish` (twine) and a project-level `release.version.versionActions` override |
| `internal-library` | `libs/<name>` | `lint`/`test` only — no `build`/publish; meant to be **vendored** into a consumer's wheel, not built or released on its own |
| `function-application` | `apps/<name>` | Azure Functions **v2** programming model (`function_app.py` + `host.json` + `requirements.txt` + a tested pure helper) — no `pyproject.toml`/build target, since the deployable is source, not a wheel |

```sh
nx g @mnci/nx-python-pip:application my-app
nx g @mnci/nx-python-pip:library my-lib --directory=packages/my-lib
nx g @mnci/nx-python-pip:internal-library my-shared-lib
nx g @mnci/nx-python-pip:function-application my-function-app
```

## Executors

| Executor | Runs |
| --- | --- |
| `build` | `python -m build` — vendoring-aware (see below) |
| `test` | `python -m pip install -e .` (unless `installEditable: false`) then `python -m pytest` |
| `lint` | `python -m ruff check .` |
| `publish` | `python -m twine upload --skip-existing dist/*`, reading `TWINE_USERNAME`/`TWINE_PASSWORD`/`TWINE_REPOSITORY_URL` from the environment |

Every command is invoked as `python3 -m <tool>`, never a hard-coded venv
path, so the exact same command works whether or not you've activated a
virtualenv — this plugin never creates or manages one itself.

`publish` accepts a real, typed `dryRun` option — `nx release publish
--dry-run` sets it automatically on every `nx-release-publish` executor, so
a dry run cleanly previews the twine command instead of running it.

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
automatically — you always add this entry by hand, mirroring how you'd wire
any other cross-project dependency.

Verified empirically that vendoring an internal lib and declaring a real
external PyPI dependency on the *same* project works correctly together —
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
  strategy; the `test` executor makes no attempt to solve this.
- venv management is left to the user — same spirit as never managing
  `node_modules` beyond `npm install`.
