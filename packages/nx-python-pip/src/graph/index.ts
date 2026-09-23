/*
 * The Nx graph plugin's entry point. `nx.json`'s `plugins` array names
 * `@mnci/nx-python-pip/graph`, which resolves here through the package's
 * `exports` map, and Nx calls the `createDependencies` it finds.
 */
export { createDependencies } from './python-dependencies.handler'
