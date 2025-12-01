/**
 * Interactive RPC Explorer
 * 
 * Explore available RPCs and call them with JSON payloads
 */

import { Args, Command } from "@effect/cli"
import { RpcClient, RpcSerialization } from "@effect/rpc"
import { FetchHttpClient } from "@effect/platform"
import { Console, Effect, Layer, Option, Stream } from "effect"
import { TaskRpcs, LlmRpcs } from "../shared/schemas"
import { serverUrlOption } from "./options"
import { handleError } from "./error"

// =============================================================================
// Registry of Available RPCs (with stream metadata)
// =============================================================================

interface RpcMethodInfo {
  readonly payload: string
  readonly returns: string
  readonly stream: boolean
}

const RPC_REGISTRY: Record<string, {
  readonly methods: Record<string, RpcMethodInfo>
}> = {
  tasks: {
    methods: {
      list: { payload: "{ all?: boolean }", returns: "Task[]", stream: false },
      add: { payload: "{ text: string }", returns: "Task", stream: false },
      toggle: { payload: "{ id: number }", returns: "Task", stream: false },
      clear: { payload: "{}", returns: "{ cleared: number }", stream: false }
    }
  },
  llm: {
    methods: {
      generate: { payload: "{ prompt: string }", returns: "string", stream: false },
      generateStream: { payload: "{ prompt: string }", returns: "Stream<string>", stream: true }
    }
  }
} as const

// =============================================================================
// List RPCs Command
// =============================================================================

const listRpcsCommand = Command.make("list", {}, () =>
  Effect.gen(function* () {
    yield* Console.log("Available RPC Procedures:\n")

    for (const [groupName, group] of Object.entries(RPC_REGISTRY)) {
      yield* Console.log(`📦 ${groupName}`)
      for (const [method, info] of Object.entries(group.methods)) {
        yield* Console.log(`   └─ ${method}${info.stream ? " (streaming)" : ""}`)
        yield* Console.log(`      Payload: ${info.payload}`)
        yield* Console.log(`      Returns: ${info.returns}`)
      }
      yield* Console.log("")
    }

    yield* Console.log("Use 'rpc call <group> <method> <json>' to invoke an RPC")
  })
).pipe(Command.withDescription("List all available RPC procedures"))

// =============================================================================
// Call RPC Command
// =============================================================================

const callRpcCommand = Command.make(
  "call",
  {
    serverUrl: serverUrlOption,
    group: Args.text({ name: "group" }).pipe(
      Args.withDescription("RPC group (tasks, llm)")
    ),
    method: Args.text({ name: "method" }).pipe(
      Args.withDescription("RPC method name")
    ),
    payload: Args.text({ name: "payload" }).pipe(
      Args.withDescription("JSON payload"),
      Args.optional
    )
  },
  ({ serverUrl, group, method, payload }) =>
    Effect.gen(function* () {
      // Safely extract optional payload
      const payloadStr = Option.getOrElse(payload, () => "{}")

      // Safe JSON parsing
      const parsedPayload = yield* Effect.try({
        try: () => JSON.parse(payloadStr) as Record<string, unknown>,
        catch: (e) => new Error(`Invalid JSON payload: ${e instanceof Error ? e.message : String(e)}`)
      })

      yield* Console.log(`Calling ${group}.${method} with:`)
      yield* Console.log(JSON.stringify(parsedPayload, null, 2))
      yield* Console.log("")

      const clientLayer = RpcClient.layerProtocolHttp({ url: serverUrl }).pipe(
        Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson])
      )

      // Get method info for stream detection
      const groupInfo = RPC_REGISTRY[group]
      if (!groupInfo) {
        return yield* Console.error(`Unknown group: ${group}. Available: ${Object.keys(RPC_REGISTRY).join(", ")}`)
      }

      const methodInfo = groupInfo.methods[method]
      if (!methodInfo) {
        return yield* Console.error(`Unknown method: ${method}. Available: ${Object.keys(groupInfo.methods).join(", ")}`)
      }

      // Call the appropriate RPC group
      if (group === "tasks") {
        yield* RpcClient.make(TaskRpcs).pipe(
          Effect.flatMap((client) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const m = (client as any)[method] as ((p: unknown) => Effect.Effect<unknown>) | undefined
            if (!m) return Console.error(`Method not found: ${method}`)
            return Effect.gen(function* () {
              const result = yield* m(parsedPayload)
              yield* Console.log("Result:")
              yield* Console.log(JSON.stringify(result, null, 2))
            })
          }),
          Effect.scoped,
          Effect.provide(clientLayer)
        )
      } else if (group === "llm") {
        yield* RpcClient.make(LlmRpcs).pipe(
          Effect.flatMap((client) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const m = (client as any)[method] as ((p: unknown) => Stream.Stream<string> | Effect.Effect<unknown>) | undefined
            if (!m) return Console.error(`Method not found: ${method}`)

            // Branch based on stream metadata
            if (methodInfo.stream) {
              return Effect.gen(function* () {
                yield* Console.log("Streaming result:")
                const stream = m(parsedPayload) as Stream.Stream<string>
                yield* Stream.runForEach(stream, (chunk) =>
                  Effect.sync(() => process.stdout.write(chunk))
                )
                yield* Console.log("")
              })
            } else {
              return Effect.gen(function* () {
                const result = yield* m(parsedPayload) as Effect.Effect<unknown>
                yield* Console.log("Result:")
                yield* Console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2))
              })
            }
          }),
          Effect.scoped,
          Effect.provide(clientLayer)
        )
      }
    }).pipe(
      Effect.withSpan("cli.rpc.call"),
      Effect.catchAll(handleError)
    )
).pipe(Command.withDescription("Call an RPC procedure with JSON payload"))

// =============================================================================
// Export Group Command
// =============================================================================

export const rpcCommand = Command.make("rpc", {}, () =>
  Console.log("RPC Explorer commands: list, call\nUse 'rpc list' to see available procedures")
).pipe(
  Command.withDescription("Interactive RPC explorer"),
  Command.withSubcommands([listRpcsCommand, callRpcCommand])
)
