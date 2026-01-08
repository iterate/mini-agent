/**
 * DurableStreamFactory - Service that creates DurableStream instances
 *
 * Different factory implementations provide different behaviors:
 * - Plain: returns base DurableStream unchanged
 * - WithHooks: wraps streams with before/after hooks
 */
import { Effect, Layer } from "effect"
import { HookError, type StreamHooks } from "./hooks.ts"
import { Storage } from "./storage.ts"
import { type DurableStream, makeDurableStream } from "./stream.ts"
import type { StorageError, StreamName } from "./types.ts"
import { withHooks } from "./with-hooks.ts"

/** Factory interface - creates DurableStream instances (Storage already provided) */
export class DurableStreamFactory extends Effect.Service<DurableStreamFactory>()(
  "@durable-streams/DurableStreamFactory",
  {
    succeed: {
      // Note: Layers provide Storage closure, so make() returns Effect without Storage requirement
      make: (_opts: { name: StreamName }): Effect.Effect<DurableStream, StorageError> =>
        Effect.die("DurableStreamFactory.Default not usable - use Plain or WithHooks layer")
    }
  }
) {
  /** Plain factory - returns base DurableStream unchanged */
  static readonly Plain: Layer.Layer<DurableStreamFactory, never, Storage> = Layer.effect(
    DurableStreamFactory,
    Effect.gen(function*() {
      const storage = yield* Storage
      return {
        make: (opts: { name: StreamName }) => makeDurableStream(opts).pipe(Effect.provideService(Storage, storage))
      } as DurableStreamFactory
    })
  )

  /** Factory that wraps streams with hooks */
  static WithHooks(hooks: StreamHooks): Layer.Layer<DurableStreamFactory, never, Storage> {
    return Layer.effect(
      DurableStreamFactory,
      Effect.gen(function*() {
        const storage = yield* Storage
        return {
          make: (opts: { name: StreamName }) =>
            makeDurableStream(opts).pipe(
              Effect.provideService(Storage, storage),
              // withHooks returns HookedDurableStream which is compatible with DurableStream
              // (HookError is added to append error channel)
              Effect.map((base) => withHooks(base, hooks) as unknown as DurableStream)
            )
        } as DurableStreamFactory
      })
    )
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYGROUND - Define variant configurations here, change ActiveFactory to swap
// ═══════════════════════════════════════════════════════════════════════════════

/** Validated streams - require _type field */
const validatedHooks: StreamHooks = {
  beforeAppend: [
    {
      id: "require-type-field",
      run: ({ data }) => {
        const obj = data as Record<string, unknown>
        if (typeof obj._type !== "string") {
          return Effect.fail(
            new HookError({
              hookId: "require-type-field",
              message: "Data must have _type string field"
            })
          )
        }
        return Effect.void
      }
    }
  ]
}

/** Embryonic agent streams - agent event validation + logging */
const embryonicAgentHooks: StreamHooks = {
  beforeAppend: [
    {
      id: "validate-agent-event",
      run: ({ data }) => {
        const obj = data as Record<string, unknown>
        if (typeof obj._type !== "string" || !obj._type.startsWith("agent:")) {
          return Effect.fail(
            new HookError({
              hookId: "validate-agent-event",
              message: "Agent events must have _type starting with 'agent:'"
            })
          )
        }
        return Effect.void
      }
    }
  ],
  afterAppend: [
    {
      id: "log-agent-event",
      run: ({ event, name }) =>
        Effect.log("Agent event", {
          stream: name,
          offset: event.offset,
          type: (event.data as Record<string, unknown>)._type
        })
    }
  ]
}

// Variant layers
export const PlainFactory = DurableStreamFactory.Plain
export const ValidatedFactory = DurableStreamFactory.WithHooks(validatedHooks)
export const EmbryonicAgentFactory = DurableStreamFactory.WithHooks(embryonicAgentHooks)

// ═══════════════════════════════════════════════════════════════════════════════
// CHANGE THIS LINE TO SWAP IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════════════════════
export const ActiveFactory = PlainFactory
