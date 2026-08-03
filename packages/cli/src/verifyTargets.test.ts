/**
 * Roadmap #24 — a guard against a verify target that does not verify anything.
 *
 * Nx *disables* an inferred target rather than dropping it: when a project's
 * tsconfig sets `noEmit: true`, the `typecheck` target survives in the graph
 * with its command replaced by
 * `echo "The 'typecheck' target is disabled because …"`. Running it therefore
 * **passes**, which is how `@mnci/nx-flutter` and `@mnci/nx-python-pip` both
 * shipped a fake `typecheck` for months while CI reported green.
 *
 * CI structurally cannot catch that by running the target — the stub exits 0.
 * The only thing that can is an assertion about the target's *command*, which
 * is what this file makes. It reads the real Nx project graph (so inference,
 * `targetDefaults` and plugins are all accounted for), resolves every verify
 * target down to the shell command it ultimately runs — following
 * `npm run <script>` indirection, since most of them are one hop from a
 * `package.json` script — and fails when that command is a no-op.
 *
 * The target list is not hardcoded: it comes from this workspace's own
 * `affected` root script, the one CI runs. Add a target to that script and it
 * is covered here automatically.
 *
 * This lives in `@mnci/cli` rather than in `mnci doctor` on purpose. Doctor
 * checks generated workspaces, and the trap cannot occur in one — neither mnci
 * nor any `@nx/*` generator writes `noEmit` into a tsconfig. The invariant that
 * needs guarding is *this* repo's.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const WORKSPACE_ROOT = join(__dirname, '..', '..', '..')

/** How many `npm run …` hops to follow before assuming a cycle. */
const MAX_SCRIPT_HOPS = 5

/**
 * Targets a project is allowed to be missing, and why. A target that is absent
 * is a weaker gate than a stubbed one, not a stronger one: `nx run-many -t X`
 * silently skips every project without an `X`, so an omission has to be a
 * recorded decision rather than an accident.
 */
const ABSENT_BY_DESIGN: Record<string, Record<string, string>> = {
  '@mnci/source': {
    // The workspace root pseudo-project. `includedScripts: []` in the root
    // manifest is deliberate — its scripts are the aggregators (`nx run-many`),
    // so inferring targets from them would recurse.
    typecheck: 'the root has no sources of its own; each package typechecks itself',
    test: 'the root has no sources of its own; each package tests itself',
    build: 'the root has no sources of its own; each package builds itself'
  },
  '@mnci/eslint-config': {
    // Plain ESM a consumer loads directly, so there is nothing to compile —
    // and a build step would risk the published config drifting from source.
    build: 'published as source — a build step could let dist/ drift from it'
  },
  '@mnci/oxlint-config': {
    // Same reasoning as @mnci/eslint-config: plain ESM that oxlint loads
    // directly. It has `lint`, `typecheck` and `test` targets like every other
    // project — this guard caught its absence of `build` the moment the package
    // was added, which is what the exemption table is for.
    build: 'published as source — a build step could let dist/ drift from it'
  }
  // No project is exempt from `typecheck`, deliberately. `tsconfig.base.json`
  // sets `isolatedModules: true`, which puts ts-jest in transpile-only mode, so
  // jest reports no type errors at all (verified: a `const x: number = 'y'` in a
  // spec passes). Every spec in the workspace is therefore type-checked only by
  // the `typecheck` target's tsconfig — which is why exempting a project from it
  // silently un-checks its tests, the same hole #20 found in the two plugins.
}

/** A no-op command: passes without verifying anything. */
const NO_OP = /^(?:echo|:|true|exit\s+0)\b/

type NxTarget = {
  executor?: string
  options?: {
    command?: string
    commands?: (string | { command?: string })[]
    script?: string
  }
}

type NxNode = { data: { root: string; targets?: Record<string, NxTarget> } }

/**
 * Dumps the real project graph, so what is asserted is what Nx would actually
 * run rather than what the checked-in config appears to say.
 *
 * @returns The graph's project nodes, keyed by project name.
 * @throws If `nx graph` fails or writes nothing readable.
 */
