/**
 * LayerCode Adapter
 *
 * Translates between LayerCode's webhook format and our generic agent format.
 *
 * LayerCode sends events like:
 *   { "type": "message", "text": "hello", "session_id": "abc", "turn_id": "123" }
 *
 * We translate to:
 *   { "_tag": "UserMessageEvent", "content": "hello" }
 *
 * And translate our responses back:
 *   { "_tag": "TextDeltaEvent", "delta": "Hi" }
 *   →
 *   data: {"type":"response.tts","content":"Hi","turn_id":"123"}
 */
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Chunk, Effect, Fiber, Option, Schema, Stream } from "effect"
import { AgentRegistry } from "../agent-registry.ts"
import { AppConfig } from "../config.ts"
import {
  type AgentName,
  AssistantMessageEvent,
  type ContextEvent,
  type ContextName,
  makeBaseEventFields,
  TextDeltaEvent,
  UserMessageEvent
} from "../domain.ts"
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

/** Convert session_id to agent name */
const sessionToAgentName = (sessionId: string): AgentName => `layercode-session-${sessionId}` as AgentName

/** Encode LayerCode response as SSE */
const encodeLayerCodeSSE = (response: LayerCodeResponse): Uint8Array =>
  new TextEncoder().encode(`data: ${JSON.stringify(response)}\n\n`)

/** Convert our ContextEvent to LayerCode response */
const toLayerCodeResponse = (
  event: ContextEvent,
  turnId: string
): LayerCodeResponse | null => {
  if (Schema.is(TextDeltaEvent)(event)) {
    return {
      type: "response.tts",
      content: event.delta,
      turn_id: turnId
    }
  }

  if (Schema.is(AssistantMessageEvent)(event)) {
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
        const contextName = `${agentName}-v1` as ContextName
        const turnId = webhookEvent.turn_id

        const agent = yield* registry.getOrCreate(agentName)
        const ctx = yield* agent.getReducedContext

        const userEvent = new UserMessageEvent({
          ...makeBaseEventFields(agentName, contextName, ctx.nextEventNumber, true),
          content: webhookEvent.text
        })

        // Subscribe to events before adding user event
        const eventFiber = yield* agent.events.pipe(
          Stream.takeUntil((e) => e._tag === "AgentTurnCompletedEvent" || e._tag === "AgentTurnFailedEvent"),
          Stream.runCollect,
          Effect.fork
        )

        // Add the user event to trigger the turn
        yield* agent.addEvent(userEvent)

        // Wait for the turn to complete and get all new events
        const newEventsChunk = yield* Fiber.join(eventFiber).pipe(
          Effect.catchAll(() => Effect.succeed(Chunk.empty<ContextEvent>()))
        )
        const newEvents = Chunk.toArray(newEventsChunk)

        // Convert events to LayerCode responses
        const layerCodeResponses: Array<Uint8Array> = []
        for (const event of newEvents) {
          const response = toLayerCodeResponse(event, turnId)
          if (response) {
            layerCodeResponses.push(encodeLayerCodeSSE(response))
          }
        }

        // Always end with response.end if not already present
        const hasEndResponse = newEvents.some((e) => Schema.is(AssistantMessageEvent)(e))
        if (!hasEndResponse) {
          layerCodeResponses.push(encodeLayerCodeSSE({ type: "response.end", turn_id: turnId }))
        }

        const sseStream = Stream.fromIterable(layerCodeResponses)

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
  | AgentRegistry
  | AppConfig
> =>
  HttpRouter.empty.pipe(
    HttpRouter.post("/layercode/webhook", layercodeWebhookHandler(welcomeMessage))
  )
