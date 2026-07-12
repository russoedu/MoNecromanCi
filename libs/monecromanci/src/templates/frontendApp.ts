import { TAGS } from '../engine/constants'
import { toJson } from '../engine/fsx'
import type { FileSpec, ProjectVars } from '../engine/types'

/** Per-framework specifics layered onto the shared Vite frontend template. */
interface FrontendFramework {
  tag:              string
  /** DOM id the app mounts into. */
  mountId:          string
  /** Vite plugin import line and call expression. */
  vitePluginImport: string
  vitePluginCall:   string
  /** Sample single-file-component path + content. */
  componentPath:    string
  componentContent: string
  /** `src/main.ts` content. */
  mainContent:      string
  /** `src/vite-env.d.ts` content (client types + a module shim). */
  envContent:       string
}

/** Builds an `nx:run-commands` target that runs `command` from the project's own directory. */
function runInProject (command: string): { executor: string, options: { command: string, cwd: string } } {
  return { executor: 'nx:run-commands', options: { command, cwd: '{projectRoot}' } }
}

/** Builds the app's package.json (scripts run the shared root toolchain). */
function appPackageJson (vars: ProjectVars): string {
  return toJson({
    name:    vars.packageName,
    version: '0.0.0',
    private: true,
    type:    'module',
    // build/build:dev/build:uat/build:prod/build:all/dev are real commands,
    // NOT delegators: the toolchain's context.mjs resolveReactBuildPlan reads
    // these exact script names straight from package.json (via
    // resolveProjectScripts) to pick the right per-branch build — turning
    // them into `nx run` delegators would remove the names it looks for and
    // break branch-aware CI builds. Only test/lint (which nothing else
    // introspects) delegate to project.json's tool-owned targets.
    scripts: {
      dev:          'vite',
      'build:dev':  'vite build --mode dev --outDir dist-dev',
      'build:uat':  'vite build --mode uat --outDir dist-uat',
      'build:prod': 'vite build --mode prod --outDir dist-prod',
      'build:all':  'npm run build:dev && npm run build:uat && npm run build:prod',
      build:        'npm run build:dev',
      preview:      'vite preview',
      lint:         `nx run ${vars.name}:lint`,
      test:         `nx run ${vars.name}:test`,
    },
  })
}

