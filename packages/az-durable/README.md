# @mnci/az-durable

Compile-time type safety across the Azure Durable Functions
orchestrator/activity boundary.

The SDK types an activity call as `any` in and `any` out. Every input you pass
and every result you read is unchecked, so a shape change on one side of the
boundary surfaces at runtime, in an orchestration that may already have
instances in flight. This package makes both ends typed, with no code
generation, no fork, and nothing to keep in sync.

```ts
// Without: `article` is any. `article.titel` compiles.
const article = yield context.df.callActivity('FetchArticle', { id })

// With: `article` is FetchArticle's real return type. `article.titel` does not.
const article = yield * callActivity(context, fetchArticle, { id })
```

## Install

```bash
npm install @mnci/az-durable
```

`durable-functions` (>=3 <4) and `@azure/functions` (>=4 <5) are **peer**
dependencies — the ones your Function App already has. This package declares no
dependencies of its own.

## The mechanism, in one paragraph

A generator has exactly one `TNext` shared by every `yield` in it, so
`const x = yield callActivity(...)` can never be typed per call — whatever `x`
is, it is the same type for every yield in the orchestration. `yield *` is
different: it returns the *delegated* generator's `TReturn`, which **is** per
call. That is the whole trick, and it is why every scheduling helper here is a
generator you delegate to rather than a value you yield. Getting it wrong is a
compile error, not a silent `any`.

## Defining the boundary

```ts
import { defineActivity, defineOrchestration, callActivity } from '@mnci/az-durable'

export const fetchArticle = defineActivity(
  'FetchArticle',                                   // the registered name, verbatim
  async (input: { id: string }) => await db.get(input.id)   // types inferred from here
)

export const publish = defineOrchestration(
  'PublishArticle',
  function * (context, input: { id: string }) {
    const article = yield * callActivity(context, fetchArticle, { id: input.id })
    return { title: article.title }
  }
)
```

Names are string literals you write, and the package will never generate one.
**A name is baked into every orchestration's history**: renaming it breaks
in-flight instances, which resume against the new code expecting the old name.
Duplicate registrations throw at startup rather than silently shadowing.

### Validating input at the boundary

`context.df.getInput<T>()` is an unchecked cast — `T` is a claim the SDK never
verifies. It matters more here than in ordinary code, because orchestration
input comes back *out of the task hub*: an instance started by yesterday's
deploy resumes against today's code, so a shape change between deploys arrives
as a silently wrong object.

```ts
defineOrchestration('ResetSite', handler, { parse: parseResetRequest })
```

## Scheduling

Every helper comes in two forms: a **generator** you `yield *` for the common
sequential case, and a **task** you hold to run things concurrently.

| Delegate with `yield *` | Hold as a task | Produces |
| --- | --- | --- |
| `callActivity` | `activityTask` | the activity's return type |
| `callSubOrchestration` | `subOrchestrationTask` | the sub-orchestration's return type |
| `waitForEvent` | `eventTask` | the event's payload type |
| `sleepFor` / `sleepUntil` | `timerTask` / `timerTaskUntil` | `void` |

### Fan-out

`all` preserves a tuple positionally, and maps an array to an array:

```ts
const [html, slug] = yield * all(context, [
  activityTask(context, renderHtml, draft),
  activityTask(context, buildSlug, draft.title)
])                                   // [string, string]

const results = yield * all(
  context,
  items.map(i => activityTask(context, deleteItem, { id: i.id }))
)                                    // { deleted: boolean, bytes: number }[]
```

### Racing

`any` returns the **winning task**, matching the SDK. Read its value with
`resultOf`, and identify the winner by identity:

```ts
const approval = eventTask(context, approved)
const deadline = timerTask(context, ONE_DAY_MS)

const winner = yield * any(context, [approval, deadline])
if (winner === deadline) {
  return { published: false, reason: 'approval timed out' }
}
if (!deadline.isCompleted()) {
  deadline.cancel()          // REQUIRED — see below
}
const { approvedBy } = resultOf(approval)
```

