/**
 * Unified LLM Abstraction - Domain Types
 *
 * Core types for a transport-agnostic conversation interface that works
 * with both HTTP-based chat completions and WebSocket-based voice APIs.
 */
import { Context, Effect, Option, Queue, Ref, Schema, Stream } from "effect"

// Event types that flow from the LLM to the client

export class TextDelta extends Schema.TaggedClass<TextDelta>()("TextDelta", {
  delta: Schema.String
}) {}

export class TextComplete extends Schema.TaggedClass<TextComplete>()("TextComplete", {
  content: Schema.String
}) {}

export class AudioDelta extends Schema.TaggedClass<AudioDelta>()("AudioDelta", {
  /** Base64-encoded audio chunk or raw Buffer depending on transport */
  chunk: Schema.Unknown
}) {}

export class AudioComplete extends Schema.TaggedClass<AudioComplete>()("AudioComplete", {}) {}

export class ToolCall extends Schema.TaggedClass<ToolCall>()("ToolCall", {
  id: Schema.String,
  name: Schema.String,
  params: Schema.Unknown
}) {}

export class ToolResult extends Schema.TaggedClass<ToolResult>()("ToolResult", {
  id: Schema.String,
  result: Schema.Unknown
}) {}

export class TurnComplete extends Schema.TaggedClass<TurnComplete>()("TurnComplete", {
  inputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number)
}) {}

export class ConversationError extends Schema.TaggedClass<ConversationError>()("ConversationError", {
  message: Schema.String,
  code: Schema.optionalWith(Schema.String, { as: "Option" })
}) {}

export class UserTranscript extends Schema.TaggedClass<UserTranscript>()("UserTranscript", {
  transcript: Schema.String
}) {}

// Voice-specific lifecycle events
export class SessionReady extends Schema.TaggedClass<SessionReady>()("SessionReady", {}) {}

export class SpeechStarted extends Schema.TaggedClass<SpeechStarted>()("SpeechStarted", {}) {}

export class SpeechStopped extends Schema.TaggedClass<SpeechStopped>()("SpeechStopped", {}) {}

export class ResponseStarted extends Schema.TaggedClass<ResponseStarted>()("ResponseStarted", {}) {}

export class RawEvent extends Schema.TaggedClass<RawEvent>()("RawEvent", {
  type: Schema.String,
  data: Schema.Unknown
}) {}

export const ConversationEvent = Schema.Union(
  TextDelta,
  TextComplete,
  AudioDelta,
  AudioComplete,
  ToolCall,
  ToolResult,
  TurnComplete,
  ConversationError,
  UserTranscript,
  SessionReady,
  SpeechStarted,
  SpeechStopped,
  ResponseStarted,
  RawEvent
)
export type ConversationEvent = typeof ConversationEvent.Type

// Input types that flow from client to LLM

export class TextInput extends Schema.TaggedClass<TextInput>()("TextInput", {
  text: Schema.String
}) {}

export class AudioInput extends Schema.TaggedClass<AudioInput>()("AudioInput", {
  chunk: Schema.Unknown
}) {}

export class ToolResponseInput extends Schema.TaggedClass<ToolResponseInput>()("ToolResponseInput", {
  id: Schema.String,
  result: Schema.Unknown
}) {}

export const ConversationInput = Schema.Union(TextInput, AudioInput, ToolResponseInput)
export type ConversationInput = typeof ConversationInput.Type

// Transport abstraction

export interface StatelessConnection {
  readonly _tag: "stateless"
  /**
   * Send a complete turn (all accumulated context + new input) and get response stream.
   * The transport handles building the full request from context.
   */
  readonly sendTurn: (
    context: ConversationContext,
    input: ConversationInput
  ) => Stream.Stream<ConversationEvent, ConversationError>
}

export interface StatefulConnection {
  readonly _tag: "stateful"
  /** Send text to the conversation */
  readonly sendText: (text: string) => Effect.Effect<void, ConversationError>
  /** Send an audio chunk */
  readonly sendAudio: (chunk: Buffer) => Effect.Effect<void, ConversationError>
  /** Send a tool result */
  readonly sendToolResult: (id: string, result: unknown) => Effect.Effect<void, ConversationError>
  /** Stream of events from the LLM */
  readonly events: Stream.Stream<ConversationEvent, ConversationError>
  /** Close the connection */
  readonly close: Effect.Effect<void>
}

export type LlmConnection = StatelessConnection | StatefulConnection

/**
 * Transport service - provides a connection to an LLM.
 * Implementations can be HTTP-based (stateless) or WebSocket-based (stateful).
 */
export class LlmTransport extends Context.Tag("@unified/LlmTransport")<
  LlmTransport,
  {
    readonly connect: Effect.Effect<LlmConnection, ConversationError>
  }
>() {}

// Conversation state

export interface Message {
  readonly role: "system" | "user" | "assistant" | "tool"
  readonly content: string
  readonly toolCallId?: string
  readonly toolCalls?: Array<{ id: string; name: string; params: unknown }>
}

export interface ConversationContext {
  readonly messages: Array<Message>
  readonly systemPrompt: Option.Option<string>
  readonly turnNumber: number
}

export const emptyContext: ConversationContext = {
  messages: [],
  systemPrompt: Option.none(),
  turnNumber: 0
}

export const addUserMessage = (ctx: ConversationContext, text: string): ConversationContext => ({
  ...ctx,
  messages: [...ctx.messages, { role: "user", content: text }]
})

