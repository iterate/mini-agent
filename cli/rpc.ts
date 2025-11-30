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

// =============================================================================
// Registry of Available RPCs
// =============================================================================

const RPC_REGISTRY = {
  tasks: {
    group: TaskRpcs,
    methods: ["list", "add", "toggle", "clear"],
    schemas: {
      list: { payload: "{ all?: boolean }", returns: "Task[]" },
      add: { payload: "{ text: string }", returns: "Task" },
      toggle: { payload: "{ id: number }", returns: "Task" },
      clear: { payload: "{}", returns: "{ cleared: number }" }
    }
  },
  llm: {
    group: LlmRpcs,
    methods: ["generate", "generateStream"],
    schemas: {
      generate: { payload: "{ prompt: string }", returns: "string" },
      generateStream: { payload: "{ prompt: string }", returns: "Stream<string>" }
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
      for (const method of group.methods) {
        const schema = (group.schemas as any)[method]
        yield* Console.log(`   └─ ${method}`)
        yield* Console.log(`      Payload: ${schema.payload}`)
        yield* Console.log(`      Returns: ${schema.returns}`)
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
      // Handle optional payload (comes as Option from Args.optional)
      const payloadStr = Option.isOption(payload) 
        ? Option.getOrElse(payload, () => "{}") 
        : (payload ?? "{}")
      const parsedPayload = JSON.parse(payloadStr)

      yield* Console.log(`Calling ${group}.${method} with:`)
      yield* Console.log(JSON.stringify(parsedPayload, null, 2))
      yield* Console.log("")

      const clientLayer = RpcClient.layerProtocolHttp({ url: serverUrl }).pipe(
        Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson])
      )

      if (group === "tasks") {
        yield* RpcClient.make(TaskRpcs).pipe(
          Effect.flatMap((client) => {
            const m = (client as any)[method]
            if (!m) {
              return Console.error(`Unknown method: ${method}`)
            }
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
            const m = (client as any)[method]
            if (!m) {
              return Console.error(`Unknown method: ${method}`)
            }
            return Effect.gen(function* () {
              yield* Console.log("Streaming result:")
              const stream = m(parsedPayload) as Stream.Stream<string, unknown, never>
              yield* Stream.runForEach(stream, (chunk) =>
                Effect.sync(() => process.stdout.write(chunk))
              )
              yield* Console.log("")
            })
          }),
          Effect.scoped,
          Effect.provide(clientLayer)
        )
      } else {
        yield* Console.error(`Unknown group: ${group}. Available: tasks, llm`)
      }
    }).pipe(
      Effect.withSpan("cli.rpc.call"),
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          if (typeof error === "object" && error !== null && "_tag" in error) {
            yield* Console.error(`Error [${(error as { _tag: string })._tag}]: ${JSON.stringify(error)}`)
          } else if (error instanceof Error) {
            yield* Console.error(`Error: ${error.message}`)
          } else {
            yield* Console.error(`Error: ${String(error)}`)
          }
        })
      )
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