/** Builds the NX project.json with build/serve/test/lint targets. */
function appProjectJson (vars: ProjectVars, framework: FrontendFramework): string {
  const run = (target: string): { executor: string, options: { command: string } } => ({
    executor: 'nx:run-commands',
    options:  { command: `npm run ${target} -w ${vars.packageName}` },
  })

  return toJson({
    name:        vars.name,
    $schema:     '../../node_modules/nx/schemas/project-schema.json',
    sourceRoot:  `apps/${vars.name}/src`,
    projectType: 'application',
    tags:        [framework.tag, ...(vars.extraTags ?? [])],
    targets:     {
      // Still delegates to package.json (not inlined): the branch-aware
      // build variant it runs (build/build:dev/build:uat/...) is decided by
      // context.mjs's resolveReactBuildPlan, not by this target.
      build: {
        executor: 'nx:run-commands',
        outputs:  ['{projectRoot}/dist-dev', '{projectRoot}/dist-uat', '{projectRoot}/dist-prod'],
        options:  { command: `npm run build -w ${vars.packageName}` },
      },
      serve: run('dev'),
      test:  runInProject('jest --collectCoverage'),
      lint:  runInProject('eslint . -c ../../eslint.config.mjs'),
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
      types:                        ['vite/client', 'node'],
      noEmit:                       true,
      sourceMap:                    true,
      allowSyntheticDefaultImports: true,
      esModuleInterop:              true,
    },
    include: ['src', 'vite.config.ts'],
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

/** Builds the vite config for the chosen framework plugin. */
function viteConfig (framework: FrontendFramework): string {
  return `${framework.vitePluginImport}
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [${framework.vitePluginCall}], server: { port: 5173 }, build: { sourcemap: true } })
`
}

/** Builds the Vite index.html entry page. */
function indexHtml (vars: ProjectVars, framework: FrontendFramework): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${vars.name}</title>
  </head>
  <body>
    <div id="${framework.mountId}"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`
}

const greetingTs = `/**
 * Returns the greeting rendered by the app.
 *
 * @remarks Shared TS logic — unit-tested directly so no SFC test transform is needed.
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
  return `VITE_ENVIRONMENT=${environment}\nVITE_API_URL=https://${environment}.example.com\n`
}

const VUE: FrontendFramework = {
  tag:              TAGS.vueApp,
  mountId:          'app',
  vitePluginImport: 'import vue from \'@vitejs/plugin-vue\'',
  vitePluginCall:   'vue()',
  componentPath:    'src/App.vue',
  componentContent: `<script setup lang="ts">
import { greet } from './greeting'

const message = greet('Vue')
</script>

<template>
  <main>
    <h1>{{ message }}</h1>
  </main>
</template>
`,
  mainContent: `import { createApp } from 'vue'
import App from './App.vue'

createApp(App).mount('#app')
`,
  envContent: `/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent
  export default component
}
`,
}

const SVELTE: FrontendFramework = {
  tag:              TAGS.svelteApp,
  mountId:          'app',
  vitePluginImport: 'import { svelte } from \'@sveltejs/vite-plugin-svelte\'',
  vitePluginCall:   'svelte()',
  componentPath:    'src/App.svelte',
  componentContent: `<script lang="ts">
  import { greet } from './greeting'

  const message = greet('Svelte')
</script>

<main>
  <h1>{ message }</h1>
</main>
`,
  mainContent: `import { mount } from 'svelte'
import App from './App.svelte'

mount(App, { target: document.querySelector('#app')! })
`,
  envContent: `/// <reference types="vite/client" />

declare module '*.svelte' {
  import type { Component } from 'svelte'

  const component: Component
  export default component
}
`,
}

/** Assembles the file set shared by the Vue and Svelte app kinds. */
function frontendAppFiles (vars: ProjectVars, framework: FrontendFramework): FileSpec[] {
  const root = `apps/${vars.name}`
  const file = (path: string, content: string, ownership: FileSpec['ownership']): FileSpec => ({ path: `${root}/${path}`, content, ownership })

  return [
    file('package.json', appPackageJson(vars), 'scaffold'),
    file('project.json', appProjectJson(vars, framework), 'tool-owned'),
    file('tsconfig.json', appTsconfig(), 'tool-owned'),
    file('vite.config.ts', viteConfig(framework), 'scaffold'),
    file('index.html', indexHtml(vars, framework), 'scaffold'),
    file('jest.config.mjs', `import { createConfig } from 'monecromanci-toolchain/jest.preset.mjs'\n\nexport default createConfig('${vars.name}')\n`, 'tool-owned'),
    file('typedoc.json', appTypedoc(), 'tool-owned'),
    file('.env.dev', envFile('dev'), 'scaffold'),
    file('.env.uat', envFile('uat'), 'scaffold'),
    file('.env.prod', envFile('prod'), 'scaffold'),
    file('src/vite-env.d.ts', framework.envContent, 'scaffold'),
    file('src/main.ts', framework.mainContent, 'scaffold'),
    file(framework.componentPath, framework.componentContent, 'scaffold'),
    file('src/greeting.ts', greetingTs, 'scaffold'),
    file('src/greeting.test.ts', greetingTestTs, 'scaffold'),
  ]
}

/**
 * Files for a Vue (Vite) app at `apps/<name>` with dev/uat/prod builds.
 *
 * @remarks
 * The `.vue` SFC is built by Vite (and not linted); jest covers the shared TS
 * helper so no SFC test transform is required.
 *
 * @param vars - The project's template inputs.
 * @returns The full set of file specs for the Vue app.
 * @throws Never - performs no I/O; callers (e.g. {@link applyFiles}) handle writes.
 * @typeParam None - this function has no generic type parameters.
 */
export function vueAppFiles (vars: ProjectVars): FileSpec[] {
  return frontendAppFiles(vars, VUE)
}

/**
 * Files for a Svelte (Vite) app at `apps/<name>` with dev/uat/prod builds.
 *
 * @remarks
 * The `.svelte` SFC is built by Vite (and not linted); jest covers the shared TS
 * helper so no SFC test transform is required.
 *
 * @param vars - The project's template inputs.
 * @returns The full set of file specs for the Svelte app.
 * @throws Never - performs no I/O; callers (e.g. {@link applyFiles}) handle writes.
 * @typeParam None - this function has no generic type parameters.
 */
export function svelteAppFiles (vars: ProjectVars): FileSpec[] {
  return frontendAppFiles(vars, SVELTE)
}
