import { join } from 'node:path'
import { select } from '@inquirer/prompts'
import { runNx, runShell } from '../nx'
import { promptText } from '../prompts'
import { fileExists, readJson, toJson, writeFileEnsured } from '../util/fsx'
import { logger } from '../util/logger'
import { assertValidProjectName } from '../util/names'
import { addNodeApp, addNodeFunctionApp } from './add/node'
import { addNpmLib } from './add/npmLib'
import { addPythonApp, addPythonFunctionApp, addPythonInternalLib, addPythonLib } from './add/python'
import { addReactApp } from './add/reactApp'
import type { AddOptions, WorkspaceStack } from './add/shared'

export type { AddOptions } from './add/shared'

/**
 * The project kinds v2 can add — deliberately just nine.
 *
 * @remarks
 * Each maps to an official (or established community) Nx plugin generator;
 * v2 itself writes no project files (bar thin overlays). Layout convention
 * drives release scoping: `apps/` (never released), `packages/` (publishable
 * npm, released by `nx release`), `libs/` (internal, never released),
 * `python-packages/` (publishable Python, published by `uv`).
 *
 * The TS/JS kinds use the official `@nx/*` generators only — `node-app` and
 * `node-function-app` are both the plain `@nx/node:application` (no
 * third-party Azure Functions plugin; `node-function-app` is that generator
 * plus a hand-written Azure Functions v4 file overlay). The Python kinds use
 * the community-standard [`@nxlv/python`](https://github.com/lucasvieirasilva/nx-plugins)
 * with **uv + Ruff + pytest** — the industry-standard Python toolchain, and
 * follow the identical app/function-app split. Every kind builds to its own
 * Nx-default output location — no post-generation build-output redirection.
 * Each kind's generation logic lives in its own module under `add/` — see
 * `add/reactApp.ts`, `add/node.ts`, `add/npmLib.ts` and `add/python.ts`
 * (internal-lib is small enough to stay inline below).
 *
 * @typeParam None - this type has no generic type parameters.
 */
export type ProjectKind
  = | 'react-app' | 'node-app' | 'node-function-app' | 'npm-lib' | 'internal-lib'
    | 'python-app' | 'python-function-app' | 'python-lib' | 'python-internal-lib'

/**
 * Every kind {@link runAdd} accepts, in menu order.
 *
 * @remarks
 * Also drives the interactive kind picker shown when `add` is run bare. TS/JS
 * kinds first, then the Python family.
 */
export const PROJECT_KINDS: ProjectKind[] = [
  'react-app', 'node-app', 'node-function-app', 'npm-lib', 'internal-lib',
  'python-app', 'python-function-app', 'python-lib', 'python-internal-lib',
]

/**
 * Adds a project to the workspace by delegating to the matching Nx generator.
 *
 * @remarks
 * A thin dispatcher — the actual generation logic for each kind lives in its
 * own module under `add/` (imported above), so this function only resolves
 * the shared inputs (kind, name, the workspace's stack) and routes to the
 * right one. Pure delegation throughout — v2 performs no post-generation file
 * rewriting beyond each kind's own thin overlay. The known gap (same as v1):
 * a *publishable* lib importing a *private internal* lib cannot be published
 * as-is; internal libs are for apps and other internal libs.
 *
 * @param kind - The project kind, prompted for when omitted.
 * @param name - The project name, prompted for when omitted.
 * @param options - The CLI flags.
 * @returns A promise that resolves when the generator has finished.
 * @throws Error when run outside a workspace root or a generator fails.
 * @typeParam None - this function has no generic type parameters.
 */
