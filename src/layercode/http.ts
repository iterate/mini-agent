/**
 * HTTP Server for Agent
 *
 * Provides HTTP endpoints that mirror the CLI interface:
 * - POST /context/:contextName - Send events, receive SSE stream of responses
 */
import { LanguageModel } from "@effect/ai"
import { FileSystem, HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect, Schema, Stream } from "effect"
import type { ContextEvent } from "../context.model.ts"
import { CurrentLlmConfig } from "../llm-config.ts"
import { AgentServer, ScriptInputEvent } from "./server.service.ts"

/** Encode a ContextEvent as an SSE data line */
const encodeSSE = (event: ContextEvent): Uint8Array => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)

/** Parse JSONL body into ScriptInputEvents */
const parseJsonlBody = (body: string) =>
  Effect.gen(function*() {
    const lines = body.split("\n").filter((line) => line.trim() !== "")
    const events: Array<ScriptInputEvent> = []

    for (const line of lines) {
      const json = JSON.parse(line) as unknown
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

  // Get context services to provide to the stream
  const langModel = yield* LanguageModel.LanguageModel
  const fs = yield* FileSystem.FileSystem
  const llmConfig = yield* CurrentLlmConfig

  const contextName = params.contextName
  if (!contextName) {
    return HttpServerResponse.text("Missing contextName", { status: 400 })
  }

  // Read body as text and parse JSONL
  const body = yield* request.text
  const events = yield* parseJsonlBody(body).pipe(
    Effect.catchAll(() => Effect.succeed([] as Array<ScriptInputEvent>))
  )

  if (events.length === 0) {
    return HttpServerResponse.text("No valid events in body", { status: 400 })
  }

  // Stream SSE events directly - provide services to remove context requirements
  const sseStream = agentServer.handleRequest(contextName, events).pipe(
    Stream.map(encodeSSE),
    Stream.provideService(LanguageModel.LanguageModel, langModel),
    Stream.provideService(FileSystem.FileSystem, fs),
    Stream.provideService(CurrentLlmConfig, llmConfig)
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
  return yield* HttpServerResponse.json({ status: "ok" })
})

/** Create the HTTP router - context requirements will be inferred */
export const makeRouter = HttpRouter.empty.pipe(
  HttpRouter.post("/context/:contextName", contextHandler),
  HttpRouter.get("/health", healthHandler)
)

/** Run the server and log the address - for standalone use */
export const runServer = Effect.gen(function*() {
  yield* Effect.log("Server started")
  return yield* Effect.never
})