function projectGraph(): Record<string, NxNode> {
  const dir = mkdtempSync(join(tmpdir(), 'mnci-graph-'))
  const file = join(dir, 'graph.json')
  try {
    const result = spawnSync(`npx nx graph --file "${file}"`, {
      cwd: WORKSPACE_ROOT,
      encoding: 'utf8',
      shell: true
    })
    if (result.status !== 0 || !existsSync(file)) {
      throw new Error(
        `nx graph failed (status ${String(result.status)}):\n${result.stdout ?? ''}\n${result.stderr ?? ''}`
      )
    }
    return JSON.parse(readFileSync(file, 'utf8')).graph.nodes
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Reads one `package.json` script.
 *
 * @param projectRoot - Directory of the manifest, relative to the workspace root.
 * @param script - Script name to look up.
 * @returns The script's command, or `undefined` if the manifest or script is absent.
 */
function scriptCommand(projectRoot: string, script: string): string | undefined {
  const manifest = join(WORKSPACE_ROOT, projectRoot, 'package.json')
  if (!existsSync(manifest)) return undefined
  const scripts = JSON.parse(readFileSync(manifest, 'utf8')).scripts as
    Record<string, string> | undefined
  return scripts?.[script]
}

/** Maps a project name to its root, so `npm run … -w <name>` can be followed. */
function rootsByName(graph: Record<string, NxNode>): Map<string, string> {
  return new Map(Object.entries(graph).map(([name, node]) => [name, node.data.root]))
}

/**
 * Follows `npm run <script> [-w <package>]` to the command it runs. Most verify
 * targets here are one such hop from a `package.json` script, so a stub could
 * hide in the script rather than in the target.
 *
 * @param command - A shell command, possibly an `npm run` indirection.
 * @param projectRoot - Root of the project the command runs in.
 * @param roots - Project name to project root, for the `-w` form.
 * @returns The command a shell would ultimately execute.
 */
function followNpmRun(command: string, projectRoot: string, roots: Map<string, string>): string {
  let current = command.trim()
  for (let hop = 0; hop < MAX_SCRIPT_HOPS; hop++) {
    const match = /^npm run ([\w:.@/-]+)(?:\s+-w\s+(\S+))?\s*$/.exec(current)
    if (!match) return current
    const [, script, workspace] = match
    const root = workspace ? roots.get(workspace) : projectRoot
    if (root === undefined) return current
    const next = scriptCommand(root, script)
    if (next === undefined) {
      throw new Error(`"${current}" refers to a script that does not exist`)
    }
    current = next.trim()
  }
  throw new Error(`"${command}" still resolves to an npm run after ${MAX_SCRIPT_HOPS} hops`)
}

/**
 * Resolves a target to the shell commands it runs. A target driven by a real
 * Nx executor resolves to that executor's name: it is code, not a shell string,
 * and cannot be a shell no-op.
 *
 * @param target - The target as it appears in the project graph.
 * @param projectRoot - Root of the project the target belongs to.
 * @param roots - Project name to project root, for the `-w` form.
 * @returns Every command the target would run; never empty.
 */
function resolveCommands(
  target: NxTarget,
  projectRoot: string,
  roots: Map<string, string>
): string[] {
  const { executor, options } = target
  if (executor === 'nx:run-script') {
    const script = options?.script ?? ''
    const command = scriptCommand(projectRoot, script)
    if (command === undefined) {
      throw new Error(`nx:run-script points at a missing script "${script}"`)
    }
    return [followNpmRun(command, projectRoot, roots)]
  }
  if (executor === 'nx:run-commands') {
    const raw = [
      ...(options?.command === undefined ? [] : [options.command]),
      ...(options?.commands ?? []).map(entry =>
        typeof entry === 'string' ? entry : (entry.command ?? '')
      )
    ]
    if (raw.length === 0) throw new Error('nx:run-commands with no command')
    return raw.map(command => followNpmRun(command, projectRoot, roots))
  }
  return [`<executor ${executor ?? 'unset'}>`]
}

const graph = projectGraph()
const roots = rootsByName(graph)
const projects = Object.keys(graph).toSorted((a, b) => a.localeCompare(b))

/**
 * The targets CI verifies, read from the root `affected` script rather than
 * duplicated, so the guard cannot cover a narrower set than CI runs.
 */
const verifyTargets = (() => {
  const script = (
    JSON.parse(readFileSync(join(WORKSPACE_ROOT, 'package.json'), 'utf8')).scripts as Record<
      string,
      string
    >
  ).affected
  const match = /(?:^|\s)-t\s+([\w,:.-]+)/.exec(script ?? '')
  if (!match) {
    throw new Error(`could not read a "-t <targets>" list out of the affected script: ${script}`)
  }
  return match[1].split(',')
})()

describe('every verify target in this workspace runs a real command', () => {
  it('reads a non-empty target list out of the root affected script', () => {
    expect(verifyTargets).toContain('typecheck')
    expect(verifyTargets.length).toBeGreaterThan(1)
  })

  it('found the workspace projects', () => {
    expect(projects).toContain('@mnci/cli')
    expect(projects.length).toBeGreaterThan(1)
  })

  describe.each(verifyTargets)('%s', targetName => {
    it.each(projects)('%s', project => {
      const target = graph[project].data.targets?.[targetName]
      const exemption = ABSENT_BY_DESIGN[project]?.[targetName]

      if (!target) {
        // A missing target is only acceptable as a recorded decision: without
        // one, `nx run-many` skips the project and reports success.
        if (exemption === undefined) {
          throw new Error(
            `${project} has no "${targetName}" target and no recorded reason for that. ` +
              'Either give it one, or add an ABSENT_BY_DESIGN entry saying why it needs none.'
          )
        }
        expect(exemption).not.toBe('')
        return
      }

      expect(exemption).toBeUndefined()
      const commands = resolveCommands(target, graph[project].data.root, roots)
      for (const command of commands) {
        // The failure this catches: `echo "The 'typecheck' target is disabled
        // because one or more project references set 'noEmit: true' …"`.
        expect(command).not.toMatch(NO_OP)
        expect(command).not.toBe('')
      }
    })
  })
})
