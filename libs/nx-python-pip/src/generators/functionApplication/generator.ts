import { addProjectConfiguration, formatFiles, type Tree } from '@nx/devkit'
import {
  PYTHON_FUNCTION_APP_HOST_JSON,
  PYTHON_FUNCTION_APP_REQUIREMENTS,
  PYTHON_FUNCTION_APP_GREETING,
  pythonFunctionAppGreetingTest,
  pythonFunctionAppMain,
} from '../../internal/azureFunctionApp'
import { pythonModuleDirectory } from '../../internal/pythonProject'
import type { FunctionAppGeneratorSchema } from './schema.d'

/**
 * Generates a Python Azure Function app (v2 programming model): `function_app.py`
 * + `host.json` + `requirements.txt` + a tested pure helper module.
 *
 * @remarks
 * No `pyproject.toml`/`build` target: the deployable is the **source tree**
 * (Azure's Python worker installs `requirements.txt` and runs
 * `function_app.py` directly — Oryx build at deploy time, no wheel), so this
 * generator writes no build system at all. `func` CLI is not needed to
 * generate — only for local `func start`.
 *
 * @param tree - The Nx virtual file system.
 * @param options - The project name and directory.
 * @returns A promise that resolves once generated files are formatted.
 * @throws Never - pure Tree writes.
 * @typeParam None - this function has no generic type parameters.
 */
export default async function functionAppGenerator (tree: Tree, options: FunctionAppGeneratorSchema): Promise<void> {
  const root = options.directory ?? `apps/${options.name}`
  const moduleDirectory = pythonModuleDirectory(options.name)

  addProjectConfiguration(tree, options.name, {
    root,
    projectType: 'application',
    sourceRoot:  root,
    targets:     {
      lint: { executor: '@mnci/nx-python-pip:lint', options: {} },
      test: { executor: '@mnci/nx-python-pip:test', options: { installEditable: false } },
    },
  })

  tree.write(`${root}/function_app.py`, pythonFunctionAppMain(moduleDirectory))
  tree.write(`${root}/host.json`, PYTHON_FUNCTION_APP_HOST_JSON)
  tree.write(`${root}/requirements.txt`, PYTHON_FUNCTION_APP_REQUIREMENTS)
  tree.write(`${root}/${moduleDirectory}/greeting.py`, PYTHON_FUNCTION_APP_GREETING)
  tree.write(`${root}/tests/test_greeting.py`, pythonFunctionAppGreetingTest(moduleDirectory))
  await formatFiles(tree)
}
