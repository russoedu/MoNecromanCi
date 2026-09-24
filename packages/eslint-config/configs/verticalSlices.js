import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'

/** The roles a production file may play, as its last suffix before the extension says. */
export const ROLES = ['handler', 'use-case', 'algorithm', 'policy', 'model', 'contract', 'mapper', 'validator', 'repository', 'client', 'store', 'error', 'config', 'enum']

const EXTENSION = String.raw`\.(?:ts|tsx|mts|cts)`
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PRODUCTION = new RegExp(String.raw`^[a-z0-9]+(?:-[a-z0-9]+)*\.(?:${ROLES.join('|')})${EXTENSION}$`)
const TEST = new RegExp(String.raw`\.(?:spec|test)${EXTENSION}$`)
const SOURCE = new RegExp(`${EXTENSION}$`)
const ENTRY = new RegExp(`^(?:index|main)${EXTENSION}$`)
const BARREL = new RegExp(`^index${EXTENSION}$`)
const SIBLING = /^\.\.\/([^./][^/]*)(\/.*)?$/

/**
 * Where a file sits: its project's `src`, the subfeature it belongs to (`null`
 * at the root of `src`), and how deep inside that subfeature.
 *
 * @param filename - The file being linted.
 * @returns Its place, or `null` outside any `src`.
 */
function locate (filename) {
  const parts = filename.split(sep)
  const src = parts.lastIndexOf('src')
  if (src === -1) return null

  return { src: parts.slice(0, src + 1).join(sep), slice: parts.length - src > 2 ? parts[src + 1] : null, depth: parts.length - src - 2 }
}

/** Each project's subfeature graph, built once per lint run: slice name to the slices it imports. */
const graphs = new Map()

/**
 * The subfeatures each subfeature's production files import, by name.
 *
 * @param src - A project's `src` directory.
 * @returns The graph.
 */
