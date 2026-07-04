import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { ChangedProject } from './changes'
import { TAGS } from './constants'
import { readJsonSafe, readTextSafe } from './fsx'

type Ts = typeof import('typescript')

/**
 * One exported symbol of a source file's public surface.
 *
 * @remarks
 * Produced by {@link collectExports}. `signature` is a normalised text form
 * used for change detection: parameters + return type for functions, member
 * names for enums, the annotated type for consts, empty otherwise.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface ExportedApi {
  name:      string
  kind:      string
  signature: string
}

/**
 * Loads the TypeScript compiler, preferring the target repo's own install.
 *
 * @remarks
 * The compiler is never bundled with the CLI (it is `external` in the tsup
 * config); generated repos always carry `typescript` in the pinned toolchain.
 * Falls back to the CLI's own resolution (useful under Jest), and to
 * `undefined` when no compiler can be found — hints are then skipped.
 *
 * @param repoRoot - Absolute path to the repo whose compiler to prefer.
 * @returns The TypeScript module, or `undefined` when unavailable.
 * @throws Never - resolution failures return `undefined`.
 * @typeParam None - this function has no generic type parameters.
 */
export function loadTypescript (repoRoot: string): Ts | undefined {
  try {
    return createRequire(join(repoRoot, 'package.json'))('typescript') as Ts
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional runtime resolution of an unbundled optional module.
      return require('typescript') as Ts
    } catch {
      return undefined
    }
  }
}

/**
 * Collects the exported public surface of a TypeScript source file.
 *
 * @remarks
 * Purely syntactic (no type checker): exported functions carry their
 * parameter/return signature text, enums their member list, consts their
 * annotated type, and classes/interfaces/type aliases/re-exports their name
 * only. `export *` forwards are not followed — this is a per-file heuristic
 * feeding advisory hints, not an authoritative API report.
 *
 * @param ts - The TypeScript module to parse with.
 * @param fileName - The file's name (used for parser diagnostics only).
 * @param source - The file's source text.
 * @returns The exported symbols found.
 * @throws Never - parse errors simply yield fewer symbols.
 * @typeParam None - this function has no generic type parameters.
 */
export function collectExports (ts: Ts, fileName: string, source: string): ExportedApi[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true)
  const exports: ExportedApi[] = []

  const isExported = (statement: { modifiers?: readonly { kind: number }[] }): boolean =>
    (statement.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && isExported(statement) && statement.name) {
      const parameters = statement.parameters.map((parameter) => parameter.getText(sourceFile)).join(', ')
      const returnType = statement.type ? `: ${statement.type.getText(sourceFile)}` : ''
      exports.push({ name: statement.name.text, kind: 'function', signature: `(${parameters})${returnType}` })
    } else if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const type = ts.isIdentifier(declaration.name) && declaration.type ? `: ${declaration.type.getText(sourceFile)}` : ''
        exports.push({ name: declaration.name.getText(sourceFile), kind: 'const', signature: type })
      }
    } else if (ts.isEnumDeclaration(statement) && isExported(statement)) {
      const members = statement.members.map((member) => member.name.getText(sourceFile)).join(', ')
      exports.push({ name: statement.name.text, kind: 'enum', signature: `{ ${members} }` })
    } else if ((ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && isExported(statement) && statement.name) {
      const kind = ts.isClassDeclaration(statement) ? 'class' : (ts.isInterfaceDeclaration(statement) ? 'interface' : 'type')
      exports.push({ name: statement.name.text, kind, signature: '' })
    } else if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        exports.push({ name: element.name.text, kind: 're-export', signature: '' })
      }
    }
  }

  return exports
}

