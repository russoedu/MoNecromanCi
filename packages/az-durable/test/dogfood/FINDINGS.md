# Phase 7 findings

What the reconstructed workflows found. Every one of these was invisible to the
41 unit tests and two type-test suites that were green before this phase, which
is the argument for dogfooding — even against reconstructions.

Read `./README.md` first: these are **not** the real workflows, so the findings
below are about shapes the API could not express, not about production traffic.

## 1. `RetryOptions` is a class, so no object literal satisfies it

`activityTask`/`callActivity` take `retry?: RetryOptions`, and the SDK declares
`RetryOptions` as a **class** with five members, three of which are only
settable after construction. So this — the obvious call — does not compile:

```ts
yield * callActivity(context, store, input, {
  maxNumberOfAttempts: 3,
  firstRetryIntervalInMilliseconds: 1000
})
// TS2739: missing backoffCoefficient, maxRetryIntervalInMilliseconds,
//         retryTimeoutInMilliseconds
```

The working form is `new RetryOptions(1000, 3)`, which means a **value** import
of `durable-functions` in consumer code.

**Not changed, deliberately.** Accepting a plain object and passing it to
`callActivityWithRetry` would rely on the SDK reading it structurally at
runtime — undocumented behaviour, which §14 of the plan forbids working around.
Constructing the class inside the package would make `durable-functions` a value
import here, which the zero-runtime-dependency design rules out. So the finding
is a **documentation** one: the retry form must be shown, or every consumer
rediscovers this.

## 2. Only activities had a task form, so no race could be written

`all` and `any` take `TypedTask`s, and the only producer of one was
`activityTask`. `waitForEvent`, `sleepFor` and `callSubOrchestration` were
generator-only. The consequence is not a rough edge — it is that the single most
common Durable Functions pattern **could not be expressed at all**:

> wait for human approval, or time out

**Fixed.** Added `eventTask`, `timerTask`, `timerTaskUntil` and
`subOrchestrationTask`, with each `call*`/`wait*` generator now delegating to its
task form so there is one scheduling site per kind and the two cannot drift.

`timerTask` returns a `TypedTimerTask` carrying `cancel()` and `isCompleted()`,
because **an orchestration does not complete until every scheduled timer has
fired or been cancelled** — a timeout timer left pending after its race is won
keeps the instance alive until it expires.

## 3. The harness could not drive any orchestration that used `any`

Every race failed with `Task.any returned a task that was not one of the
inputs.` The fake `Task.any` returned the winning task, which the driver then
**resolved to a value** before resuming the generator — but the SDK's `Task.any`
resolves to the winning **task**, which the caller then reads with `resultOf`.

**Fixed**: `Task.any` now yields a marker the driver settles by picking a
winner, populating its `result` and marking it completed.

## 4. A correctly-written timer cancellation crashed the harness

The fake timer had no `cancel`, so an orchestration that did the right thing —
cancelling the losing timer — died with a `TypeError` in its own test. The
worst shape of harness bug: it punishes correct code.

**Fixed**: fake timers carry `cancel()` and `isCanceled`.

## 5. Stub errors never reached the orchestration's `catch`

The documented behaviour was:

> Returning an `Error` instance makes that call THROW inside the orchestration,
> which is how failure branches and retry-exhaustion paths become testable.

It did not. `resolve` threw in the **driver loop**, outside the generator, so the
error propagated out of `runWorkflow` and no `try/catch` in the orchestration
could ever see it. **Every compensation path was untestable** while the
docstring promised the opposite — and compensation is the entire reason a
destructive workflow like `resetSharePoint` is safe to run.

The existing test passed because it asserted only that `runWorkflow` throws,
which is true under both behaviours, over an orchestration with no `try/catch`.
Another gate that verified nothing.

**Fixed**: stub errors are injected with `generator.throw`. Harness errors (a
missing stub, a bad `raceWinner`) still throw normally — swallowing one of those
in an orchestration's `catch` would turn a broken test green.

## 6. Race outcomes were not selectable, so half of every race was dead code

`Task.any` resolved to the first candidate, always. The timeout branch of an
approval race — including the one guarding a **destructive** reset — could not
be reached by any test.

**Fixed**: `WorkflowStub.raceWinner` picks the winner by scheduled name.

## What is still not verified

These reconstructions were written by the same author as the API, so they
confirm that the API composes over shapes that author thought of. Findings 2–6
are real defects it found, which is evidence the exercise was worth doing — but
it is not the evidence the real workflows would give. Specifically untested:
real SDK behaviour end to end (no Functions host is involved anywhere here),
retry exhaustion, `continueAsNew` for eternal orchestrations (not exposed by
this package at all — no reconstruction needed it, and the real `cleanup` may),
and entity functions.
