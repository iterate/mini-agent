/**
 * LayerCode Adapter
 *
 * Translates between LayerCode's webhook format and our generic agent format.
 *
 * LayerCode sends events like:
 *   { "type": "message", "text": "hello", "session_id": "abc", "turn_id": "123" }
 *
 * We translate to UserMessageEvent and stream back responses.
 */
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect, Fiber, Option, Schema, Stream } from "effect"
import { AgentRegistry } from "../agent-registry.ts"
import { AppConfig } from "../config.ts"
import { type AgentName, type ContextEvent, EventBuilder } from "../domain.ts"
import { maybeVerifySignature } from "./signature.ts"

/** LayerCode incoming webhook event types */
const LayerCodeMessageEvent = Schema.Struct({
  type: Schema.Literal("message"),
  text: Schema.String,
  session_id: Schema.String,
  turn_id: Schema.String,
  conversation_id: Schema.optional(Schema.String)
})

const LayerCodeSessionStartEvent = Schema.Struct({
  type: Schema.Literal("session.start"),
  session_id: Schema.String
})

const LayerCodeSessionEndEvent = Schema.Struct({
  type: Schema.Literal("session.end"),
  session_id: Schema.String,
  transcript: Schema.optional(Schema.Array(Schema.Unknown))
})

const LayerCodeSessionUpdateEvent = Schema.Struct({
  type: Schema.Literal("session.update"),
  session_id: Schema.String
})

const LayerCodeDataEvent = Schema.Struct({
  type: Schema.Literal("data"),
  session_id: Schema.String,
  data: Schema.Unknown
})

const LayerCodeWebhookEvent = Schema.Union(
  LayerCodeMessageEvent,
  LayerCodeSessionStartEvent,
  LayerCodeSessionEndEvent,
  LayerCodeSessionUpdateEvent,
  LayerCodeDataEvent
)
type LayerCodeWebhookEvent = typeof LayerCodeWebhookEvent.Type

/** LayerCode outgoing SSE response types */
interface LayerCodeTTSResponse {
  type: "response.tts"
  content: string
  turn_id: string
}

interface LayerCodeEndResponse {
  type: "response.end"
  turn_id: string
}

type LayerCodeResponse = LayerCodeTTSResponse | LayerCodeEndResponse

/** Convert context name from session_id */
const sessionToAgentName = (sessionId: string): AgentName => `layercode-session-${sessionId}` as AgentName

/** Encode LayerCode response as SSE */
const encodeLayerCodeSSE = (response: LayerCodeResponse): Uint8Array =>
  new TextEncoder().encode(`data: ${JSON.stringify(response)}\n\n`)

/** Convert our ContextEvent to LayerCode response */
const toLayerCodeResponse = (
  event: ContextEvent,
  turnId: string
): LayerCodeResponse | null => {
  if (event._tag === "TextDeltaEvent") {
    return {
      type: "response.tts",
      content: event.delta,
      turn_id: turnId
    }
  }

  if (event._tag === "AssistantMessageEvent") {
    return {
      type: "response.end",
      turn_id: turnId
    }
  }

  // Other events don't map to LayerCode responses
  return null
}

