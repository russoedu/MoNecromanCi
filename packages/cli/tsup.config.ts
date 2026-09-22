import { defineConfig } from 'tsup'

export default defineConfig({
  entry:     { cli: 'src/cli.handler.ts' },
  format:    ['cjs'],
  target:    'node24',
  platform:  'node',
  clean:     true,
  sourcemap: true,
  dts:       false,
  banner:    { js: '#!/usr/bin/env node' },
})
