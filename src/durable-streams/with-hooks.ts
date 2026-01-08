/**
 * withHooks - Layer 2 wrapper for DurableStream
 *
 * Pure function that wraps a DurableStream with before/after hooks.
 * No services, no layers - just composition.
 */
import type { Scope, Stream } from "effect"
import { Effect } from "effect"
import type { HookError, StreamHooks } from "./hooks.ts"
import type { InvalidOffsetError, Offset, StorageError, StreamEvent, StreamName } from "./types.ts"

/** DurableStream with hooks has HookError in its append error channel */
export interface HookedDurableStream {
  readonly name: StreamName
  append(opts: { data: unknown }): Effect.Effect<StreamEvent, StorageError | HookError>
  subscribe: (opts?: { offset?: Offset }) => Effect.Effect<
    Stream.Stream<StreamEvent>,
    InvalidOffsetError | StorageError,
    Scope.Scope
  >
  getFrom: (opts: {
    offset: Offset
    limit?: number
  }) => Effect.Effect<ReadonlyArray<StreamEvent>, InvalidOffsetError | StorageError>
  readonly count: Effect.Effect<number, StorageError>
}

/**
 * Wrap a DurableStream with before/after hooks.
 *
 * - Before hooks run sequentially in array order; any failure vetoes append
 * - After hooks run sequentially after successful append; errors logged, don't fail
 * - subscribe/getFrom/count pass through unchanged
 *
 * Note: Returns HookedDurableStream which has HookError in the append error channel.
 */
export const withHooks = (
  base: {
    readonly name: StreamName
    append(opts: { data: unknown }): Effect.Effect<StreamEvent, StorageError>
    subscribe: HookedDurableStream["subscribe"]
    getFrom: HookedDurableStream["getFrom"]
    readonly count: Effect.Effect<number, StorageError>
  },
  hooks: StreamHooks
): HookedDurableStream => {
  const { afterAppend = [], beforeAppend = [] } = hooks

  const append = (opts: { data: unknown }): Effect.Effect<
    StreamEvent,
    StorageError | HookError
  > =>
    Effect.gen(function*() {
      // Run before hooks - failure vetoes append
      for (const hook of beforeAppend) {
        yield* hook.run({ name: base.name, data: opts.data }).pipe(
          Effect.annotateLogs({ hookId: hook.id })
        )
      }

      // Delegate to base
      const event = yield* base.append(opts)

      // Run after hooks - errors logged but don't fail
      for (const hook of afterAppend) {
        yield* hook.run({ name: base.name, event }).pipe(
          Effect.annotateLogs({ hookId: hook.id }),
          Effect.catchAll((e) => Effect.logWarning("After-hook failed", { hookId: hook.id, error: e }))
        )
      }

      return event
    })

  return {
    name: base.name,
    append,
    subscribe: base.subscribe,
    getFrom: base.getFrom,
    count: base.count
  }
}