/** Handle LayerCode webhook */
const layercodeWebhookHandler = (welcomeMessage: Option.Option<string>) =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const registry = yield* AgentRegistry
    const config = yield* AppConfig

    yield* Effect.logDebug("POST /layercode/webhook")

    // Read body
    const body = yield* request.text

    // Verify signature if secret configured, otherwise skip
    const signatureHeader = request.headers["layercode-signature"]
    const signatureResult = yield* maybeVerifySignature(
      config.layercodeWebhookSecret,
      signatureHeader,
      body
    ).pipe(Effect.either)

    if (signatureResult._tag === "Left") {
      return HttpServerResponse.text(signatureResult.left.message, { status: 401 })
    }

    // Parse webhook event
    const jsonResult = yield* Effect.try({
      try: () => JSON.parse(body) as unknown,
      catch: (e) => new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
    }).pipe(Effect.either)

    if (jsonResult._tag === "Left") {
      return HttpServerResponse.text(jsonResult.left.message, { status: 400 })
    }

    const parseResult = yield* Schema.decodeUnknown(LayerCodeWebhookEvent)(jsonResult.right).pipe(
      Effect.either
    )

    if (parseResult._tag === "Left") {
      return HttpServerResponse.text("Invalid webhook event format", { status: 400 })
    }

    const webhookEvent = parseResult.right

    // Handle different event types
    switch (webhookEvent.type) {
      case "message": {
        const agentName = sessionToAgentName(webhookEvent.session_id)
        const turnId = webhookEvent.turn_id

        // Get or create agent
        const agent = yield* registry.getOrCreate(agentName)
        const ctx = yield* agent.getReducedContext

        // Create user message event
        const userEvent = EventBuilder.userMessage(
          agentName,
          agent.contextName,
          ctx.nextEventNumber,
          webhookEvent.text
        )

        // Stream SSE events
        const sseStream = Stream.async<Uint8Array, never>((emit) => {
          const runStream = Effect.gen(function*() {
            // Subscribe to events before adding the user message
            const streamFiber = yield* agent.events.pipe(
              Stream.takeUntil((e) => e._tag === "AgentTurnCompletedEvent" || e._tag === "AgentTurnFailedEvent"),
              Stream.tap((event) =>
                Effect.sync(() => {
                  const response = toLayerCodeResponse(event, turnId)
                  if (response) {
                    emit.single(encodeLayerCodeSSE(response))
                  }
                })
              ),
              Stream.runDrain,
              Effect.fork
            )

            yield* agent.addEvent(userEvent)
            yield* Fiber.join(streamFiber)
            emit.end()
          })

          Effect.runPromise(runStream).catch(() => emit.end())
        })

        return HttpServerResponse.stream(sseStream, {
          contentType: "text/event-stream",
          headers: {
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
          }
        })
      }

      case "session.start": {
        // Optionally send welcome message
        if (Option.isSome(welcomeMessage)) {
          const response: LayerCodeTTSResponse = {
            type: "response.tts",
            content: welcomeMessage.value,
            turn_id: "welcome"
          }
          const endResponse: LayerCodeEndResponse = {
            type: "response.end",
            turn_id: "welcome"
          }

          const stream = Stream.make(
            encodeLayerCodeSSE(response),
            encodeLayerCodeSSE(endResponse)
          )

          return HttpServerResponse.stream(stream, {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache",
              "Connection": "keep-alive"
            }
          })
        }
        // No welcome message, just end
        const endResponse: LayerCodeEndResponse = {
          type: "response.end",
          turn_id: "session.start"
        }
        const stream = Stream.make(encodeLayerCodeSSE(endResponse))
        return HttpServerResponse.stream(stream, {
          contentType: "text/event-stream",
          headers: {
            "Cache-Control": "no-cache"
          }
        })
      }

      case "session.end": {
        yield* Effect.log("Session ended", { sessionId: webhookEvent.session_id })
        return HttpServerResponse.empty({ status: 200 })
      }

      case "session.update": {
        yield* Effect.log("Session updated", { sessionId: webhookEvent.session_id })
        return HttpServerResponse.empty({ status: 200 })
      }

      case "data": {
        yield* Effect.log("Received data event", {
          sessionId: webhookEvent.session_id,
          data: webhookEvent.data
        })
        return HttpServerResponse.empty({ status: 200 })
      }
    }
  }).pipe(
    Effect.catchAll((error) => {
      // On any error, return a graceful apology
      const apologyResponse: LayerCodeTTSResponse = {
        type: "response.tts",
        content: "I'm sorry, I'm having trouble right now. Please try again.",
        turn_id: "error"
      }
      const endResponse: LayerCodeEndResponse = {
        type: "response.end",
        turn_id: "error"
      }

      return Effect.gen(function*() {
        yield* Effect.logError("LayerCode webhook error", { error: String(error) })

        const stream = Stream.make(
          encodeLayerCodeSSE(apologyResponse),
          encodeLayerCodeSSE(endResponse)
        )

        return HttpServerResponse.stream(stream, {
          contentType: "text/event-stream",
          headers: {
            "Cache-Control": "no-cache"
          }
        })
      })
    })
  )

/** Create LayerCode router */
export const makeLayerCodeRouter = (
  welcomeMessage: Option.Option<string>
): HttpRouter.HttpRouter<
  never,
  AgentRegistry | AppConfig
> =>
  HttpRouter.empty.pipe(
    HttpRouter.post("/layercode/webhook", layercodeWebhookHandler(welcomeMessage))
  )
