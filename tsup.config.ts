import { defineConfig } from 'tsup'

export default defineConfig({
  entry:     { cli: 'src/cli.ts' },
  format:    ['cjs'],
  target:    'node20',
  platform:  'node',
  clean:     true,
  sourcemap: true,
  dts:       false,
  // The breaking-change hints load the *target repo's* typescript at runtime;
  // never bundle the compiler into the CLI.
  external:  ['typescript'],
  banner:    { js: '#!/usr/bin/env node' },
})
