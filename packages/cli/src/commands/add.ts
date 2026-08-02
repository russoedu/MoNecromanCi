import { join } from 'node:path'
import { select } from '@inquirer/prompts'
import { runNx, runPrettier, runShell } from '../nx'
import { promptText } from '../prompts'
import { fileExists, readJson } from '../util/fsx'
import { logger } from '../util/logger'
import { assertValidProjectName } from '../util/names'
import { addFlutterApp, addFlutterInternalLib, addFlutterLib } from './add/flutter'
import { addGoApp, addGoFunctionApp, addGoInternalLib, addGoLib } from './add/go'
import { addNodeApp, addNodeFunctionApp } from './add/node'
import { addNpmLib } from './add/npmLib'
import {
  addPythonApp,
  addPythonFunctionApp,
  addPythonInternalLib,
  addPythonLib,
  addPythonVendor
} from './add/python'
import { addReactApp } from './add/reactApp'
import { addReactInternalLib, addReactLib } from './add/reactLib'
import {
  markPrivate,
  registerProjectCommands,
  removeGeneratedEslintConfig,
  type AddOptions,
  type WorkspaceStack
} from './add/shared'

export type { AddOptions } from './add/shared'

/**
 * The project kinds this CLI can add — deliberately just nineteen.
 *
 * @remarks
 * Each maps to an official (or established first-party) Nx plugin generator;
 * this CLI itself writes no project files (bar thin overlays). Layout convention
 * drives release scoping: `apps/` (never released), `packages/` (publishable
 * npm, released by `nx release`), `libs/` (internal, never released),
 * `python-packages/` (publishable Python, published by `twine`).
 *
 * The TS/JS kinds use the official `@nx/*` generators only — `node-app` and
 * `node-function-app` are both the plain `@nx/node:application` (no
 * third-party Azure Functions plugin; `node-function-app` is that generator
 * plus a hand-written Azure Functions v4 file overlay). The Python kinds use
 * **`@mnci/nx-python-pip`** (`libs/nx-python-pip` in this same monorepo) — a
 * real Nx plugin this project built and maintains, since no maintained
 * Nx-23-compatible plugin supports pip (every one found ships uv/Poetry
 * only). Its generators write `pyproject.toml` + `project.json` + a sample
 * module/tests around **pip + Ruff + pytest + the standard PyPA
 * `build`/`twine`** — the industry-standard, uv-free Python toolchain — and
 * follow the identical app/function-app split. Every kind builds to its own
 * Nx-default output location — no post-generation build-output redirection.
 * Each kind's generation logic lives in its own module under `add/` — see
 * `add/reactApp.ts`, `add/reactLib.ts`, `add/node.ts`, `add/npmLib.ts` and
 * `add/python.ts` (internal-lib is small enough to stay inline below).
 *
 * The React family covers all three shapes: `react-app` (Vite SPA),
 * `react-lib` (publishable component library) and `react-internal-lib`
 * (private). The two library kinds were missing for a long time, which meant a
 * shared component library could not be built at all — `npm-lib` and
 * `internal-lib` are both `@nx/js:lib`, with no JSX support.
 *
 * The Go kinds use **`@nx-go/nx-go`** — an established third-party plugin,
 * validated empirically against a real Nx 23.1.0 workspace (it declares
 * `@nx/devkit ">= 20 < 23"` as a plain dependency, so npm nests its own
 * devkit copy and everything still works). Go follows the same
 * root-manifest model as TS and Python: `add/go.ts` bootstraps a **single
 * root `go.mod`** on the first Go add (via the plugin's `init` +
 * `convert-to-one-mod`), so every Go project shares one module and a library
 * is imported as `<module>/libs/<name>` — no per-project manifests, no
 * `replace` directives. Because that single-module layout has no per-project
 * `go.mod`, the plugin's inference produces no targets, so mnci writes
 * build/test/lint explicitly (as it does for most kinds anyway). Lint is
 * `golangci-lint` — the executor's own default is plain `go fmt`, which only
 * reformats. Go needs no publish-time dependency injection at all: `go build`
 * links statically.
 *
 * The Flutter kinds use **`@mnci/nx-flutter`** (`packages/nx-flutter` in this
 * same monorepo) — the second real Nx plugin this project builds and
 * maintains, for the same reason as the Python one: no maintained,
 * Nx-23-compatible Flutter plugin exists (`@nxrocks/nx-flutter` cannot even
 * load on Nx 23 — it imports `@nx/workspace/src/utilities/fileutils`, removed
 * in 23). Its generators delegate scaffolding to the official Flutter CLI
 * (`flutter create`), so no template is hand-maintained against SDK releases.
 *
 * Flutter follows the same root-manifest model as the rest: a **Dart pub
 * workspace**, with one root `pubspec.yaml` listing every project and each
 * project carrying `resolution: workspace`, so a single `flutter pub get` at
 * the root resolves the whole graph into one `pubspec.lock`. The payoff is
 * that a project depending on an internal lib declares a **plain version
 * constraint with no `path:`** — pub resolves it locally because it is a
 * workspace member. That is also why Flutter needs no vendoring step (unlike
 * `python-vendor` below): there is nothing to weave in at build time. Apps
 * build for **web** only, which keeps the Android SDK off every build agent.
 *
 * `python-vendor` is the one kind that generates nothing: plain pip has no
 * bundled-local-dependency feature, so wiring an internal Python library
 * into a consumer's built wheel is a hand-edit of the consumer's
 * `pyproject.toml` (see `@mnci/nx-python-pip`'s README) — this kind
 * automates exactly that edit, idempotently, instead of delegating to a
 * generator. `name` is the consumer; the library is `--lib <name>`.
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type ProjectKind =
  | 'react-app'
  | 'react-lib'
  | 'react-internal-lib'
  | 'node-app'
  | 'node-function-app'
  | 'npm-lib'
  | 'internal-lib'
  | 'python-app'
  | 'python-function-app'
  | 'python-lib'
  | 'python-internal-lib'
  | 'python-vendor'
  | 'go-app'
  | 'go-function-app'
  | 'go-lib'
  | 'go-internal-lib'
  | 'flutter-app'
  | 'flutter-lib'
  | 'flutter-internal-lib'

/**
 * Every kind {@link runAdd} accepts, in menu order.
 *
 * @remarks
 * Also drives the interactive kind picker shown when `add` is run bare. The
 * React family first, then the rest of the TS/JS kinds, then Python, Go and
 * Flutter.
 */
