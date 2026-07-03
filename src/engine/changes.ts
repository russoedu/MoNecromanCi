import { execSync } from 'node:child_process'

/**
 * A project (or the repo root) with uncommitted changes.
 *
 * @remarks
 * Produced by {@link changedProjects}; `name` is the NX project name for
 * `apps/`/`libs/` entries and the literal `root` for everything else.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface ChangedProject {
  /** The project name (folder name under apps//libs/), or `root`. */
  name:  string
  /** Repo-relative project path (`apps/<name>` or `libs/<name>`), absent for `root`. */
  path?: string
  /** The changed files belonging to this project (repo-relative). */
  files: string[]
}

/**
 * Lists the repo's uncommitted changes (staged, unstaged and untracked).
 *
 * @remarks
 * Parses `git status --porcelain`; renames report their new path. Returns an
 * empty list when the directory is not a git repository (or git is missing).
 *
 * @param repoRoot - Absolute path to the repo root.
 * @returns The repo-relative paths of every changed file.
 * @throws Never - git failures are caught and reported as no changes.
 * @typeParam None - this function has no generic type parameters.
 */
export function changedFiles (repoRoot: string): string[] {
  try {
    // --untracked-files=all lists files inside new directories individually
    // (plain --porcelain collapses them to the directory entry).
    const output = execSync('git status --porcelain --untracked-files=all', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    return output
      .split('\n')
      .filter((line) => line.length > 3)
      .map((line) => {
        const path = line.slice(3)
        // Renames are reported as "old -> new"; the new path is what changed.
        const arrow = path.indexOf(' -> ')
        return arrow === -1 ? path : path.slice(arrow + 4)
      })
      .map((path) => path.replaceAll('"', ''))
  } catch {
    return []
  }
}

/**
 * Groups the repo's uncommitted changes by project.
 *
 * @remarks
 * Files under `apps/<name>/` or `libs/<name>/` belong to that project; every
 * other file (root config, docs, pipelines, …) is grouped under `root`.
 * Projects are ordered alphabetically with `root` last, so the list reads as a
 * ready-made conventional-commit scope.
 *
 * @param repoRoot - Absolute path to the repo root.
 * @returns One entry per changed project, each with its changed files.
 * @throws Never - delegates to {@link changedFiles}, which swallows git errors.
 * @typeParam None - this function has no generic type parameters.
 */
export function changedProjects (repoRoot: string): ChangedProject[] {
  const groups = new Map<string, ChangedProject>()

  for (const file of changedFiles(repoRoot)) {
    const match = /^(apps|libs)\/([^/]+)\//.exec(file)
    const name = match ? match[2] : 'root'
    const path = match ? `${match[1]}/${match[2]}` : undefined

    const group = groups.get(name) ?? { name, path, files: [] }
    group.files.push(file)
    groups.set(name, group)
  }

  // eslint-disable-next-line unicorn/prefer-iterator-to-array -- Iterator#toArray needs an ES2025 lib this tsconfig doesn't target.
  return [...groups.values()].toSorted((left, right) => {
    if (left.name === 'root') return 1
    if (right.name === 'root') return -1
    return left.name.localeCompare(right.name)
  })
}