export async function runAdd (kind: ProjectKind | undefined, name: string | undefined, options: AddOptions): Promise<void> {
  const workspaceRoot = process.cwd()
  if (!fileExists(join(workspaceRoot, 'nx.json'))) {
    throw new Error('No nx.json found here. Run `add` from the workspace root.')
  }

  // The stack chosen at `mnci2 new` lives in nx.json; every generator (and the
  // hand-built function app) is wired to match it.
  const stack = readWorkspaceStack(workspaceRoot)

  // When the kind was not passed, the user is on the bare/interactive path, so
  // fill in every configuration — including the npm-lib scope (below) that the
  // flag path defaults silently.
  const kindProvided = kind !== undefined
  const resolvedKind = kind ?? await select<ProjectKind>({
    message: 'What kind of project?',
    choices: PROJECT_KINDS.map((value) => ({ name: value, value })),
  })
  const resolvedName = name ?? await promptText('Project name')
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
    case 'node-app': {
      addNodeApp(workspaceRoot, resolvedName, stack)
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
      runNx([
        'g', '@nx/js:lib', `libs/${resolvedName}`,
        '--bundler=tsc',
        `--unitTestRunner=${stack.testRunner}`,
        `--linter=${stack.linter}`,
        '--no-interactive',
      ], workspaceRoot)
      markPrivate(join(workspaceRoot, 'libs', resolvedName, 'package.json'))
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
    default: {
      // Unreachable while every ProjectKind has a case above: `exhaustive`
      // being `never` makes adding a 9th kind without a matching case a
      // *compile-time* error, not just a runtime gap. The CLI itself already
      // rejects an unrecognized value before this ever runs (cli.ts's
      // Argument#choices()); this is the last line of defense for any other
      // caller of runAdd (e.g. a future programmatic use).
      const exhaustive: never = resolvedKind
      throw new Error(`Unknown project kind '${exhaustive as string}'. Expected one of: ${PROJECT_KINDS.join(', ')}.`)
    }
  }

  syncProjectReferences(workspaceRoot)

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
function syncProjectReferences (workspaceRoot: string): void {
  logger.step('Syncing TypeScript project references (nx sync)')
  if (runShell('npx', ['nx', 'sync'], workspaceRoot) !== 0) {
    logger.warn('nx sync did not complete — run `npx nx sync` yourself so cross-project imports resolve in your editor.')
  }
}

/**
 * The workspace stack, read back from the `nx.json` `mnci2.stack` block `new` wrote.
 *
 * @remarks
 * How a one-time `mnci2 new` choice reaches `add`: `mnci2.stack` (written by
 * `mnci2Config` in `overlay.ts`) is the single source of truth — a dedicated
 * block, not inferred from one of Nx's own (three, always-identical)
 * generator-default blocks, so there's no "stay in lockstep" invariant to
 * silently drift. `add` passes the result back to the `@nx/*`
 * generators explicitly (predictable regardless of Nx's own default
 * resolution). The return shape is generator-facing: `linter` is `eslint`, or `none` when the
 * workspace chose oxlint (oxlint is not an Nx linter). Missing/blank (e.g. a
 * workspace generated before this field existed) falls back to the box-out
 * opinion (eslint + jest).
 *
 * @param workspaceRoot - Absolute path to the workspace.
 * @returns The linter and test runner to apply.
 * @throws Propagates any `fs`/JSON error reading `nx.json`.
 * @typeParam None - this function has no generic type parameters.
 */
function readWorkspaceStack (workspaceRoot: string): WorkspaceStack {
  const nxJson = readJson<{ mnci2?: { stack?: { linter?: string, testRunner?: string } } }>(join(workspaceRoot, 'nx.json'))
  const stack = nxJson.mnci2?.stack
  return {
    linter:     stack?.linter === 'oxlint' ? 'none' : 'eslint',
    testRunner: stack?.testRunner === 'vitest' ? 'vitest' : 'jest',
  }
}

/**
 * Sets `"private": true` in a package manifest.
 *
 * @remarks
 * One of the deliberate post-generation touches: it makes internal
 * libraries structurally unpublishable, no matter what future config drifts.
 *
 * @param manifestPath - Absolute path to the lib's `package.json`.
 * @returns Nothing.
 * @throws Propagates any `fs`/JSON error reading or writing the manifest.
 * @typeParam None - this function has no generic type parameters.
 */
function markPrivate (manifestPath: string): void {
  const manifest = readJson<Record<string, unknown>>(manifestPath)
  writeFileEnsured(manifestPath, toJson({ ...manifest, private: true }))
}
