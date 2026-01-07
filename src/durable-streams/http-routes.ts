/**
 * HTTP Routes for durable-streams
 *
 * Endpoints:
 * - POST /streams/:name - Append event to stream (JSON body: { data: any })
 * - GET /streams/:name - Subscribe to stream (SSE). Query params: offset
 * - GET /streams - List all streams
 * - DELETE /streams/:name - Delete stream
 */
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect, Schema, Stream } from "effect"
import { StreamManagerService } from "./stream-manager.ts"
import { type Offset, OFFSET_START, StreamEvent, type StreamName } from "./types.ts"

/** Encode a StreamEvent as SSE data line */
const encodeSSE = (event: StreamEvent): Uint8Array => {
  const encoded = Schema.encodeSync(StreamEvent)(event)
  return new TextEncoder().encode(`data: ${JSON.stringify(encoded)}\n\n`)
}

/** Input schema for append */
const AppendInput = Schema.Struct({
  data: Schema.Unknown
})

/** Parse JSON body for append */
const parseAppendBody = (body: string) =>
  Effect.gen(function*() {
    const json = yield* Effect.try({
      try: () => JSON.parse(body) as unknown,
      catch: (e) => new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
    })
    return yield* Schema.decodeUnknown(AppendInput)(json)
  })

/** POST /streams/:name - Append to stream */
const appendHandler = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const manager = yield* StreamManagerService
  const params = yield* HttpRouter.params

  const name = params.name
  if (!name) {
    return HttpServerResponse.text("Missing stream name", { status: 400 })
  }

  const body = yield* request.text

  if (body.trim() === "") {
    return HttpServerResponse.text("Empty request body", { status: 400 })
  }

  const parseResult = yield* parseAppendBody(body).pipe(Effect.either)

  if (parseResult._tag === "Left") {
    return HttpServerResponse.text(parseResult.left.message, { status: 400 })
  }

  const { data } = parseResult.right

  const event = yield* manager.append({ name: name as StreamName, data }).pipe(
    Effect.mapError((e) => new Error(e.message))
  )

  const encoded = Schema.encodeSync(StreamEvent)(event)
  return yield* HttpServerResponse.json(encoded, { status: 201 })
})

/** GET /streams/:name - Subscribe to stream (SSE) */
const subscribeHandler = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const manager = yield* StreamManagerService
  const params = yield* HttpRouter.params

  const name = params.name
  if (!name) {
    return HttpServerResponse.text("Missing stream name", { status: 400 })
  }

  // Parse offset from query string
  const url = new URL(request.url, "http://localhost")
  const offsetParam = url.searchParams.get("offset")
  const offset: Offset | undefined = offsetParam === null
    ? undefined
    : offsetParam === "-1"
    ? OFFSET_START
    : offsetParam as Offset

  const eventStreamResult = yield* manager.subscribe({
    name: name as StreamName,
    offset
  }).pipe(Effect.either)

  if (eventStreamResult._tag === "Left") {
    const err = eventStreamResult.left
    if (err._tag === "InvalidOffsetError") {
      return HttpServerResponse.text(err.message, { status: 400 })
    }
    return HttpServerResponse.text(err.message, { status: 500 })
  }

  const eventStream = eventStreamResult.right

  const sseStream = eventStream.pipe(Stream.map(encodeSSE))

  return HttpServerResponse.stream(sseStream, {
    contentType: "text/event-stream",
    headers: {
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    }
  })
})

/** GET /streams - List all streams */
const listHandler = Effect.gen(function*() {
  const manager = yield* StreamManagerService

  const names = yield* manager.list().pipe(
    Effect.mapError((e) => new Error(e.message))
  )

  return yield* HttpServerResponse.json({ streams: names })
})

/** DELETE /streams/:name - Delete stream */
const deleteHandler = Effect.gen(function*() {
  const manager = yield* StreamManagerService
  const params = yield* HttpRouter.params

  const name = params.name
  if (!name) {
    return HttpServerResponse.text("Missing stream name", { status: 400 })
  }

  yield* manager.delete({ name: name as StreamName }).pipe(
    Effect.mapError((e) => new Error(e.message))
  )

  return HttpServerResponse.empty({ status: 204 })
})

/** Durable streams router */
export const durableStreamsRouter = HttpRouter.empty.pipe(
  HttpRouter.post("/streams/:name", appendHandler),
  HttpRouter.get("/streams/:name", subscribeHandler),
  HttpRouter.get("/streams", listHandler),
  HttpRouter.del("/streams/:name", deleteHandler)
)
