/**
 * Durable Streams CLI
 *
 * Commands:
 *
 * server run [--port] [--host]     Run server in foreground
 * server start [--port]            Start daemonized server
 * server stop                      Stop daemon
 * server restart [--port]          Restart daemon
 * server status                    Check daemon status
 *
 * stream subscribe <name> [--offset]  Subscribe to stream events
 * stream append <name> -m|-e          Append event to stream
 */
import { Args, Command, Options } from "@effect/cli"
import { FileSystem, HttpServer, Path } from "@effect/platform"
import { NodeContext, NodeHttpServer } from "@effect/platform-node"
import { Console, Effect, Layer, Option, Schema, Stream } from "effect"
import { createServer } from "node:http"
import { StreamClientService } from "./client.ts"
import { DaemonService, DATA_DIR } from "./daemon.ts"
import { durableStreamsRouter } from "./http-routes.ts"
import { Storage } from "./storage.ts"
import { StreamManagerService } from "./stream-manager.ts"
import { type Offset, OFFSET_START, StreamEvent, type StreamName } from "./types.ts"

// ─── Shared Options ─────────────────────────────────────────────────────────

const portOption = Options.integer("port").pipe(
  Options.withAlias("p"),
  Options.withDescription("Port to listen on"),
  Options.withDefault(3000)
)

const hostOption = Options.text("host").pipe(
  Options.withDescription("Host to bind to"),
  Options.withDefault("0.0.0.0")
)

const serverUrlOption = Options.text("server").pipe(
  Options.withAlias("s"),
  Options.withDescription("Server URL (overrides auto-daemon behavior)"),
  Options.optional
)

// ─── Server Commands ────────────────────────────────────────────────────────

/** server run - run server in foreground */
const serverRunCommand = Command.make(
  "run",
  { host: hostOption, port: portOption },
  ({ host, port }) =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      // Ensure data directory exists
      const dataDirPath = path.join(process.cwd(), DATA_DIR)
      yield* fs.makeDirectory(dataDirPath, { recursive: true }).pipe(Effect.ignore)

      yield* Console.log(`Starting durable-streams server on ${host}:${port}`)
      yield* Console.log(`Data directory: ${dataDirPath}`)
      yield* Console.log("")
      yield* Console.log("Endpoints:")
      yield* Console.log("  POST   /streams/:name         Append event")
      yield* Console.log("  GET    /streams/:name         Subscribe (SSE)")
      yield* Console.log("  GET    /streams/:name/events  Get historic events")
      yield* Console.log("  GET    /streams               List streams")
      yield* Console.log("  DELETE /streams/:name         Delete stream")
      yield* Console.log("")

      // Use FileSystem storage for persistence
      const storageLayer = Storage.FileSystem({ dataDir: dataDirPath }).pipe(
        Layer.provide(NodeContext.layer)
      )
      const serviceLayer = StreamManagerService.Live.pipe(
        Layer.provide(storageLayer)
      )

      const serverLayer = HttpServer.serve(durableStreamsRouter).pipe(
        Layer.provide(NodeHttpServer.layer(createServer, { port })),
        Layer.provide(serviceLayer)
      )

      return yield* Layer.launch(serverLayer)
    })
).pipe(Command.withDescription("Run server in foreground"))

/** server start - start daemon */
const serverStartCommand = Command.make(
  "start",
  { port: portOption },
  ({ port }) =>
    Effect.gen(function*() {
      const daemon = yield* DaemonService
      const pid = yield* daemon.start({ port })
      yield* Console.log(`Daemon started (PID ${pid}) on port ${port}`)
      yield* Console.log(`Logs: daemon.log`)
    }).pipe(
      Effect.catchTag("DaemonError", (e) => Console.error(`Error: ${e.message}`))
    )
).pipe(Command.withDescription("Start daemonized server"))

/** server stop - stop daemon */
const serverStopCommand = Command.make(
  "stop",
  {},
  () =>
    Effect.gen(function*() {
      const daemon = yield* DaemonService
      yield* daemon.stop()
      yield* Console.log("Daemon stopped")
    }).pipe(
      Effect.catchTag("DaemonError", (e) => Console.error(`Error: ${e.message}`))
    )
).pipe(Command.withDescription("Stop daemon"))

/** server restart - restart daemon */
const serverRestartCommand = Command.make(
  "restart",
  { port: portOption },
  ({ port }) =>
    Effect.gen(function*() {
      const daemon = yield* DaemonService
      const pid = yield* daemon.restart({ port })
      yield* Console.log(`Daemon restarted (PID ${pid}) on port ${port}`)
    }).pipe(
      Effect.catchTag("DaemonError", (e) => Console.error(`Error: ${e.message}`))
    )
).pipe(Command.withDescription("Restart daemon"))

/** server status - check daemon status */
const serverStatusCommand = Command.make(
  "status",
  {},
  () =>
    Effect.gen(function*() {
      const daemon = yield* DaemonService
      const status = yield* daemon.status()
      if (Option.isSome(status)) {
        const url = yield* daemon.getServerUrl()
        yield* Console.log(`Running (PID ${status.value})`)
        if (Option.isSome(url)) {
          yield* Console.log(`URL: ${url.value}`)
        }
      } else {
        yield* Console.log("Not running")
      }
    })
).pipe(Command.withDescription("Check daemon status"))

/** server command group */
const serverCommand = Command.make("server").pipe(
  Command.withSubcommands([
    serverRunCommand,
    serverStartCommand,
    serverStopCommand,
    serverRestartCommand,
    serverStatusCommand
  ]),
  Command.withDescription("Server management commands")
)

// ─── Stream Commands ────────────────────────────────────────────────────────

