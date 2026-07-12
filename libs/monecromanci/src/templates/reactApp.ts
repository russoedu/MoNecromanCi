import { TAGS } from '../engine/constants'
import { toJson } from '../engine/fsx'
import type { FileSpec, ProjectVars } from '../engine/types'

/** Builds the app's package.json (scripts run the shared root toolchain). */
function appPackageJson (vars: ProjectVars): string {
  return toJson({
    name:    vars.packageName,
    version: '0.0.0',
    private: true,
    type:    'module',
    scripts: {
      dev:          'vite',
      'build:dev':  'vite build --mode dev --outDir dist-dev',
      'build:uat':  'vite build --mode uat --outDir dist-uat',
      'build:prod': 'vite build --mode prod --outDir dist-prod',
      'build:all':  'npm run build:dev && npm run build:uat && npm run build:prod',
      build:        'npm run build:dev',
      preview:      'vite preview',
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
    tags:        [TAGS.reactApp, ...(vars.extraTags ?? [])],
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
      target:                       'es2022',
      lib:                          ['es2022', 'DOM', 'DOM.Iterable'],
      module:                       'esnext',
      moduleResolution:             'bundler',
      jsx:                          'react-jsx',
      types:                        ['vite/client', 'node'],
      noEmit:                       true,
      sourceMap:                    true,
      allowSyntheticDefaultImports: true,
      esModuleInterop:              true,
    },
    include: ['src', 'vite.config.ts'],
  })
}

/** Builds the ts-jest tsconfig so .tsx tests transpile under Jest. */
function appTsconfigSpec (): string {
  // Used by ts-jest: CommonJS + react-jsx so .tsx tests transpile under Jest.
  return toJson({
    extends:         '../../tsconfig.jest.json',
    compilerOptions: {
      jsx:              'react-jsx',
      module:           'commonjs',
      moduleResolution: 'node',
      types:            ['jest', 'node'],
    },
  })
}

const viteConfigTs = `import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [react()], server: { port: 5173 }, build: { sourcemap: true } })
`

const viteEnvDts = `/// <reference types="vite/client" />
`

/** Builds the Vite index.html entry page. */
function indexHtml (vars: ProjectVars): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${vars.name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`
}

const mainTsx = `import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

// Vite exposes the per-environment .env values on import.meta.env (build --mode).
const environment = import.meta.env.VITE_ENVIRONMENT ?? 'local'
console.info('Starting app in ' + environment + ' mode')

createRoot(document.querySelector('#root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`

const appTsx = `/**
 * Root application component.
 *
 * @remarks The app's UI entry point, rendered by main.tsx.
 * @returns The rendered application markup.
 * @throws Never - a pure render.
 * @typeParam None - this component has no generic type parameters.
 */
export function App () {
  return (
    <main>
      <h1>Hello from your new app</h1>
    </main>
  )
}
`

const appTestTsx = `import '@testing-library/jest-dom'
import { render, screen } from '@testing-library/react'
import { App } from './App'

describe('App', () => {
  it('renders a heading', () => {
    render(<App />)
    expect(screen.getByRole('heading')).toBeInTheDocument()
  })
})
`

/** Builds the project's jest config (jsdom + ts-jest for .tsx). */
const jestConfigMjs = (name: string): string => String.raw`import { createConfig } from 'monecromanci-toolchain/jest.preset.mjs'

const base = createConfig('${name}')

export default { ...base, testEnvironment: 'jsdom', transform: { '^.+\\.[tj]sx?$': ['ts-jest', { tsconfig: './tsconfig.spec.json' }] } }
`

/** Builds a per-environment .env file. */
function envFile (environment: string): string {
  return `VITE_ENVIRONMENT=${environment}\nVITE_API_URL=https://${environment}.example.com\n`
}

/**
 * Files for a React (Vite) app at `apps/<name>` with dev/uat/prod builds.
 *
 * @remarks
 * Generates both `tool-owned` config and `scaffold` source files.
 *
 * @param vars - The project's template inputs.
 * @returns The full set of file specs for the React app.
 * @throws Never - performs no I/O; callers (e.g. {@link applyFiles}) handle writes.
 * @typeParam None - this function has no generic type parameters.
 */
export function reactAppFiles (vars: ProjectVars): FileSpec[] {
  const root = `apps/${vars.name}`
  const file = (path: string, content: string, ownership: FileSpec['ownership']): FileSpec => ({ path: `${root}/${path}`, content, ownership })

  return [
    file('package.json', appPackageJson(vars), 'scaffold'),
    file('project.json', appProjectJson(vars), 'tool-owned'),
    file('tsconfig.json', appTsconfig(), 'tool-owned'),
    file('tsconfig.spec.json', appTsconfigSpec(), 'tool-owned'),
    file('vite.config.ts', viteConfigTs, 'scaffold'),
    file('index.html', indexHtml(vars), 'scaffold'),
    file('jest.config.mjs', jestConfigMjs(vars.name), 'tool-owned'),
    file('.env.dev', envFile('dev'), 'scaffold'),
    file('.env.uat', envFile('uat'), 'scaffold'),
    file('.env.prod', envFile('prod'), 'scaffold'),
    file('src/vite-env.d.ts', viteEnvDts, 'scaffold'),
    file('src/main.tsx', mainTsx, 'scaffold'),
    file('src/App.tsx', appTsx, 'scaffold'),
    file('src/App.test.tsx', appTestTsx, 'scaffold'),
  ]
}
