/**
 * HTTP Server for Agent
 *
 * Provides HTTP endpoints that mirror the CLI interface:
 * - POST /context/:contextName - Send events, receive SSE stream of responses
 */
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Console, Effect, Schema, Stream } from "effect"
import { type ContextEvent } from "./domain.ts"
import { AgentServer, ScriptInputEvent } from "./server.service.ts"

/** Encode a ContextEvent as an SSE data line */
const encodeSSE = (event: ContextEvent): Uint8Array => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)

/** Error for JSONL parsing failures */
class JsonParseError extends Error {
  readonly _tag = "JsonParseError"
  constructor(readonly line: number, readonly rawLine: string, readonly originalError: unknown) {
    super(
      `Invalid JSON at line ${line}: ${originalError instanceof Error ? originalError.message : String(originalError)}`
    )
  }
}

/** Parse JSONL body into ScriptInputEvents */
const parseJsonlBody = (body: string) =>
  Effect.gen(function*() {
    const lines = body.split("\n").filter((line) => line.trim() !== "")
    const events: Array<ScriptInputEvent> = []

    for (const [i, line] of lines.entries()) {
      const json = yield* Effect.try({
        try: () => JSON.parse(line) as unknown,
        catch: (e) => new JsonParseError(i + 1, line, e)
      })
      const event = yield* Schema.decodeUnknown(ScriptInputEvent)(json)
      events.push(event)
    }

    return events
  })

/** Handler for POST /context/:contextName */
const contextHandler = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const agentServer = yield* AgentServer
  const params = yield* HttpRouter.params

  const contextName = params.contextName
  if (!contextName) {
    return HttpServerResponse.text("Missing contextName", { status: 400 })
  }

  yield* Effect.logDebug("POST /context/:contextName", { contextName })

  // Read body as text and parse JSONL
  const body = yield* request.text

  if (body.trim() === "") {
    return HttpServerResponse.text("Empty request body", { status: 400 })
  }

  const parseResult = yield* parseJsonlBody(body).pipe(Effect.either)

  if (parseResult._tag === "Left") {
    const error = parseResult.left
    const message = error instanceof JsonParseError
      ? error.message
      : `Invalid event format: ${error instanceof Error ? error.message : String(error)}`
    return HttpServerResponse.text(message, { status: 400 })
  }

  const inputEvents = parseResult.right
  if (inputEvents.length === 0) {
    return HttpServerResponse.text("No valid events in body", { status: 400 })
  }

  // Use AgentServer to process events and stream response
  const sseStream = agentServer.handleRequest(contextName, inputEvents).pipe(
    Stream.map(encodeSSE)
  )

  return HttpServerResponse.stream(sseStream, {
    contentType: "text/event-stream",
    headers: {
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  })
})

/** Health check endpoint */
const healthHandler = Effect.gen(function*() {
  yield* Effect.logDebug("GET /health")
  return yield* HttpServerResponse.json({ status: "ok" })
})

/** Create the HTTP router - context requirements will be inferred */
export const makeRouter = HttpRouter.empty.pipe(
  HttpRouter.post("/context/:contextName", contextHandler),
  HttpRouter.get("/health", healthHandler)
)

/** Run the server and log the address - for standalone use */
export const runServer = Effect.gen(function*() {
  yield* Console.log("Server started")
  return yield* Effect.never
})
