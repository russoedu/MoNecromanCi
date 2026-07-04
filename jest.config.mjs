import { globSync } from 'node:fs'

const projects = globSync('{libs,apps}/*/jest.config.mjs').map((path) => path.replaceAll('\\', '/'))

export default {
  projects: projects.length > 0 ? projects : ['<rootDir>'],
  maxWorkers: '75%',
}
