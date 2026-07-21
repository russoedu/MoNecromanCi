/**
 * The Azure Functions v2 entry written into a generated Python function app.
 *
 * @remarks
 * The Python v2 programming model: a module-level `func.FunctionApp()` with
 * decorated routes. The handler is thin — the testable logic lives in the
 * module's `greeting.py` (imported here), so pytest needs no `azure-functions`
 * install. Anonymous auth keeps the sample runnable locally with `func start`.
 *
 * @param moduleDirectory - The app's Python module directory (import root).
 * @returns The `function_app.py` contents.
 * @throws Never - pure string build.
 * @typeParam None - this function has no generic type parameters.
 */
export function pythonFunctionAppMain (moduleDirectory: string): string {
  return `import azure.functions as func

from ${moduleDirectory}.greeting import build_greeting

app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)


@app.route(route="hello")
def hello(req: func.HttpRequest) -> func.HttpResponse:
    name = req.params.get("name", "world")
    return func.HttpResponse(build_greeting(name))
`
}

/**
 * The `host.json` written into a generated Python function app.
 *
 * @remarks
 * The v4 extension bundle is what the Functions host uses to resolve bindings;
 * `version: 2.0` is the runtime schema. Deliberately minimal.
 */
export const PYTHON_FUNCTION_APP_HOST_JSON = `{
  "version": "2.0",
  "extensionBundle": {
    "id": "Microsoft.Azure.Functions.ExtensionBundle",
    "version": "[4.*, 5.0.0)"
  }
}
`

/**
 * The `requirements.txt` written into a generated Python function app.
 *
 * @remarks
 * Azure's Python worker installs these at deploy time (Oryx build). Only the
 * SDK is needed for the sample; app deps are added here as the app grows.
 */
export const PYTHON_FUNCTION_APP_REQUIREMENTS = `azure-functions
`

/**
 * A sample pure helper written into a Python function app's module.
 *
 * @remarks
 * Gives the app a genuinely testable unit (the HTTP handler would need the
 * Functions runtime), so pytest has a real passing test out of the box.
 */
export const PYTHON_FUNCTION_APP_GREETING = `def build_greeting(name: str) -> str:
    """Build the greeting returned by the sample HTTP function."""
    return "Hello, " + name + "!"
`

/**
 * The sample pytest proving the Python function app's test target runs.
 *
 * @remarks
 * Imports only the pure helper (no `azure-functions`), so it passes with
 * plain `pytest` — no install step needed.
 *
 * @param moduleDirectory - The app's Python module directory (import root).
 * @returns The `tests/test_greeting.py` contents.
 * @throws Never - pure string build.
 * @typeParam None - this function has no generic type parameters.
 */
export function pythonFunctionAppGreetingTest (moduleDirectory: string): string {
  return `from ${moduleDirectory}.greeting import build_greeting


def test_build_greeting() -> None:
    assert build_greeting("world") == "Hello, world!"
`
}
