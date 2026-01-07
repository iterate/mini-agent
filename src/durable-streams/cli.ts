/**
 * Durable Streams CLI
 *
 * Commands:
 * - start: Start HTTP server for durable streams
 */
import { Command, Options } from "@effect/cli"
import { HttpServer } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { Console, Effect, Layer } from "effect"
import { createServer } from "node:http"
import { durableStreamsRouter } from "./http-routes.ts"
import { StreamManagerService } from "./stream-manager.ts"

/** Port option */
const portOption = Options.integer("port").pipe(
  Options.withAlias("p"),
  Options.withDescription("Port to listen on"),
  Options.withDefault(3000)
)

/** Host option */
const hostOption = Options.text("host").pipe(
  Options.withAlias("h"),
  Options.withDescription("Host to bind to"),
  Options.withDefault("0.0.0.0")
)

/** Start command - launches HTTP server */
const startCommand = Command.make(
  "start",
  { host: hostOption, port: portOption },
  ({ host, port }) =>
    Effect.gen(function*() {
      yield* Console.log(`Starting durable-streams server on ${host}:${port}`)

      // Build service layers
      const serviceLayer = StreamManagerService.InMemory

      // HTTP server layer
      const serverLayer = HttpServer.serve(durableStreamsRouter).pipe(
        Layer.provide(NodeHttpServer.layer(createServer, { port })),
        Layer.provide(serviceLayer)
      )

      return yield* Layer.launch(serverLayer)
    })
)

/** Main CLI */
export const cli = Command.make("durable-streams").pipe(
  Command.withSubcommands([startCommand])
)

/** Run CLI with args */
export const run = (args: ReadonlyArray<string>) =>
  Command.run(cli, {
    name: "durable-streams",
    version: "0.1.0"
  })(args)
