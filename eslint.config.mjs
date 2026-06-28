// Mirrors src/templates/eslintConfig.ts (ESLINT_CONFIG_MJS) — the config nx-magic
// itself hands out to generated monorepos — so the tool dogfoods its own template.
import markdown from '@eslint/markdown'
import pluginJest from 'eslint-plugin-jest'
import jsonc from 'eslint-plugin-jsonc'
import unicorn from 'eslint-plugin-unicorn'
import unusedImports from 'eslint-plugin-unused-imports'
import yaml from 'eslint-plugin-yml'
import globalsConfig from 'globals'
import neostandard from 'neostandard'

const code = ['**/*.{ts,mts,cts}', '**/*.{js,mjs,cjs}']
const tests = ['**/*.{test,spec}.{ts,mts,cts}', '**/*.{test,spec}.{js,mjs,cjs}']

// @stylistic and @typescript-eslint plugins are registered by neostandard; their
// rules resolve here because flat config merges plugins per matched file.
const projectRules = {
  semi:                                       ['error', 'never'],
  '@stylistic/comma-dangle':                  ['error', 'always-multiline'],
  '@stylistic/key-spacing':                   ['error', { align: { beforeColon: false, afterColon: true, on: 'value' } }],
  // key-spacing's alignment inserts the multi-space runs that no-multi-spaces
  // would otherwise strip back out on type literals/interfaces; exempt those.
  '@stylistic/no-multi-spaces':               ['error', { exceptions: { TSTypeAnnotation: true, TSIndexSignature: true, PropertyDefinition: true } }],
  '@typescript-eslint/no-explicit-any':       'off',
  '@typescript-eslint/no-non-null-assertion': 'off',
  '@typescript-eslint/no-unused-vars':        'off',
  'unused-imports/no-unused-imports':         'error',
  'unused-imports/no-unused-vars':            ['warn', { vars: 'all', args: 'after-used', varsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
  'unicorn/no-null':                          'off',
  'unicorn/prefer-top-level-await':           'off',
  'unicorn/prefer-module':                    'off',
  'unicorn/prevent-abbreviations':            ['error', {
    ignore:                   [/err/i, /dev/i, /db/i, /(pre)?(pro?d)/i, /conf(ig)?/i, /env/i, /dist/i, /req/i, /res/i, /lib/i, /vars?/i, /Props/],
    checkShorthandProperties: false,
  }],
  'unicorn/filename-case':       ['error', { cases: { camelCase: true, pascalCase: true }, ignore: [/^_.+\.[jt]s$/, /^[a-z][\w-]*\.config\.[jt]s$/] }],
  // Codebase-wide convention is named imports from node:path; allow alongside the rule's default.
  'unicorn/import-style':        ['error', { styles: { 'node:path': { named: true } } }],
  // We intentionally emit ${...} literals (VSCode launch vars, npm authToken).
  'no-template-curly-in-string': 'off',
}

const testRules = {
  '@typescript-eslint/no-require-imports': 'off',
  '@typescript-eslint/no-empty-function':  'off',
  'unicorn/consistent-function-scoping':   'off',
  'no-new':                                'off',
}

// Several plugin "recommended" presets ship rule blocks with no `files` filter
// (meant to apply broadly to their own JS/JSON/YAML-shaped ASTs). @eslint/markdown
// parses .md through ESLint's newer "Language" API, whose SourceCode doesn't
// implement everything a generic rule may assume (e.g. `getAllComments`,
// `parserServices`), so those unscoped blocks crash instead of simply no-op'ing
// on markdown. Keep markdown out of every preset except the dedicated md block below.
const excludeMarkdown = (configs) => configs.map((config) => ({ ...config, ignores: [...(config.ignores ?? []), '**/*.md'] }))

export default [
  {
    ignores: [
      'coverage/*', 'dist/*', 'node_modules/**', '**/node_modules', 'package-lock.json',
      // Vendored templates copied verbatim into generated repos — not this project's own style.
      'assets/**',
    ],
  },

  // Standard style (no semicolons) + @stylistic + typescript-eslint (non type-checked).
  ...excludeMarkdown(neostandard({ ts: true })),

  // Unicorn for all TS/JS.
  { ...unicorn.configs.recommended, files: code },

  // Project rule tweaks + unused-imports.
  {
    files:           code,
    plugins:         { 'unused-imports': unusedImports },
    languageOptions: { globals: { ...globalsConfig.node } },
    rules:           projectRules,
  },

  // Jest tests.
  {
    files:           tests,
    plugins:         { jest: pluginJest },
    languageOptions: { globals: { ...globalsConfig.jest } },
    rules:           testRules,
  },

  // JSON / JSONC / JSON5.
  ...excludeMarkdown(jsonc.configs['flat/recommended-with-json']),
  ...excludeMarkdown(jsonc.configs['flat/recommended-with-jsonc']),
  ...excludeMarkdown(jsonc.configs['flat/recommended-with-json5']),

  // YAML.
  ...excludeMarkdown(yaml.configs['flat/standard']),

  // Markdown.
  { files: ['**/*.md'], plugins: { markdown }, language: 'markdown/gfm' },
]
