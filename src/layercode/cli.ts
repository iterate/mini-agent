/**
 * LayerCode CLI Commands
 *
 * Provides CLI commands for running the agent as an HTTP server,
 * both as a generic server and with LayerCode integration.
 *
 * These commands rely on layers being provided by main.ts (LanguageModel, FileSystem, etc.)
 */
import { Command, Options } from "@effect/cli"
import { HttpRouter, HttpServer } from "@effect/platform"
import { BunHttpServer } from "@effect/platform-bun"
import { Console, Effect, Layer, Option } from "effect"
import { AppConfig } from "../config.ts"
import { makeRouter } from "./http.ts"
import { makeLayerCodeRouter } from "./layercode.adapter.ts"
import { AgentServer } from "./server.service.ts"

const portOption = Options.integer("port").pipe(
  Options.withAlias("p"),
  Options.withDescription("Port to listen on"),
  Options.optional
)

const hostOption = Options.text("host").pipe(
  Options.withAlias("h"),
  Options.withDescription("Host to bind to"),
  Options.optional
)

const welcomeMessageOption = Options.text("welcome-message").pipe(
  Options.withAlias("w"),
  Options.withDescription("Welcome message to speak when session starts"),
  Options.optional
)

const skipSignatureOption = Options.boolean("skip-signature").pipe(
  Options.withDescription("Skip webhook signature verification (for local dev)"),
  Options.withDefault(false)
)

/** Generic serve command - starts HTTP server with /context/:name endpoint */
export const serveCommand = Command.make(
  "serve",
  {
    port: portOption,
    host: hostOption
  },
  ({ host, port }) =>
    Effect.gen(function*() {
      const config = yield* AppConfig
      const actualPort = Option.getOrElse(port, () => config.port)
      const actualHost = Option.getOrElse(host, () => config.host)

      yield* Console.log(`Starting HTTP server on http://${actualHost}:${actualPort}`)
      yield* Console.log("")
      yield* Console.log("Endpoints:")
      yield* Console.log("  POST /context/:contextName")
      yield* Console.log("       Send JSONL events, receive SSE stream")
      yield* Console.log("       Content-Type: application/x-ndjson")
      yield* Console.log("")
      yield* Console.log("  GET  /health")
      yield* Console.log("       Health check endpoint")
      yield* Console.log("")
      yield* Console.log("Example:")
      yield* Console.log(`  curl -X POST http://${actualHost}:${actualPort}/context/test \\`)
      yield* Console.log(`    -H "Content-Type: application/x-ndjson" \\`)
      yield* Console.log(`    -d '{"_tag":"UserMessage","content":"hello"}'`)
      yield* Console.log("")

      // Create server layer with configured port/host
      const serverLayer = BunHttpServer.layer({ port: actualPort, hostname: actualHost })

      // Create layers for the server
      const layers = Layer.mergeAll(
        serverLayer,
        AgentServer.layer
      )

      // Use Layer.launch to keep the server running
      return yield* Layer.launch(
        HttpServer.serve(makeRouter).pipe(
          Layer.provide(layers)
        )
      )
    })
).pipe(
  Command.withDescription("Start generic HTTP server for agent requests")
)

/** LayerCode serve command - starts HTTP server with LayerCode webhook endpoint */
const layercodeServeCommand = Command.make(
  "serve",
  {
    port: portOption,
    host: hostOption,
    welcomeMessage: welcomeMessageOption,
    skipSignature: skipSignatureOption
  },
  ({ host, port, skipSignature, welcomeMessage }) =>
    Effect.gen(function*() {
      const config = yield* AppConfig
      const actualPort = Option.getOrElse(port, () => config.port)
      const actualHost = Option.getOrElse(host, () => config.host)

      yield* Console.log(`Starting LayerCode server on http://${actualHost}:${actualPort}`)
      yield* Console.log("")
      yield* Console.log("LayerCode Webhook Endpoint:")
      yield* Console.log("  POST /layercode/webhook")
      yield* Console.log("")

      if (skipSignature) {
        yield* Console.log("WARNING: Signature verification is DISABLED")
        yield* Console.log("")
      }

      if (Option.isSome(welcomeMessage)) {
        yield* Console.log(`Welcome message: "${welcomeMessage.value}"`)
        yield* Console.log("")
      }

      yield* Console.log("To connect LayerCode tunnel (in another terminal):")
      yield* Console.log(`  npx @layercode/cli tunnel \\`)
      yield* Console.log(`    --agent-id=YOUR_AGENT_ID \\`)
      yield* Console.log(`    --port=${actualPort} \\`)
      yield* Console.log(`    --path=/layercode/webhook \\`)
      yield* Console.log(`    --tail`)
      yield* Console.log("")

      // Combine generic router with LayerCode router
      const combinedRouter = HttpRouter.concat(
        makeRouter,
        makeLayerCodeRouter(welcomeMessage)
      )

      // Create server layer with configured port/host
      const serverLayer = BunHttpServer.layer({ port: actualPort, hostname: actualHost })

      const layers = Layer.mergeAll(
        serverLayer,
        AgentServer.layer
      )

      // Use Layer.launch to keep the server running
      return yield* Layer.launch(
        HttpServer.serve(combinedRouter).pipe(
          Layer.provide(layers)
        )
      )
    })
).pipe(
  Command.withDescription("Start HTTP server with LayerCode webhook integration")
)

/** LayerCode command group */
export const layercodeCommand = Command.make("layercode", {}).pipe(
  Command.withSubcommands([layercodeServeCommand]),
  Command.withDescription("LayerCode voice integration commands")
)
