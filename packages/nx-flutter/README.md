# @mnci/nx-flutter

> An Nx plugin for Flutter/Dart projects built on **Dart pub workspaces** — one
> root `pubspec.yaml`, one lockfile, `flutter analyze`/`test`/`build web`.

Usable standalone in any Nx 21+ workspace; it has no dependency on
[`@mnci/cli`](../cli), which simply delegates its `flutter-*` project kinds to
the generators here.

## Why this exists

No maintained, Nx-23-compatible Flutter plugin does.
[`@nxrocks/nx-flutter`](https://www.npmjs.com/package/@nxrocks/nx-flutter)
cannot even load on Nx 23 — it imports
`@nx/workspace/src/utilities/fileutils`, which was removed in 23.

Rather than hand-maintain project templates against every SDK release, the
generators here **delegate scaffolding to the official `flutter create`**, then
fold the result into the workspace. The only opinions this plugin adds are the
pub-workspace wiring, the Nx targets, and the release integration.

## Install

```sh
npm install --save-dev @mnci/nx-flutter
```

Requires the **Flutter SDK** on the `PATH` (3.27+, for Dart 3.6+ pub
workspaces).

## Generators

| Generator          | Default location  | Gets                                                             |
| ------------------ | ----------------- | ---------------------------------------------------------------- |
| `application`      | `apps/<name>`     | `lint`, `test`, `build` (web), `package` (zip into `dist/drop/`) |
| `library`          | `packages/<name>` | `lint`, `test`, plus a `versionActions` override for release     |
| `internal-library` | `libs/<name>`     | `lint`, `test`                                                   |

```sh
nx g @mnci/nx-flutter:application hello
nx g @mnci/nx-flutter:library shared
nx g @mnci/nx-flutter:internal-library core
```

Each accepts an optional `--directory` to override the default location.

## The dependency model: one root pub workspace

This is the point of the plugin. The first generator run writes a root
`pubspec.yaml`, and every generator adds its project to it:

```yaml
name: my_workspace
publish_to: none

environment:
  sdk: ^3.6.0

workspace:
  - apps/hello
  - libs/core
  - packages/shared
```

Each member gets `resolution: workspace` in its own pubspec. One command then
resolves everything:

```sh
flutter pub get     # at the workspace root
```

That produces **one** `pubspec.lock` and **one**
`.dart_tool/package_config.json` for the whole repo — pub actively deletes any
per-package copies it finds.

### Internal dependencies need no `path:`

A workspace member depends on another with a **plain version constraint**:

```yaml
# packages/shared/pubspec.yaml
dependencies:
  core: ^0.0.1 # resolves to libs/core, because it is a workspace member
```

No `path:` override, and **no vendoring step** — contrast the Python side of
this monorepo, where `mnci add python-vendor` exists only because pip cannot
bundle an unpublished sibling into a wheel. Dart has a real workspace protocol,
so there is nothing to weave in at build time.

## Executors

| Executor | Runs                             | Notes                                                           |
| -------- | -------------------------------- | --------------------------------------------------------------- |
| `lint`   | `flutter analyze --fatal-infos`  | see below — the flag is pinned deliberately                     |
| `test`   | `flutter test`                   | no install step needed; the root `pub get` covers every project |
| `build`  | `flutter build web --output ...` | writes a **directory** under the workspace-root `dist/`         |

### `--fatal-infos` is pinned on purpose

`flutter analyze` already defaults it on — verified against 3.44.8, where
`--no-fatal-infos` turns a failing lint run green. It is passed explicitly
anyway, because that default is the only thing making this a real gate: nearly
every `flutter_lints` rule reports at **info** severity.

Worth knowing that plain `dart analyze` defaults the _opposite_ way (it fails on
errors and warnings but not infos), so swapping the command without carrying the
flag across would silently stop enforcing anything.

### Build output is a directory, not a file

`build` writes to `dist/apps/<name>/`. Nx scans each declared `outputs` entry in
order to cache it, and scanning a bare file raises `ENOTDIR` — a failure that
only surfaces once caching is on. `flutter build web --output` writes a
directory natively, so this falls out for free.

Note the two coordinate systems: the target's `outputPath` option is
**workspace-relative** (matching its `{workspaceRoot}` outputs token), while
`flutter build --output` resolves against the **project** directory. The
executor converts between them, which also keeps it correct on Windows.

## Central lint configuration

The first generator run also writes a root `analysis_options.yaml` including
`package:flutter_lints/flutter.yaml`. Each project's own file is a one-line
relative `include:` of it, so a rule change lands in one place:

```yaml
# apps/hello/analysis_options.yaml
include: ../../analysis_options.yaml
```

## Release integration

The `library` generator stamps a project-level `versionActions` override:

```json
{
  "release": {
    "version": { "versionActions": "@mnci/nx-flutter/release/version-actions" }
  }
}
```

**This is load-bearing, not a nicety.** Nx's default implementation reads a
`package.json`, which a Dart package does not have. Without the override
`nx release` aborts while building the release graph — which takes down the
release of **every** project in the workspace, not just the Dart one.

`DartVersionActions` reads and writes the top-level `version:` of
`pubspec.yaml`. Publishing is **by git tag**: there is no registry upload step,
since Azure Artifacts has no pub/Dart feed type and these packages are
deliberately not pushed to pub.dev. `nx release` versions and tags them; no
`nx-release-publish` target is written.

## Known constraints

- **Web is the only platform scaffolded.** Web needs nothing beyond the Flutter
  SDK; an Android build would drag the whole Android SDK and NDK onto every
  build agent. Add others per-app with `flutter create --platforms=...`.
- **Project names are converted for Dart.** Nx keeps the hyphenated name
  (`my-app`), while the Dart package becomes `my_app` — pub rejects hyphens
  outright.
- **A member must be in both places.** `resolution: workspace` _and_ an entry in
  the root `workspace:` list. Miss either and pub silently resolves that project
  standalone, giving it its own lockfile and dropping it out of the shared
  resolution. The generators always write both.