export const PROJECT_KINDS: ProjectKind[] = [
  'react-app',
  'react-lib',
  'react-internal-lib',
  'node-app',
  'node-function-app',
  'npm-lib',
  'internal-lib',
  'python-app',
  'python-function-app',
  'python-lib',
  'python-internal-lib',
  'python-vendor',
  'go-app',
  'go-function-app',
  'go-lib',
  'go-internal-lib',
  'flutter-app',
  'flutter-lib',
  'flutter-internal-lib'
]

/**
 * Adds a project to the workspace by delegating to the matching Nx generator.
 *
 * @remarks
 * A thin dispatcher — the actual generation logic for each kind lives in its
 * own module under `add/` (imported above), so this function only resolves
 * the shared inputs (kind, name, the workspace's stack) and routes to the
 * right one. Pure delegation throughout — no post-generation file rewriting
 * beyond each kind's own thin overlay. Known gap: a *publishable* lib
 * importing a *private internal* lib cannot be published as-is; internal
 * libs are for apps and other internal libs.
 *
 * @param kind - The project kind, prompted for when omitted.
 * @param name - The project name, prompted for when omitted.
 * @param options - The CLI flags.
 * @returns A promise that resolves when the generator has finished.
 * @throws Error when run outside a workspace root or a generator fails.
 * @typeParam None - this function has no generic type parameters.
 */