**Cancel the losing timer.** An orchestration does not complete until every
scheduled timer has fired or been cancelled, so a timeout timer left pending
after its race is won keeps the instance alive until it expires. `timerTask`
returns `cancel()` and `isCompleted()` for exactly this.

### Retries

`RetryOptions` is a class in the SDK, so an object literal cannot satisfy it.
`retryPolicy` takes the plain object and builds a real instance:

```ts
yield * callActivity(context, store, input, retryPolicy({
  firstRetryIntervalInMilliseconds: 1000,
  maxNumberOfAttempts: 3,
  backoffCoefficient: 2
}))
```

### Restarting an eternal orchestration

History grows with every call, so a sweep over an unbounded backlog must
restart rather than keep going. `continueAsNew` arrives as a third handler
argument, because it restarts *this* orchestration and so its input is checked
against this orchestration's own type:

```ts
defineOrchestration('Cleanup', function * (context, input: Sweep, self) {
  // ...
  self.continueAsNew({ olderThanDays: input.olderThanDays })
  return summary          // return immediately after; the SDK requires it
})
```

## Testing

`@mnci/az-durable/testing` drives an orchestration against stubbed activities
with no Azure running — no host, no emulator, no storage.

```ts
import { runWorkflow } from '@mnci/az-durable/testing'

const run = runWorkflow(publish, { id: 'a1' }, {
  activities: { FetchArticle: () => ({ title: 'T' }) }
})

expect(run.result).toEqual({ title: 'T' })
expect(run.calls.map(c => c.name)).toEqual(['FetchArticle'])   // order matters
```

- **`calls` is ordered**, because reordering two activity calls is a breaking
  change to an orchestration. That makes it directly assertable.
- **Returning an `Error` from a stub throws inside the orchestration**, so
  `catch` branches and compensation paths are testable.
- **`raceWinner` picks the winner of an `any`**, by scheduled name (a timer is
  `__timer`). Without it the first candidate always wins and the other branch
  is unreachable.
- **`now` fixes the clock**; **`instanceId` sets the instance id.**
- **`continuedAsNew`** reports a restart request. The harness records it and
  lets the run finish rather than looping — an eternal orchestration restarts
  forever by design. The next generation is a separate `runWorkflow` call.

Stated rather than discovered later: **retry policies are not simulated** — a
stub returning an `Error` throws once, it does not exhaust attempts. Timers
complete immediately.

## Lint rules

```js
// eslint.config.mjs
import { recommended } from '@mnci/az-durable/eslint-plugin'
export default [recommended]
```

| Rule | Default | What it catches |
| --- | --- | --- |
| `no-untyped-activity-handler` | error | `: ActivityHandler` and friends, which are aliases for `(any, context) => any` — legal TypeScript that silently erases the handler's real signature |
| `no-nondeterministic-orchestrator` | error | `new Date()`, `Date.now`, `Math.random`, `crypto.randomUUID`, `process.env`, `fetch` inside an orchestration |
| `require-yield-star` | warn | `yield callActivity(...)` where `yield *` is meant |

`no-untyped-activity-handler` is the one that earns its keep: the annotation is
legal, so nothing errors — the types simply stop meaning anything. Its nastier
form is a middleware wrapper typed `(h: ActivityHandler) => ActivityHandler`,
which collapses **every** handler it wraps, so one helper can disable type
safety across a whole Function App.

`require-yield-star` is a warning rather than an error because the compiler
already rejects the code it flags (`TS2345` through `defineOrchestration`); the
rule only says so more clearly.

The determinism rule matches on call-site **shape** and does not follow values,
so an orchestration body extracted into a helper function is not caught. That
is a documented limit rather than a defect — following the value would need
type information the rule deliberately does not depend on.

## What this does not do

- **No name generation.** See above; names are yours.
- **Not engine-agnostic.** It is a typed layer over `durable-functions`, not an
  abstraction that could target another engine.
- **No `async`/`await` orchestrators.** Durable's replay model requires
  generators.
- **Not a fork or a patch.** Every call goes through the public SDK surface;
  nothing here reads an undocumented internal.
- **Entity functions are not covered.**
