import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Moving a freshly generated workspace into a directory that already exists.
 *
 * @remarks
 * `create-nx-workspace <name>` refuses a directory that is already there
 * (`DIRECTORY_EXISTS`), which rules out the single most common way a repository
 * starts: the host creates it, you clone it, and the clone holds a `.git`
 * directory and possibly a README. Generating elsewhere and moving the result
 * in is the only way through, and doing it by hand is exactly the kind of step
 * that silently loses a file.
 *
 * So the move is the thing that gets written down and tested, rather than left
 * to the reader. The whole risk is in the collisions, so every one of them is
 * decided in advance and reported, and nothing is copied until the target is
 * known to be safe.
 */

/**
 * Entries that never travel: the target's own `.git` is the point of the
 * exercise, and `node_modules` is reinstalled from scratch straight after (the
 * lockfile and the tree are both discarded so npm re-resolves with the
 * overlay's `overrides` in place).
 */
const NEVER_COPIED: ReadonlySet<string> = new Set(['.git', 'node_modules'])

/**
 * Files where an existing copy WINS, because they belong to whoever created
 * the repository rather than to the generator.
 *
 * @remarks
 * A host-created repository routinely arrives with a README and a licence
 * chosen by a human. `create-nx-workspace` writes a README of its own, and
 * treating that as a collision would reject the very case this exists for,
 * while overwriting it would throw away the only hand-written file in the
 * repository. Neither is right, so the existing file stays and the result says
 * so.
 */
const EXISTING_WINS: ReadonlySet<string> = new Set(['README.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt'])

/**
 * Entries whose presence is fatal, checked BEFORE generating anything.
 *
 * @remarks
 * Generating a workspace takes minutes, so the hopeless cases are worth
 * catching first. Any of these means the directory is already a project of some
 * kind, and adopting it would overwrite real work.
 */
const PREFLIGHT_BLOCKERS: readonly string[] = [
  'package.json',
  'nx.json',
  'tsconfig.base.json',
  'node_modules',
  'apps',
  'libs',
  'packages',
]

/**
 * What {@link adoptGeneratedWorkspace} did, for reporting.
 *
 * @remarks
 * Every entry the adoption touched is accounted for in exactly one of these
 * lists, so the caller can print what happened to a directory the user already
 * owned rather than asking them to diff it afterwards.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface AdoptionResult {
  /** Top-level entries copied in from the generated workspace. */
  copied:          string[]
  /** Top-level entries left exactly as they were found (see {@link EXISTING_WINS}). */
  kept:            string[]
  /** `true` when the generated `.gitignore` contributed lines to an existing one. */
  mergedGitignore: boolean
}

/**
 * Rejects a target directory that cannot be adopted, before anything is
 * generated.
 *
 * @remarks
 * Deliberately cheap and deliberately incomplete: it catches a directory that
 * is already a project, so the caller does not spend minutes generating a
 * workspace it is about to throw away. The full collision check happens in
 * {@link adoptGeneratedWorkspace}, where the generated tree is known, and that
 * one still runs before a single file is written.
 *
 * @param target - Absolute path to the directory to adopt.
 * @throws Error when the path is missing, is not a directory, or already holds
 * a project.
 * @returns Nothing; it either passes or throws.
 * @typeParam None - this function has no generic type parameters.
 */
export function assertAdoptableDirectory (target: string): void {
  if (!existsSync(target)) {
    throw new Error(`--into '${target}' does not exist. Create or clone it first.`)
  }
  if (!statSync(target).isDirectory()) {
    throw new Error(`--into '${target}' is not a directory.`)
  }

  const blockers = PREFLIGHT_BLOCKERS.filter(entry => existsSync(join(target, entry)))
  if (blockers.length > 0) {
    throw new Error(
      `--into '${target}' already holds ${blockers.join(', ')}, so it is a project already. ` +
        'Use `mnci upgrade` to re-apply the overlay to an existing workspace, or point --into at an empty checkout.',
    )
  }
}

/**
 * Appends whatever the generated `.gitignore` adds to an existing one.
 *
 * @remarks
 * A merge rather than a choice, because both halves matter and neither is
 * optional. The repository's own file may ignore things the generator knows
 * nothing about; the generated one ignores `.nx/cache`, `dist` and
 * `out-tsc`, and a workspace that commits those is a workspace whose every
 * build shows up as a diff. Lines already present are not repeated, so running
 * it twice changes nothing.
 *
 * @param generatedFile - The generated `.gitignore`.
 * @param targetFile - The existing `.gitignore`, which is rewritten in place.
 * @returns `true` when at least one line was added.
 * @throws Propagates filesystem errors.
 * @typeParam None - this function has no generic type parameters.
 */
function mergeGitignore (generatedFile: string, targetFile: string): boolean {
  const existing = readFileSync(targetFile, 'utf8')
  const present = new Set(existing.split('\n').map(line => line.trim()))
  const additions = readFileSync(generatedFile, 'utf8')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => {
      const trimmed = line.trim()

      return trimmed !== '' && !trimmed.startsWith('#') && !present.has(trimmed)
    })

  if (additions.length === 0) return false

  const separator = existing.endsWith('\n') ? '' : '\n'
  writeFileSync(
    targetFile,
    `${existing}${separator}\n# Added by mnci (Nx workspace)\n${additions.join('\n')}\n`,
  )

  return true
}

/**
 * Moves a generated workspace into an existing directory, keeping its `.git`.
 *
 * @remarks
 * Every collision is resolved before anything is written, so a refusal leaves
 * the target byte-identical to how it was found. The generated tree is
 * discarded by the caller either way.
 *
 * @param generatedRoot - The freshly generated workspace (a staging directory).
 * @param target - The existing directory to adopt.
 * @returns What was copied, kept, and merged.
 * @throws Error naming every colliding entry, when any exists that is not
 * resolved by {@link EXISTING_WINS} or the `.gitignore` merge.
 * @typeParam None - this function has no generic type parameters.
 */
export function adoptGeneratedWorkspace (generatedRoot: string, target: string): AdoptionResult {
  const entries = readdirSync(generatedRoot).filter(entry => !NEVER_COPIED.has(entry))

  const collisions = entries.filter(
    entry =>
      existsSync(join(target, entry)) && !EXISTING_WINS.has(entry) && entry !== '.gitignore',
  )
  if (collisions.length > 0) {
    throw new Error(
      `--into '${target}' already contains ${collisions.join(', ')}, which the new workspace also writes. ` +
        'Move those aside and run it again; nothing has been changed.',
    )
  }

  const result: AdoptionResult = { copied: [], kept: [], mergedGitignore: false }

  for (const entry of entries) {
    const from = join(generatedRoot, entry)
    const to = join(target, entry)

    if (entry === '.gitignore' && existsSync(to)) {
      result.mergedGitignore = mergeGitignore(from, to)
      result.kept.push(entry)
      continue
    }
    if (existsSync(to)) {
      result.kept.push(entry)
      continue
    }

    cpSync(from, to, { recursive: true })
    result.copied.push(entry)
  }

  // The staging copy has served its purpose, and it carries a `.git` of its
  // own (`create-nx-workspace` initialises one), which is worth not leaving
  // behind in a temp directory.
  rmSync(generatedRoot, { recursive: true, force: true })

  return result
}