/** Reads a file's content at HEAD, or undefined when it did not exist there. */
function fileAtHead (repoRoot: string, path: string): string | undefined {
  try {
    return execSync(`git show "HEAD:${path}"`, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
  } catch {
    return undefined
  }
}

/** Diffs two export surfaces into human-readable hint messages. */
function diffExports (before: ExportedApi[], after: ExportedApi[], file: string): string[] {
  const hints: string[] = []
  const current = new Map(after.map((entry) => [entry.name, entry]))

  for (const previous of before) {
    const next = current.get(previous.name)
    if (!next) {
      hints.push(`export removed in ${file}: ${previous.kind} ${previous.name}`)
    } else if (previous.signature !== next.signature) {
      hints.push(`signature changed in ${file}: ${previous.name}${previous.signature} → ${next.name}${next.signature}`)
    }
  }

  return hints
}

/** Diffs the install/runtime contract fields of two package.json shapes. */
function diffPackageContract (before: Record<string, unknown>, after: Record<string, unknown>, file: string): string[] {
  const hints: string[] = []

  const enginesBefore = (before.engines as { node?: string } | undefined)?.node
  const enginesAfter = (after.engines as { node?: string } | undefined)?.node
  if (enginesBefore && enginesAfter && enginesBefore !== enginesAfter) {
    hints.push(`engines.node changed in ${file}: ${enginesBefore} → ${enginesAfter}`)
  }

  const peersBefore = (before.peerDependencies as Record<string, string> | undefined) ?? {}
  const peersAfter = (after.peerDependencies as Record<string, string> | undefined) ?? {}
  for (const name of Object.keys(peersAfter)) {
    if (!Object.hasOwn(peersBefore, name)) {
      hints.push(`new peer dependency in ${file}: ${name}`)
    }
  }

  const binBefore = (before.bin as Record<string, string> | undefined) ?? {}
  const binAfter = (after.bin as Record<string, string> | undefined) ?? {}
  for (const name of Object.keys(binBefore)) {
    if (!Object.hasOwn(binAfter, name)) {
      hints.push(`bin removed in ${file}: ${name}`)
    }
  }

  return hints
}

/** Diffs a package.json's contract fields between HEAD and the working tree. */
function contractHints (repoRoot: string, manifestPath: string): string[] {
  const before = fileAtHead(repoRoot, manifestPath)
  if (before === undefined) {
    return []
  }

  const after = readJsonSafe<Record<string, unknown>>(join(repoRoot, manifestPath), {})
  return diffPackageContract(JSON.parse(before) as Record<string, unknown>, after, manifestPath)
}

/** Whether the project at `path` is tagged as publishable (API surface matters). */
function isPublishable (repoRoot: string, path: string): boolean {
  const projectJson = readJsonSafe<Record<string, unknown>>(join(repoRoot, path, 'project.json'), {})
  const tags = Array.isArray(projectJson.tags) ? projectJson.tags.map(String) : []
  return tags.includes(TAGS.publishableLib)
}

/** Collects the Tier-1 export-surface hints for one changed source file. */
function hintsForSourceFile (ts: Ts, repoRoot: string, file: string): string[] {
  const before = fileAtHead(repoRoot, file)
  if (before === undefined) {
    return [] // New file: additions only, never breaking.
  }

  const after = readTextSafe(join(repoRoot, file))
  return diffExports(collectExports(ts, file, before), collectExports(ts, file, after), file)
}

/**
 * Detects *possible* breaking changes in the repo's uncommitted work.
 *
 * @remarks
 * Advisory only — it flags the mechanically detectable cases and cannot see
 * behavioural breaks (same signature, different semantics). Two tiers:
 * package-contract diffs (`engines.node`, new peer dependencies, removed
 * `bin` entries) for the root and publishable projects, and export-surface
 * diffs (removed exports, changed function signatures, removed enum members)
 * for the changed non-test sources of publishable projects. Renames across
 * files can produce false positives; treat every hint as a question, not a
 * verdict.
 *
 * @param repoRoot - Absolute path to the repo root.
 * @param changes - The changed projects from {@link changedProjects}.
 * @returns Hint messages keyed by the changed project's name.
 * @throws Never - git and parser failures degrade to fewer (or no) hints.
 * @typeParam None - this function has no generic type parameters.
 */
export function breakingHints (repoRoot: string, changes: ChangedProject[]): Record<string, string[]> {
  const hints: Record<string, string[]> = {}
  const ts = loadTypescript(repoRoot)

  const add = (project: string, messages: string[]): void => {
    if (messages.length > 0) {
      hints[project] = [...(hints[project] ?? []), ...messages]
    }
  }

  for (const change of changes) {
    if (!change.path) {
      if (change.files.includes('package.json')) {
        add('root', contractHints(repoRoot, 'package.json'))
      }
      continue
    }

    if (!isPublishable(repoRoot, change.path)) {
      continue
    }

    const manifestPath = `${change.path}/package.json`
    if (change.files.includes(manifestPath)) {
      add(change.name, contractHints(repoRoot, manifestPath))
    }

    if (!ts) {
      continue
    }

    for (const file of change.files) {
      if (file.startsWith(`${change.path}/src/`) && /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file)) {
        add(change.name, hintsForSourceFile(ts, repoRoot, file))
      }
    }
  }

  return hints
}