export const addAssistantMessage = (ctx: ConversationContext, content: string): ConversationContext => ({
  ...ctx,
  messages: [...ctx.messages, { role: "assistant", content }],
  turnNumber: ctx.turnNumber + 1
})

export const addToolResult = (
  ctx: ConversationContext,
  toolCallId: string,
  result: unknown
): ConversationContext => ({
  ...ctx,
  messages: [...ctx.messages, { role: "tool", content: JSON.stringify(result), toolCallId }]
})

export const setSystemPrompt = (ctx: ConversationContext, prompt: string): ConversationContext => ({
  ...ctx,
  systemPrompt: Option.some(prompt)
})

/**
 * Unified session service.
 * Wraps a transport and provides a consistent interface for both stateless and stateful modes.
 */
export class UnifiedSession extends Context.Tag("@unified/UnifiedSession")<
  UnifiedSession,
  {
    /** Send a text message */
    readonly sendText: (text: string) => Effect.Effect<void, ConversationError>
    /** Send an audio chunk (only supported for stateful transports) */
    readonly sendAudio: (chunk: Buffer) => Effect.Effect<void, ConversationError>
    /** Send a tool result */
    readonly sendToolResult: (id: string, result: unknown) => Effect.Effect<void, ConversationError>
    /** Stream of all conversation events */
    readonly events: Stream.Stream<ConversationEvent, ConversationError>
    /** Get current conversation context */
    readonly getContext: Effect.Effect<ConversationContext>
    /** Set system prompt */
    readonly setSystemPrompt: (prompt: string) => Effect.Effect<void>
  }
>() {}

/**
 * Configuration for the unified session
 */
export interface UnifiedSessionConfig {
  readonly systemPrompt?: string
}

/**
 * Create a UnifiedSession from a transport.
 */
export const makeUnifiedSession = (
  config?: UnifiedSessionConfig
): Effect.Effect<
  {
    readonly sendText: (text: string) => Effect.Effect<void, ConversationError>
    readonly sendAudio: (chunk: Buffer) => Effect.Effect<void, ConversationError>
    readonly sendToolResult: (id: string, result: unknown) => Effect.Effect<void, ConversationError>
    readonly events: Stream.Stream<ConversationEvent, ConversationError>
    readonly getContext: Effect.Effect<ConversationContext>
    readonly setSystemPrompt: (prompt: string) => Effect.Effect<void>
  },
  ConversationError,
  LlmTransport
> =>
  Effect.gen(function*() {
    const transport = yield* LlmTransport
    const connection = yield* transport.connect

    const initialContext: ConversationContext = config?.systemPrompt
      ? setSystemPrompt(emptyContext, config.systemPrompt)
      : emptyContext

    const contextRef = yield* Ref.make(initialContext)
    const eventQueue = yield* Queue.unbounded<ConversationEvent>()

    // For stateful connections, fork a fiber to pump events to queue
    if (connection._tag === "stateful") {
      yield* connection.events.pipe(
        Stream.runForEach((event) => Queue.offer(eventQueue, event)),
        Effect.forkDaemon
      )
    }

    const sendText = (text: string): Effect.Effect<void, ConversationError> =>
      Effect.gen(function*() {
        yield* Ref.update(contextRef, (ctx) => addUserMessage(ctx, text))

        if (connection._tag === "stateless") {
          const ctx = yield* Ref.get(contextRef)
          const responseStream = connection.sendTurn(ctx, new TextInput({ text }))

          // Accumulate full response while streaming events
          let fullResponse = ""

          yield* responseStream.pipe(
            Stream.tap((event) =>
              Effect.gen(function*() {
                yield* Queue.offer(eventQueue, event)
                if (event._tag === "TextDelta") {
                  fullResponse += event.delta
                }
              })
            ),
            Stream.runDrain
          )

          // Update context with assistant response
          if (fullResponse.length > 0) {
            yield* Ref.update(contextRef, (ctx) => addAssistantMessage(ctx, fullResponse))
          }
        } else {
          yield* connection.sendText(text)
        }
      })

    const sendAudio = (chunk: Buffer): Effect.Effect<void, ConversationError> =>
      Effect.gen(function*() {
        if (connection._tag === "stateless") {
          return yield* Effect.fail(
            new ConversationError({
              message: "Audio input not supported for stateless transport",
              code: Option.some("UNSUPPORTED_OPERATION")
            })
          )
        }
        yield* connection.sendAudio(chunk)
      })

    const sendToolResult = (id: string, result: unknown): Effect.Effect<void, ConversationError> =>
      Effect.gen(function*() {
        yield* Ref.update(contextRef, (ctx) => addToolResult(ctx, id, result))

        if (connection._tag === "stateless") {
          // For stateless, we need to send another turn with the tool result
          const ctx = yield* Ref.get(contextRef)
          const responseStream = connection.sendTurn(ctx, new ToolResponseInput({ id, result }))
          yield* responseStream.pipe(
            Stream.tap((event) => Queue.offer(eventQueue, event)),
            Stream.runDrain
          )
        } else {
          yield* connection.sendToolResult(id, result)
        }
      })

    const getContext = Ref.get(contextRef)

    const setSystemPromptFn = (prompt: string) => Ref.update(contextRef, (ctx) => setSystemPrompt(ctx, prompt))

    return {
      sendText,
      sendAudio,
      sendToolResult,
      events: Stream.fromQueue(eventQueue),
      getContext,
      setSystemPrompt: setSystemPromptFn
    }
  })
