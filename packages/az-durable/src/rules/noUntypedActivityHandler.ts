import type { Node, Rule } from './shared.js'

/** SDK handler aliases that erase a handler's real signature. */
const ERASING_TYPES = new Set(['ActivityHandler', 'OrchestrationHandler', 'FunctionHandler'])

/**
 * The annotation's type name, if it is a bare type reference.
 *
 * @param annotation - A node carrying a `typeAnnotation`, or `undefined`.
 * @returns The referenced type's name, or `undefined` when it is not a bare reference.
 * @throws Never - pure inspection.
 * @typeParam None - this function has no generic type parameters.
 */
function referencedName (annotation: Node | undefined): string | undefined {
  const typeAnnotation = annotation?.typeAnnotation as Node | undefined
  if (typeAnnotation?.type !== 'TSTypeReference') {
    return undefined
  }
  const typeName = typeAnnotation.typeName as Node | undefined
  return typeName?.type === 'Identifier' ? (typeName.name as string) : undefined
}

/**
 * Flags annotations that collapse a typed handler back to `any`.
 *
 * @remarks
 * **The rule that actually earns its keep**, because TypeScript cannot catch
 * this: the annotation is legal, so nothing errors — the types simply stop
 * meaning anything.
 *
 * `ActivityHandler` is an alias for `FunctionHandler`, which the SDK declares as
 * `(triggerInput: any, context: InvocationContext) => FunctionResult<any>`. So
 * annotating a handler with it discards the very signature `defineActivity`
 * exists to capture, and the activity silently becomes `any` in, `any` out. The
 * package then appears to work — every call compiles — while checking nothing.
 *
 * The second, nastier form is a middleware wrapper typed
 * `(h: ActivityHandler) => ActivityHandler`. That collapses EVERY handler it
 * wraps, so one `injectLogger` helper can quietly disable type safety across a
 * whole Function App. The fix is to make the wrapper generic:
 *
 * ```ts
 * const withLogging = <I, O>(h: (i: I, c: InvocationContext) => O) =>
 *   (i: I, c: InvocationContext): O => { c.log('...'); return h(i, c) }
 * ```
 */
export const noUntypedActivityHandler: Rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow handler annotations that erase inferred types.' },
    schema: [],
    messages: {
      erased:
        "Annotating with '{{name}}' erases the handler's real signature — it is an alias for " +
        '(triggerInput: any, context) => any, so the activity becomes `any` in and `any` out. ' +
        'Drop the annotation and let defineActivity infer it.',
      erasedWrapper:
        "A wrapper typed '{{name}}' collapses every handler it wraps to `any`. " +
        'Make it generic: <I, O>(h: (i: I, c: InvocationContext) => O) => (i: I, c: InvocationContext): O.'
    }
  },
  create (context) {
    return {
      // const handler: ActivityHandler = ...
      Identifier: (node: Node) => {
        const name = referencedName(node.typeAnnotation as Node | undefined)
        if (name === undefined || !ERASING_TYPES.has(name)) {
          return
        }
        // A function PARAMETER annotated this way is the middleware form, which
        // is worse: it erases every handler passed through it, not just one.
        const isParameter = (node.parent as Node | undefined)?.type?.startsWith('TS') === false &&
          ((node.parent as Node | undefined)?.params as unknown[] | undefined)?.includes(node) ===
            true
        context.report({
          node,
          messageId: isParameter ? 'erasedWrapper' : 'erased',
          data: { name }
        })
      }
    }
  }
}
