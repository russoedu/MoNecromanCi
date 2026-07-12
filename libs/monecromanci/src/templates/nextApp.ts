import { TAGS } from '../engine/constants'
import { toJson } from '../engine/fsx'
import type { FileSpec, ProjectVars } from '../engine/types'

/** Builds the dotenv-wrapped per-environment Next.js build script line. */
const buildEnvScript = (environment: string): string => `dotenv -e .env.${environment} -- node ../../node_modules/monecromanci-toolchain/scripts/next-build.mjs ${environment}`

/** Builds the app's package.json (scripts run the shared root toolchain). */
function appPackageJson (vars: ProjectVars): string {
  return toJson({
    name:    vars.packageName,
    version: '0.0.0',
    private: true,
    type:    'module',
    scripts: {
      dev:          'next dev',
      'build:dev':  buildEnvScript('dev'),
      'build:uat':  buildEnvScript('uat'),
      'build:prod': buildEnvScript('prod'),
      'build:all':  'npm run build:dev && npm run build:uat && npm run build:prod',
      build:        'npm run build:dev',
      start:        'next start',
      lint:         'eslint . -c ../../eslint.config.mjs',
      test:         'jest --collectCoverage',
    },
  })
}

/** Builds the NX project.json with build/serve/test/lint targets. */
function appProjectJson (vars: ProjectVars): string {
  const run = (target: string): { executor: string, options: { command: string } } => ({
    executor: 'nx:run-commands',
    options:  { command: `npm run ${target} -w ${vars.packageName}` },
  })

  return toJson({
    name:        vars.name,
    $schema:     '../../node_modules/nx/schemas/project-schema.json',
    sourceRoot:  `apps/${vars.name}/src`,
    projectType: 'application',
    tags:        [TAGS.nextjsApp, ...(vars.extraTags ?? [])],
    targets:     {
      build: {
        executor: 'nx:run-commands',
        outputs:  ['{projectRoot}/dist-dev', '{projectRoot}/dist-uat', '{projectRoot}/dist-prod'],
        options:  { command: `npm run build -w ${vars.packageName}` },
      },
      serve: run('dev'),
      test:  run('test'),
      lint:  run('lint'),
    },
  })
}

/** Builds the project tsconfig extending the shared base. */
function appTsconfig (): string {
  return toJson({
    extends:         'monecromanci-toolchain/tsconfig.base.json',
    compilerOptions: {
      target:           'es2022',
      lib:              ['es2022', 'dom', 'dom.iterable'],
      jsx:              'preserve',
      module:           'esnext',
      moduleResolution: 'bundler',
      types:            ['node'],
      noEmit:           true,
      allowJs:          true,
      esModuleInterop:  true,
      incremental:      true,
      plugins:          [{ name: 'next' }],
    },
    include: ['next-env.d.ts', 'src', '.next/types/**/*.ts'],
    exclude: ['node_modules'],
  })
}

/** Builds the typedoc.json extending the repo-level config. */
function appTypedoc (): string {
  return toJson({
    extends:     ['monecromanci-toolchain/typedoc.json'],
    entryPoints: ['./src'],
    out:         'doc',
    exclude:     ['./node_modules/**', './src/**/*.test.ts'],
  })
}

const nextConfig = `import path from 'node:path'

// ESLint runs as its own monorepo target (npm run lint); Next type-checks the build.
const nextConfig = { output: process.env.NEXT_OUTPUT === 'export' ? 'export' : 'standalone', outputFileTracingRoot: path.join(import.meta.dirname, '..', '..'), eslint: { ignoreDuringBuilds: true } }

export default nextConfig
`

/** Builds the root layout component source. */
function layoutTsx (vars: ProjectVars): string {
  return `import type { ReactNode } from 'react'

export const metadata = { title: '${vars.name}' }

// Root layout required by the Next.js App Router; wraps every page.
export default function RootLayout ({ children }: { children: ReactNode }) {
  return (
    <html lang='en'>
      <body>{ children }</body>
    </html>
  )
}
`
}

const pageTsx = `import { greet } from '../greeting'

// Home page (App Router server component).
export default function Home () {
  return (
    <main>
      <h1>{greet('Next.js')}</h1>
    </main>
  )
}
`

const greetingTs = `/**
 * Returns the greeting rendered on the home page.
 *
 * @remarks Shared TS logic — unit-tested directly (no Next.js test transform needed).
 * @param name - The name to greet.
 * @returns The greeting text.
 * @throws Never - performs no I/O.
 * @typeParam None - this function has no generic type parameters.
 */
export function greet (name: string): string {
  return 'Hello from ' + name + '!'
}
`

const greetingTestTs = `import { greet } from './greeting'

describe('greet', () => {
  it('greets the given name', () => {
    expect(greet('world')).toBe('Hello from world!')
  })
})
`

/** Builds a per-environment .env file. */
function envFile (environment: string): string {
  return `NEXT_PUBLIC_ENVIRONMENT=${environment}\nNEXT_PUBLIC_API_URL=https://${environment}.example.com\n`
}

/**
 * Files for a full-stack Next.js app at `apps/<name>`.
 *
 * @remarks
 * App Router with dev/uat/prod builds assembled into `dist-<env>` by
 * `monecromanci-toolchain/scripts/next-build.mjs` (server-standalone by
 * default, or static export via `NEXT_OUTPUT=export`). The page/layout are
 * built by Next; jest covers the shared TS helper.
 *
 * @param vars - The project's template inputs.
 * @returns The full set of file specs for the Next.js app.
 * @throws Never - performs no I/O; callers (e.g. {@link applyFiles}) handle writes.
 * @typeParam None - this function has no generic type parameters.
 */
export function nextAppFiles (vars: ProjectVars): FileSpec[] {
  const root = `apps/${vars.name}`
  const file = (path: string, content: string, ownership: FileSpec['ownership']): FileSpec => ({ path: `${root}/${path}`, content, ownership })

  return [
    file('package.json', appPackageJson(vars), 'scaffold'),
    file('project.json', appProjectJson(vars), 'tool-owned'),
    file('tsconfig.json', appTsconfig(), 'tool-owned'),
    file('next.config.mjs', nextConfig, 'scaffold'),
    file('jest.config.mjs', `import { createConfig } from 'monecromanci-toolchain/jest.preset.mjs'\n\nexport default createConfig('${vars.name}')\n`, 'tool-owned'),
    file('typedoc.json', appTypedoc(), 'tool-owned'),
    file('.env.dev', envFile('dev'), 'scaffold'),
    file('.env.uat', envFile('uat'), 'scaffold'),
    file('.env.prod', envFile('prod'), 'scaffold'),
    file('src/app/layout.tsx', layoutTsx(vars), 'scaffold'),
    file('src/app/page.tsx', pageTsx, 'scaffold'),
    file('src/greeting.ts', greetingTs, 'scaffold'),
    file('src/greeting.test.ts', greetingTestTs, 'scaffold'),
  ]
}
