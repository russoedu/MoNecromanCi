import { RetryOptions } from 'durable-functions'

/**
 * A retry policy as a plain object.
 *
 * @remarks
 * Exists because the SDK's `RetryOptions` is a **class** whose two required
 * settings are constructor arguments and whose three optional ones are mutable
 * properties. That shape cannot be written as an object literal, so without
 * this every caller has to `new RetryOptions(1000, 3)` and then assign the rest
 * — and discover that for themselves, since a literal fails with a `TS2739`
 * naming three members it never mentions.
 *
 * @typeParam None - this interface has no generic type parameters.
 */
export interface RetryPolicy {
  /** The first retry interval, in milliseconds. Must be greater than 0. */
  readonly firstRetryIntervalInMilliseconds: number
  /** How many attempts to make in total, the first included. */
  readonly maxNumberOfAttempts: number
  /** Multiplier applied to the interval after each attempt. Defaults to the SDK's. */
  readonly backoffCoefficient?: number
  /** Ceiling on the interval between attempts, in milliseconds. */
  readonly maxRetryIntervalInMilliseconds?: number
  /** Overall deadline for the retries, in milliseconds. */
  readonly retryTimeoutInMilliseconds?: number
}

/**
 * Builds a real SDK `RetryOptions` from a plain object.
 *
 * @remarks
 * Returns a genuine class instance rather than a structurally-similar literal,
 * deliberately: handing `callActivityWithRetry` a plain object would depend on
 * the SDK reading it structurally, which is undocumented and exactly the kind
 * of internal this package refuses to rely on.
 *
 * Only the properties actually supplied are assigned, so the SDK's own
 * defaults stand for the rest instead of being overwritten with `undefined`.
 *
 * @param policy - The retry settings.
 * @returns An SDK `RetryOptions` instance.
 * @throws Whatever the SDK constructor throws for an invalid interval.
 * @typeParam None - this function has no generic type parameters.
 */
export function retryPolicy (policy: RetryPolicy): RetryOptions {
  const options = new RetryOptions(
    policy.firstRetryIntervalInMilliseconds,
    policy.maxNumberOfAttempts
  )
  if (policy.backoffCoefficient !== undefined) {
    options.backoffCoefficient = policy.backoffCoefficient
  }
  if (policy.maxRetryIntervalInMilliseconds !== undefined) {
    options.maxRetryIntervalInMilliseconds = policy.maxRetryIntervalInMilliseconds
  }
  if (policy.retryTimeoutInMilliseconds !== undefined) {
    options.retryTimeoutInMilliseconds = policy.retryTimeoutInMilliseconds
  }
  return options
}