export async function runAdd(
  kind: ProjectKind | undefined,
  name: string | undefined,
  options: AddOptions
): Promise<void> {
  const workspaceRoot = process.cwd()
  if (!fileExists(join(workspaceRoot, 'nx.json'))) {
    throw new Error('No nx.json found here. Run `add` from the workspace root.')
  }

  // The stack chosen at `mnci new` lives in nx.json; every generator (and the
  // hand-built function app) is wired to match it.
  const stack = readWorkspaceStack(workspaceRoot)

  // When the kind was not passed, the user is on the bare/interactive path, so
  // fill in every configuration — including the npm-lib scope (below) that the
  // flag path defaults silently.
  const kindProvided = kind !== undefined
  const resolvedKind =
    kind ??
    (await select<ProjectKind>({
      message: 'What kind of project?',
      choices: PROJECT_KINDS.map(value => ({ name: value, value }))
    }))
  const resolvedName = name ?? (await promptText('Project name'))
  // Fails fast, before any install or generator call: the name becomes a
  // directory, an argv token and (for Python kinds) a module identifier — and
  // an explicitly empty `name` argument bypasses promptText's own non-empty
  // check, which only fires on the prompted path.
  assertValidProjectName(resolvedName, 'Project name')

  switch (resolvedKind) {
    case 'react-app': {
      addReactApp(workspaceRoot, resolvedName, stack)
      break
    }
    case 'react-lib': {
      await addReactLib(workspaceRoot, resolvedName, options, kindProvided, stack)
      break
    }
    case 'react-internal-lib': {
      addReactInternalLib(workspaceRoot, resolvedName, stack)
      break
    }
    case 'node-app': {
      addNodeApp(workspaceRoot, resolvedName, stack, options.framework)
      break
    }
    case 'node-function-app': {
      addNodeFunctionApp(workspaceRoot, resolvedName, stack)
      break
    }
    case 'npm-lib': {
      await addNpmLib(workspaceRoot, resolvedName, options, kindProvided, stack)
      break
    }
    case 'internal-lib': {
      // tsc (not none): the default @nx/enforce-module-boundaries rule forbids
      // buildable libraries (every npm-lib) from importing non-buildable ones,
      // so internal libs must be buildable — just never published (private).
      runNx(
        [
          'g',
          '@nx/js:lib',
          `libs/${resolvedName}`,
          '--bundler=tsc',
          `--unitTestRunner=${stack.testRunner}`,
          '--linter=none',
          '--no-interactive'
        ],
        workspaceRoot
      )
      markPrivate(join(workspaceRoot, 'libs', resolvedName, 'package.json'))
      removeGeneratedEslintConfig(workspaceRoot, `libs/${resolvedName}`)
      registerProjectCommands(workspaceRoot, resolvedName, { build: true })
      break
    }
    case 'python-app': {
      addPythonApp(workspaceRoot, resolvedName)
      break
    }
    case 'python-function-app': {
      addPythonFunctionApp(workspaceRoot, resolvedName)
      break
    }
    case 'python-lib': {
      addPythonLib(workspaceRoot, resolvedName)
      break
    }
    case 'python-internal-lib': {
      addPythonInternalLib(workspaceRoot, resolvedName)
      break
    }
    case 'go-app': {
      addGoApp(workspaceRoot, resolvedName)
      break
    }
    case 'go-function-app': {
      addGoFunctionApp(workspaceRoot, resolvedName)
      break
    }
    case 'go-lib': {
      addGoLib(workspaceRoot, resolvedName)
      break
    }
    case 'go-internal-lib': {
      addGoInternalLib(workspaceRoot, resolvedName)
      break
    }
    case 'flutter-app': {
      addFlutterApp(workspaceRoot, resolvedName)
      break
    }
    case 'flutter-lib': {
      addFlutterLib(workspaceRoot, resolvedName)
      break
    }
    case 'flutter-internal-lib': {
      addFlutterInternalLib(workspaceRoot, resolvedName)
      break
    }
    case 'python-vendor': {
      await addPythonVendor(workspaceRoot, resolvedName, options, kindProvided)
      // `resolvedName` is the consumer, not something newly created — the
      // generic "Added ... 'name'" success message below reads wrong for
      // this kind, so it returns early with its own message instead.
      syncProjectReferences(workspaceRoot)
      runPrettier(workspaceRoot)
      return
    }
    default: {
      // Unreachable while every ProjectKind has a case above: `exhaustive`
      // being `never` makes adding a new kind without a matching case a
      // *compile-time* error, not just a runtime gap. The CLI itself already
      // rejects an unrecognized value before this ever runs (cli.ts's
      // Argument#choices()); this is the last line of defense for any other
      // caller of runAdd (e.g. a future programmatic use).
      const exhaustive: never = resolvedKind
      throw new Error(
        `Unknown project kind '${exhaustive as string}'. Expected one of: ${PROJECT_KINDS.join(', ')}.`
      )
    }
  }

  syncProjectReferences(workspaceRoot)

  // Nx's generators write in their own style (semicolons, double quotes), and
  // `nx sync` plus the root-manifest/`.code-workspace` edits above touch files
  // outside the new project — so this formats the workspace, not just
  // `<projectRoot>`. Keeps `npm run format:check` green after every add.
  runPrettier(workspaceRoot)

  logger.success(`Added ${resolvedKind} '${resolvedName}'.`)
}

