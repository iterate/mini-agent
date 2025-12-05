/**
 * HooksService
 *
 * Extensibility hooks for customizing agent behavior.
 * Hooks are called at key points in the agent lifecycle.
 *
 * Hook Types:
 * - beforeTurn: Transform context before agent turn (e.g., content moderation, token counting)
 * - afterTurn: Transform events after agent turn (e.g., response filtering, can expand 1’N events)
 * - onEvent: Observe all events (e.g., logging, metrics)
 */
import { Context, Effect, Layer } from "effect"
import { type ContextEvent, type ReducedContext } from "./context.model.ts"
import { HookError } from "./errors.ts"

/** Hook that transforms context before an agent turn */
export type BeforeTurnHook = (
  input: ReducedContext
) => Effect.Effect<ReducedContext, HookError>

/** Hook that transforms events after an agent turn (can expand 1’N) */
export type AfterTurnHook = (
  event: ContextEvent
) => Effect.Effect<ReadonlyArray<ContextEvent>, HookError>

/** Hook that observes events (for logging, metrics) */
export type OnEventHook = (
  event: ContextEvent
) => Effect.Effect<void, HookError>

/**
 * HooksService - extensibility layer for agent behavior.
 */
export class HooksService extends Context.Tag("@app/HooksService")<
  HooksService,
  {
    readonly beforeTurn: BeforeTurnHook
    readonly afterTurn: AfterTurnHook
    readonly onEvent: OnEventHook
  }
>() {
  /** Default layer - no-op hooks (pass through unchanged) */
  static readonly layer: Layer.Layer<HooksService> = Layer.succeed(
    HooksService,
    HooksService.of({
      beforeTurn: (input) => Effect.succeed(input),
      afterTurn: (event) => Effect.succeed([event]),
      onEvent: () => Effect.void
    })
  )

  static readonly testLayer = HooksService.layer
}

/** Compose multiple beforeTurn hooks into one (runs in sequence) */
export const composeBeforeTurnHooks = (
  hooks: ReadonlyArray<BeforeTurnHook>
): BeforeTurnHook =>
(input) =>
  hooks.reduce(
    (acc, hook) => Effect.flatMap(acc, hook),
    Effect.succeed(input) as Effect.Effect<ReducedContext, HookError>
  )

/** Compose multiple afterTurn hooks into one (each event passes through all hooks) */
export const composeAfterTurnHooks = (
  hooks: ReadonlyArray<AfterTurnHook>
): AfterTurnHook =>
(event) =>
  hooks.reduce(
    (acc, hook) =>
      Effect.flatMap(acc, (events) =>
        Effect.map(
          Effect.all(events.map(hook)),
          (results) => results.flat()
        )
      ),
    Effect.succeed([event]) as Effect.Effect<ReadonlyArray<ContextEvent>, HookError>
  )

/** Compose multiple onEvent hooks into one (runs all in parallel) */
export const composeOnEventHooks = (
  hooks: ReadonlyArray<OnEventHook>
): OnEventHook =>
(event) =>
  Effect.all(hooks.map((hook) => hook(event)), { discard: true })

/** Create a logging hooks layer */
export const makeLoggingHooksLayer = (): Layer.Layer<HooksService> =>
  Layer.sync(HooksService, () =>
    HooksService.of({
      beforeTurn: Effect.fn("HooksService.beforeTurn")(function*(input: ReducedContext) {
        yield* Effect.log(`Turn starting with ${input.messages.length} messages`)
        return input
      }),
      afterTurn: Effect.fn("HooksService.afterTurn")(function*(event: ContextEvent) {
        if (event._tag === "AssistantMessage") {
          yield* Effect.log(`Response: ${event.content.slice(0, 50)}...`)
        }
        return [event]
      }),
      onEvent: Effect.fn("HooksService.onEvent")(function*(event: ContextEvent) {
        yield* Effect.log(`Event: ${event._tag}`)
      })
    })
  )