const streamNameArg = Args.text({ name: "name" }).pipe(
  Args.withDescription("Stream name")
)

const offsetOption = Options.text("offset").pipe(
  Options.withAlias("o"),
  Options.withDescription("Start offset (-1 for beginning, or specific offset)"),
  Options.optional
)

const messageOption = Options.text("message").pipe(
  Options.withAlias("m"),
  Options.withDescription("Message text (creates {type:'message',text:'...'})"),
  Options.optional
)

const eventOption = Options.text("event").pipe(
  Options.withAlias("e"),
  Options.withDescription("Raw JSON event data"),
  Options.optional
)

const limitOption = Options.integer("limit").pipe(
  Options.withAlias("n"),
  Options.withDescription("Maximum number of events to return"),
  Options.optional
)

/** stream subscribe - subscribe to stream events */
const streamSubscribeCommand = Command.make(
  "subscribe",
  { name: streamNameArg, offset: offsetOption, server: serverUrlOption },
  ({ name, offset, server: _server }) =>
    Effect.gen(function*() {
      const client = yield* StreamClientService

      // Parse offset - build opts object conditionally
      const subscribeOpts: { name: StreamName; offset?: Offset } = { name: name as StreamName }
      if (Option.isSome(offset)) {
        subscribeOpts.offset = offset.value === "-1" ? OFFSET_START : offset.value as Offset
      }

      const eventStream = yield* client.subscribe(subscribeOpts)

      // Output events as JSON lines
      yield* eventStream.pipe(
        Stream.runForEach((event) => {
          const encoded = Schema.encodeSync(StreamEvent)(event)
          return Console.log(JSON.stringify(encoded))
        })
      )
    }).pipe(
      Effect.catchAll((e) => Console.error(`Error: ${e.message}`))
    )
).pipe(Command.withDescription("Subscribe to stream events (outputs JSON lines)"))

/** stream append - append event to stream */
const streamAppendCommand = Command.make(
  "append",
  { name: streamNameArg, message: messageOption, event: eventOption, server: serverUrlOption },
  ({ event, message, name, server: _server }) =>
    Effect.gen(function*() {
      const client = yield* StreamClientService

      // Determine data from -m or -e
      let data: unknown
      if (Option.isSome(message)) {
        data = { type: "message", text: message.value }
      } else if (Option.isSome(event)) {
        try {
          data = JSON.parse(event.value)
        } catch (e) {
          return yield* Console.error(`Invalid JSON: ${e}`)
        }
      } else {
        return yield* Console.error("Either -m (message) or -e (event JSON) is required")
      }

      const result = yield* client.append({ name: name as StreamName, data })
      const encoded = Schema.encodeSync(StreamEvent)(result)
      yield* Console.log(JSON.stringify(encoded))
    }).pipe(
      Effect.catchAll((e) => Console.error(`Error: ${e.message}`))
    )
).pipe(Command.withDescription("Append event to stream"))

/** stream get - get historic events (one-shot) */
const streamGetCommand = Command.make(
  "get",
  { name: streamNameArg, offset: offsetOption, limit: limitOption, server: serverUrlOption },
  ({ limit, name, offset, server: _server }) =>
    Effect.gen(function*() {
      const client = yield* StreamClientService

      const getOpts: { name: StreamName; offset?: Offset; limit?: number } = { name: name as StreamName }
      if (Option.isSome(offset)) {
        getOpts.offset = offset.value === "-1" ? OFFSET_START : offset.value as Offset
      }
      if (Option.isSome(limit)) {
        getOpts.limit = limit.value
      }

      const events = yield* client.get(getOpts)

      for (const event of events) {
        const encoded = Schema.encodeSync(StreamEvent)(event)
        yield* Console.log(JSON.stringify(encoded))
      }
    }).pipe(
      Effect.catchAll((e) => Console.error(`Error: ${e.message}`))
    )
).pipe(Command.withDescription("Get historic events (one-shot, no live subscription)"))

/** stream list - list all streams */
const streamListCommand = Command.make(
  "list",
  { server: serverUrlOption },
  () =>
    Effect.gen(function*() {
      const client = yield* StreamClientService
      const streams = yield* client.list()

      if (streams.length === 0) {
        yield* Console.log("No streams")
      } else {
        for (const name of streams) {
          yield* Console.log(name)
        }
      }
    }).pipe(
      Effect.catchAll((e) => Console.error(`Error: ${e.message}`))
    )
).pipe(Command.withDescription("List all streams"))

/** stream delete - delete a stream */
const streamDeleteCommand = Command.make(
  "delete",
  { name: streamNameArg, server: serverUrlOption },
  ({ name }) =>
    Effect.gen(function*() {
      const client = yield* StreamClientService
      yield* client.delete({ name: name as StreamName })
      yield* Console.log(`Deleted stream: ${name}`)
    }).pipe(
      Effect.catchAll((e) => Console.error(`Error: ${e.message}`))
    )
).pipe(Command.withDescription("Delete a stream"))

/** stream command group */
const streamCommand = Command.make("stream").pipe(
  Command.withSubcommands([
    streamSubscribeCommand,
    streamAppendCommand,
    streamGetCommand,
    streamListCommand,
    streamDeleteCommand
  ]),
  Command.withDescription("Stream operations")
)

// ─── Root Command ───────────────────────────────────────────────────────────

const rootCommand = Command.make("durable-streams").pipe(
  Command.withSubcommands([serverCommand, streamCommand]),
  Command.withDescription("Durable event streams with daemon support")
)

/** Main CLI definition */
export const cli = Command.run(rootCommand, {
  name: "durable-streams",
  version: "0.1.0"
})

/** Run CLI with provided layers */
export const run = (args: ReadonlyArray<string>) => cli(args)
