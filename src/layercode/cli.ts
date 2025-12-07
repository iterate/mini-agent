/**
 * LayerCode CLI Commands
 *
 * Provides CLI commands for LayerCode voice integration.
 */
import { Command as CliCommand, Options } from "@effect/cli"
import type { CommandExecutor } from "@effect/platform"
import { Command as PlatformCommand, HttpRouter, HttpServer } from "@effect/platform"
import { BunHttpServer } from "@effect/platform-bun"
import { Console, Effect, Layer, Option, Stream } from "effect"
import { AgentRegistry } from "../agent-registry.ts"
import { AppConfig } from "../config.ts"
import { EventReducer } from "../event-reducer.ts"
import { EventStoreFileSystem } from "../event-store-fs.ts"
import { makeRouter } from "../http.ts"
import { LlmTurnLive } from "../llm-turn.ts"
import { AgentServer } from "../server.service.ts"
import { makeLayerCodeRouter } from "./layercode.adapter.ts"

const portOption = Options.integer("port").pipe(
  Options.withAlias("p"),
  Options.withDescription("Port to listen on"),
  Options.optional
)

const hostOption = Options.text("host").pipe(
  Options.withDescription("Host to bind to"),
  Options.optional
)

const welcomeMessageOption = Options.text("welcome-message").pipe(
  Options.withAlias("w"),
  Options.withDescription("Welcome message to speak when session starts"),
  Options.optional
)

const agentIdOption = Options.text("agent-id").pipe(
  Options.withAlias("a"),
  Options.withDescription("LayerCode agent ID (required when tunnel is enabled)"),
  Options.optional
)

const noTunnelOption = Options.boolean("no-tunnel").pipe(
  Options.withDescription("Disable automatic LayerCode tunnel")
)

/** Stream tunnel output with prefix to console */
const streamTunnelOutput = (
  tunnelProcess: CommandExecutor.Process,
  prefix: string
) =>
  tunnelProcess.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => Console.log(`${prefix} ${line}`))
  )

/** Stream tunnel stderr with prefix to console */
const streamTunnelStderr = (
  tunnelProcess: CommandExecutor.Process,
  prefix: string
) =>
  tunnelProcess.stderr.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => Console.error(`${prefix} ${line}`))
  )

/** Start the LayerCode tunnel process and stream its output (runs forever) */
const startTunnel = (agentId: string, port: number) =>
  Effect.gen(function*() {
    yield* Console.log("")
    yield* Console.log(`Starting LayerCode tunnel for agent ${agentId}...`)
    yield* Console.log(`Dashboard: https://dash.layercode.com/agents/${agentId}/playground`)

    const tunnelCommand = PlatformCommand.make(
      "bunx",
      "@layercode/cli",
      "tunnel",
      `--agent-id=${agentId}`,
      `--port=${port}`,
      "--path=/layercode/webhook",
      "--tail"
    )

    const tunnelProcess = yield* PlatformCommand.start(tunnelCommand)

    // Fork fibers to stream stdout and stderr with prefixes
    yield* streamTunnelOutput(tunnelProcess, "[layercode stdout]").pipe(Effect.fork)
    yield* streamTunnelStderr(tunnelProcess, "[layercode stderr]").pipe(Effect.fork)

    // Wait for process to exit (which shouldn't happen normally)
    return yield* tunnelProcess.exitCode
  }).pipe(Effect.scoped)

/** LayerCode serve command - starts HTTP server with LayerCode webhook endpoint */
const layercodeServeCommand = CliCommand.make(
  "serve",
  {
    port: portOption,
    host: hostOption,
    welcomeMessage: welcomeMessageOption,
    agentId: agentIdOption,
    noTunnel: noTunnelOption
  },
  ({ agentId, host, noTunnel, port, welcomeMessage }) =>
    Effect.gen(function*() {
      const config = yield* AppConfig
      const actualPort = Option.getOrElse(port, () => config.port)
      const actualHost = Option.getOrElse(host, () => config.host)
      const tunnelEnabled = !noTunnel

      // Validate agent-id is provided when tunnel is enabled
      if (tunnelEnabled && Option.isNone(agentId)) {
        yield* Console.error("Error: --agent-id is required when tunnel is enabled")
        yield* Console.error("Use --no-tunnel to disable automatic tunnel, or provide --agent-id")
        return yield* Effect.fail(new Error("Missing --agent-id"))
      }

      yield* Console.log(`Starting LayerCode server on http://${actualHost}:${actualPort}`)
      yield* Console.log("")
      yield* Console.log("LayerCode Webhook Endpoint:")
      yield* Console.log("  POST /layercode/webhook")
      yield* Console.log("")

      if (Option.isNone(config.layercodeWebhookSecret)) {
        yield* Effect.logWarning("No LAYERCODE_WEBHOOK_SECRET configured - signature verification disabled")
      }

      if (Option.isSome(welcomeMessage)) {
        yield* Console.log(`Welcome message: "${welcomeMessage.value}"`)
        yield* Console.log("")
      }

      if (!tunnelEnabled) {
        yield* Console.log("Tunnel disabled. To connect manually:")
        yield* Console.log(`  bunx @layercode/cli tunnel \\`)
        yield* Console.log(`    --agent-id=YOUR_AGENT_ID \\`)
        yield* Console.log(`    --port=${actualPort} \\`)
        yield* Console.log(`    --path=/layercode/webhook \\`)
        yield* Console.log(`    --tail`)
        yield* Console.log("")
      }

      // Combine generic router with LayerCode router
      const combinedRouter = HttpRouter.concat(
        makeRouter,
        makeLayerCodeRouter(welcomeMessage)
      )

      // Create server layer with configured port/host
      const serverLayer = BunHttpServer.layer({ port: actualPort, hostname: actualHost })

      // Create agent layer (AgentServer needs AgentRegistry)
      const agentLayer = AgentServer.layer.pipe(
        Layer.provide(AgentRegistry.Default),
        Layer.provide(LlmTurnLive),
        Layer.provide(EventStoreFileSystem),
        Layer.provide(EventReducer.Default)
      )

      const layers = Layer.mergeAll(
        serverLayer,
        agentLayer
      )

      // Start the tunnel if enabled (fork it to run concurrently with server)
      if (tunnelEnabled && Option.isSome(agentId)) {
        yield* startTunnel(agentId.value, actualPort).pipe(Effect.fork)
      }

      // Use Layer.launch to keep the server running (blocks forever)
      return yield* Layer.launch(
        HttpServer.serve(combinedRouter).pipe(
          Layer.provide(layers)
        )
      )
    })
).pipe(
  CliCommand.withDescription("Start HTTP server with LayerCode webhook integration")
)

/** LayerCode command group */
export const layercodeCommand = CliCommand.make("layercode", {}).pipe(
  CliCommand.withSubcommands([layercodeServeCommand]),
  CliCommand.withDescription("LayerCode voice integration commands")
)
