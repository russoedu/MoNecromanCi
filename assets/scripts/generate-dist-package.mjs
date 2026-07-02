#!/usr/bin/env node

/**
 * Generates `dist/package.json` for a publishable library or CLI tool.
 *
 * Because every dependency lives in the monorepo ROOT package.json, a project's
 * own package.json declares no runtime deps. This script fixes the classic
 * "published a package with no dependencies" problem: it scans the built output
 * for the packages actually imported, resolves their versions from the root
 * manifest (and internal workspace packages from their own package.json), and
 * writes a correct, publishable `dist/package.json`.
 *
 * Run from a project directory (cwd = project root) after the build emits dist:
 *   tsc -p ./tsconfig.lib.json && node ../../tools/generate-dist-package.mjs
 *
 * Dist field overrides (main/types/bin) come from `monecromanci.dist` in the
 * project package.json.
 */
import { builtinModules } from 'node:module'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)])

const projectRoot = process.cwd()
const distDir = join(projectRoot, 'dist')

if (!existsSync(distDir)) {
  throw new Error(`dist folder not found at ${distDir} — build the project first`)
}

/** Reads and parses a JSON file, returning {} on failure. */
function readJson (filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return {}
  }
}

/** Finds the workspace root by walking up to a package.json with `workspaces`. */
function findWorkspaceRoot (start) {
  let directory = start
  for (;;) {
    const manifest = readJson(join(directory, 'package.json'))
    if (manifest.workspaces) {
      return directory
    }

    const parent = resolve(directory, '..')
    if (parent === directory) {
      return start
    }
    directory = parent
  }
}

/** Resolves a package name from an import specifier (handles scopes). */
function packageNameOf (specifier) {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/')
    return `${scope}/${name ?? ''}`
  }

  return specifier.split('/', 1)[0]
}

/** Returns whether a specifier is a relative or absolute path import. */
function isPathSpecifier (specifier) {
  return (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    /^[a-zA-Z]:[/\\]/.test(specifier)
  )
}

/** Lists every emitted JS file under a directory. */
function listJsFiles (directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...listJsFiles(full))
    } else if (/\.(c|m)?js$/i.test(entry.name)) {
      files.push(full)
    }
  }

  return files
}

/** Extracts import/require/export specifiers from JS source. */
function extractSpecifiers (source) {
  const found = new Set()
  const patterns = [
    /\bimport\s+[^'"\n]+\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bexport\s+[^'"\n]+\s+from\s+['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) {
        found.add(match[1])
      }
    }
  }

  return [...found]
}

/** Maps workspace package names to their declared versions. */
function resolveWorkspaceVersions (workspaceRoot, rootManifest) {
  const map = new Map()
  for (const pattern of rootManifest.workspaces ?? []) {
    if (!pattern.endsWith('/*')) {
      continue
    }

    const parent = join(workspaceRoot, pattern.slice(0, -2))
    if (!existsSync(parent)) {
      continue
    }

    for (const child of readdirSync(parent, { withFileTypes: true })) {
      if (!child.isDirectory()) {
        continue
      }

      const manifest = readJson(join(parent, child.name, 'package.json'))
      if (manifest.name && manifest.version) {
        map.set(manifest.name, manifest.version)
      }
    }
  }

  return map
}

const sourceManifest = readJson(join(projectRoot, 'package.json'))
const workspaceRoot = findWorkspaceRoot(projectRoot)
const rootManifest = readJson(join(workspaceRoot, 'package.json'))
const rootDependencies = {
  ...rootManifest.dependencies,
  ...rootManifest.optionalDependencies,
  ...rootManifest.devDependencies,
}
const workspaceVersions = resolveWorkspaceVersions(workspaceRoot, rootManifest)

const used = new Set()
for (const file of listJsFiles(distDir)) {
  for (const specifier of extractSpecifiers(readFileSync(file, 'utf8'))) {
    if (isPathSpecifier(specifier) || BUILTINS.has(specifier)) {
      continue
    }
    used.add(packageNameOf(specifier))
  }
}

const dependencies = {}
const missing = []
for (const name of [...used].sort((a, b) => a.localeCompare(b))) {
  if (workspaceVersions.has(name)) {
    dependencies[name] = `^${workspaceVersions.get(name)}`
  } else if (rootDependencies[name]) {
    dependencies[name] = rootDependencies[name]
  } else {
    missing.push(name)
  }
}

if (missing.length > 0) {
  throw new Error(`Missing version for: ${missing.join(', ')} — add them to the root package.json`)
}

const dist = sourceManifest.monecromanci?.dist ?? {}
const distManifest = {
  name: sourceManifest.name,
  version: sourceManifest.version,
  description: sourceManifest.description,
  license: sourceManifest.license,
  main: dist.main ?? './index.js',
  types: dist.types ?? './index.d.ts',
  ...(dist.bin ? { bin: dist.bin } : {}),
  ...(sourceManifest.repository ? { repository: sourceManifest.repository } : {}),
  ...(sourceManifest.publishConfig ? { publishConfig: sourceManifest.publishConfig } : {}),
  dependencies,
}

writeFileSync(join(distDir, 'package.json'), `${JSON.stringify(distManifest, undefined, 2)}\n`, 'utf8')

// CLI bins must be executable scripts: prepend a shebang if the bundler omitted it.
const shebang = '#!/usr/bin/env node\n'
for (const binPath of Object.values(dist.bin ?? {})) {
  const binFile = join(distDir, binPath)
  if (existsSync(binFile)) {
    const content = readFileSync(binFile, 'utf8')
    if (!content.startsWith('#!')) {
      writeFileSync(binFile, shebang + content, 'utf8')
    }
  }
}

process.stdout.write(`Wrote dist/package.json for ${distManifest.name} (${Object.keys(dependencies).length} deps)\n`)