function graphOf (src) {
  let graph = graphs.get(src)
  if (graph !== undefined) return graph

  graph = new Map()
  const slices = readdirSync(src, { withFileTypes: true }).filter(entry => entry.isDirectory())
  for (const { name: slice } of slices) {
    const edges = new Set()
    const sources = files(join(src, slice))
    for (const file of sources) {
      const imports = readFileSync(file, 'utf8').matchAll(/(?:from|import\()\s*['"]\.\.\/([^./][^/'"]*)/g)
      for (const [, target] of imports) if (target !== slice) edges.add(target)
    }
    graph.set(slice, edges)
  }
  graphs.set(src, graph)

  return graph
}

/**
 * Every production source file under a directory, tests and fixtures excluded.
 *
 * @param directory - Where to look.
 * @returns Their paths.
 */
function files (directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'fixtures' ? [] : files(path)

    return SOURCE.test(entry.name) && !TEST.test(entry.name) ? [path] : []
  })
}

/**
 * A path back from one slice to another through the graph.
 *
 * @param graph - A project's subfeature graph.
 * @param from - Where to start.
 * @param to - Where to arrive.
 * @param seen - Slices already walked.
 * @returns The slices on the way, or `null` when there is no way.
 */
function pathBetween (graph, from, to, seen = new Set()) {
  if (from === to) return [to]
  if (seen.has(from)) return null
  seen.add(from)
  const nexts = graph.get(from) ?? []
  for (const next of nexts) {
    const rest = pathBetween(graph, next, to, seen)
    if (rest !== null) return [from, ...rest]
  }

  return null
}

const SOURCES = {
  ImportDeclaration:      node => node.source,
  ExportNamedDeclaration: node => node.source,
  ExportAllDeclaration:   node => node.source,
  ImportExpression:       node => (node.source.type === 'Literal' ? node.source : null),
}

/**
 * Visitors that call `check` with every module specifier in the file.
 *
 * @param check - Called with the specifier and its node.
 * @returns ESLint visitors.
 */
function onSpecifiers (check) {
  return Object.fromEntries(Object.entries(SOURCES).map(([type, pick]) => [type, (node) => {
    const source = pick(node)
    if (source !== null && source !== undefined && typeof source.value === 'string') check(source.value, source)
  }]))
}

/** The rules, as a plugin. */
export const plugin = {
  meta:  { name: 'mnci-vertical-slices' },
  rules: {
    'file-role': {
      meta: {
        type:     'problem',
        messages: {
          case:    'Name files and folders in kebab-case: "{{name}}".',
          role:    'A production file ends in its role - .{{roles}} - so "{{name}}" says what it is.',
          nesting: 'A subfeature is flat: "{{name}}" sits in a folder inside one. Split the subfeature instead of nesting it.',
          root:    'Only index and main live at the root of src; "{{name}}" belongs in a subfeature.',
        },
        schema: [],
      },
      create (context) {
        const place = locate(context.filename)
        if (place === null) return {}
        const name = basename(context.filename)

        return {
          Program (node) {
            const folders = relative(place.src, dirname(context.filename)).split(sep).filter(part => part !== '')
            for (const folder of folders) if (folder !== 'fixtures' && !KEBAB.test(folder)) context.report({ node, messageId: 'case', data: { name: folder } })
            if (!ENTRY.test(name) && !KEBAB.test(name.split('.', 1)[0])) context.report({ node, messageId: 'case', data: { name } })
            if (TEST.test(name)) return
            if (place.slice === null) {
              if (!ENTRY.test(name)) context.report({ node, messageId: 'root', data: { name } })
            } else if (place.depth > 1 && !folders.includes('fixtures')) {
              context.report({ node, messageId: 'nesting', data: { name } })
            } else if (!BARREL.test(name) && !PRODUCTION.test(name)) {
              context.report({ node, messageId: 'role', data: { name, roles: ROLES.join(' .') } })
            }
          },
        }
      },
    },

    'no-deep-import': {
      meta: {
        type:     'problem',
        messages: {
          deep: 'Reach "{{slice}}" through its index - import from \'../{{slice}}\', not from a file inside it.',
          self: 'Import the files of your own subfeature directly, never through its own index.',
        },
        schema: [],
      },
      create (context) {
        if (locate(context.filename)?.slice === null) return {}

        return onSpecifiers((specifier, node) => {
          const sibling = SIBLING.exec(specifier)
          if (sibling?.[2] !== undefined) context.report({ node, messageId: 'deep', data: { slice: sibling[1] } })
          if (['.', './', './index'].includes(specifier)) context.report({ node, messageId: 'self' })
        })
      },
    },

    'no-slice-cycle': {
      meta: {
        type:     'problem',
        messages: {
          cycle: 'Subfeatures import each other: {{path}}. Move what both need into a slice they can both depend on.',
        },
        schema: [],
      },
      create (context) {
        const place = locate(context.filename)
        if (place === null || place.slice === null || TEST.test(context.filename)) return {}

        return onSpecifiers((specifier, node) => {
          const sibling = SIBLING.exec(specifier)
          if (sibling === null || sibling[1] === place.slice) return
          const back = pathBetween(graphOf(place.src), sibling[1], place.slice)
          if (back !== null) context.report({ node, messageId: 'cycle', data: { path: [place.slice, ...back].join(' -> ') } })
        })
      },
    },
  },
}

/**
 * Vertical feature slices, enforced: a project's `src` holds subfeatures, each
 * reached only through its `index`, holding flat, kebab-case, role-suffixed
 * files - and no two subfeatures importing each other.
 *
 * @remarks
 * **Opt-in**, because it is an architecture, not a style: most workspaces are
 * not organised this way, and turning it on for them would fail their lint on
 * day one. Enable it with `mnci({ verticalSlices: true })`, or pass the globs of
 * the projects that follow it.
 *
 * Three rules:
 *
 * - `vertical-slices/file-role` - kebab-case names; a production file ends in
 *   its role (`.use-case.ts`, `.policy.ts`, `.algorithm.ts`... see `ROLES`); a
 *   subfeature is flat; only `index` and `main` sit at the root of `src`.
 * - `vertical-slices/no-deep-import` - a sibling subfeature is reached through
 *   its `index` (`'../billing'`), never a file inside it (`'../billing/fee.policy'`),
 *   and a subfeature never imports its own `index`.
 * - `vertical-slices/no-slice-cycle` - no two subfeatures importing each other,
 *   **type-only imports included**. This is the gap `import-x/no-cycle` leaves:
 *   it sees cycles between *files*, and a cycle between two folders usually runs
 *   through different files on each side - a contract in one, a use case in the
 *   other - so no file-level cycle exists to report. Type imports count because
 *   they tie the slices together as surely as values do, even though they are
 *   erased at run time.
 *
 * Tests (`.spec` or `.test`) are exempt from TWO of the three rules, and the
 * split is deliberate rather than an oversight:
 *
 * - `file-role` exempts them, because a test is named for the file it tests
 *   and so has no role suffix by design.
 * - `no-slice-cycle` exempts them, because it describes the PRODUCTION
 *   dependency graph and a spec is not in the shipped bundle.
 * - `no-deep-import` does NOT. It is about respecting a sibling's public API,
 *   and a test reaching past an index couples to that sibling's internals
 *   exactly as production code would: rename a file in one slice and another
 *   slice's test breaks. The rule does not care who wrote the import.
 *
 * This used to be documented as a blanket "tests may reach wherever they need
 * to", which was simply false - a test importing `'../template/x.algorithm'`
 * has always been reported.
 *
 * @param files - Globs of the source this applies to. Default: every project's
 * `src` under `apps/`, `libs/` and `packages/`.
 * @returns The flat config blocks.
 */
export default function verticalSlices (files = [
  'apps/*/src/**/*.{ts,mts,cts,tsx}',
  'libs/*/src/**/*.{ts,mts,cts,tsx}',
  'packages/*/src/**/*.{ts,mts,cts,tsx}',
]) {
  return [
    {
      name:    'mnci/vertical-slices',
      files,
      plugins: { 'vertical-slices': plugin },
      rules:   {
        'vertical-slices/file-role':      'error',
        'vertical-slices/no-deep-import': 'error',
        'vertical-slices/no-slice-cycle': 'error',
      },
    },
  ]
}
