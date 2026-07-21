#!/usr/bin/env node
// Copies every src/**/schema.json alongside its compiled generator.js/executor.js
// in dist/ — tsc only emits .ts -> .js/.d.ts, so the schemas Nx resolves
// generators.json/executors.json against need this separate step.
import { cpSync, globSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const schemas = globSync('src/**/schema.json')
for (const schema of schemas) {
  const destination = join('dist', schema.slice('src/'.length))
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(schema, destination)
}
console.log(`Copied ${schemas.length} schema.json file(s) into dist/.`)