/**
 * Regenerates the workspace's TypeScript project references via `nx sync`.
 *
 * @remarks
 * The `--preset=ts` model resolves cross-project imports through TypeScript
 * project references, and those references are maintained by `nx sync` — not
 * by the generators. Without this, a freshly added project's references are
 * stale, so an editor (and a plain `tsc`) cannot resolve `@scope/lib` imports
 * between projects until the user runs `nx sync` by hand: the missing step
 * that leaves VSCode unable to autocomplete across libraries. Run once after
 * every `add` so cross-project imports resolve immediately.
 *
 * Non-fatal: the project is already generated by the time this runs, so a sync
 * failure only warns (with the manual command) rather than failing the whole
 * `add` and leaving the user unsure whether their project was created.
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns Nothing.
 * @throws Never - a non-zero `nx sync` is reported as a warning, not thrown.
 * @typeParam None - this function has no generic type parameters.
 */
function syncProjectReferences(workspaceRoot: string): void {
  logger.step('Syncing TypeScript project references (nx sync)')
  if (runShell('npx', ['nx', 'sync'], workspaceRoot) !== 0) {
    logger.warn(
      'nx sync did not complete — run `npx nx sync` yourself so cross-project imports resolve in your editor.'
    )
  }
}

/**
 * The workspace stack, read back from the `nx.json` `mnci.stack` block `new` wrote.
 *
 * @remarks
 * How a one-time `mnci new` choice reaches `add`: `mnci.stack` (written by
 * `mnciConfig` in `overlay.ts`) is the single source of truth — a dedicated
 * block, not inferred from one of Nx's own (three, always-identical)
 * generator-default blocks, so there's no "stay in lockstep" invariant to
 * silently drift. `add` passes the result back to the `@nx/*`
 * generators explicitly (predictable regardless of Nx's own default
 * resolution). The return shape is generator-facing: `linter` is `eslint`, or `none` when the
 * workspace chose oxlint (oxlint is not an Nx linter). Missing/blank (e.g. a
 * workspace generated before this field existed) falls back to the default
 * opinion (eslint + jest).
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The linter and test runner to apply.
 * @throws Propagates any `fs`/JSON error reading `nx.json`.
 * @typeParam None - this function has no generic type parameters.
 */
function readWorkspaceStack(workspaceRoot: string): WorkspaceStack {
  const nxJson = readJson<{ mnci?: { stack?: { testRunner?: string } } }>(
    join(workspaceRoot, 'nx.json')
  )
  const stack = nxJson.mnci?.stack
  return {
    testRunner: stack?.testRunner === 'vitest' ? 'vitest' : 'jest'
  }
}
