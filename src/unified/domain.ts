/**
 * Unified LLM Abstraction - Domain Types
 *
 * Core types for a transport-agnostic conversation interface that works
 * with both HTTP-based chat completions and WebSocket-based voice APIs.
 */
import { Context, Effect, Option, Queue, Ref, Schema, Stream } from "effect"

// Tool definitions

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: {
    readonly type: "object"
    readonly properties: Record<string, unknown>
    readonly required?: ReadonlyArray<string>
  }
}

export type ToolHandler = (params: unknown) => Effect.Effect<unknown, Error>

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
    input: ConversationInput,
    tools?: ReadonlyArray<ToolDefinition>
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

export interface PendingToolCall {
  readonly id: string
  readonly name: string
  readonly params: unknown
}

export interface ConversationContext {
  readonly messages: Array<Message>
  readonly systemPrompt: Option.Option<string>
  readonly turnNumber: number
  readonly pendingToolCalls: Array<PendingToolCall>
}

export const emptyContext: ConversationContext = {
  messages: [],
  systemPrompt: Option.none(),
  turnNumber: 0,
  pendingToolCalls: []
}

export const addUserMessage = (ctx: ConversationContext, text: string): ConversationContext => ({
  ...ctx,
  messages: [...ctx.messages, { role: "user", content: text }]
})

export const addAssistantMessage = (
  ctx: ConversationContext,
  content: string,
  toolCalls?: Array<{ id: string; name: string; params: unknown }>
): ConversationContext => {
  const message: Message = toolCalls && toolCalls.length > 0
    ? { role: "assistant", content, toolCalls }
    : { role: "assistant", content }
  return {
    ...ctx,
    messages: [...ctx.messages, message],
    pendingToolCalls: toolCalls ?? [],
    turnNumber: ctx.turnNumber + 1
  }
}

export const addToolResult = (
  ctx: ConversationContext,
  toolCallId: string,
  result: unknown
): ConversationContext => ({
  ...ctx,
  messages: [...ctx.messages, { role: "tool", content: JSON.stringify(result), toolCallId }],
  pendingToolCalls: ctx.pendingToolCalls.filter((tc) => tc.id !== toolCallId)
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
  readonly tools?: ReadonlyArray<ToolDefinition>
  readonly toolHandlers?: Record<string, ToolHandler>
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

    const tools = config?.tools
    const toolHandlers = config?.toolHandlers ?? {}

    // Execute a tool and return the result
    const executeToolCall = (
      toolCall: PendingToolCall
    ): Effect.Effect<{ id: string; result: unknown }, ConversationError> =>
      Effect.gen(function*() {
        const handler = toolHandlers[toolCall.name]
        if (!handler) {
          return { id: toolCall.id, result: { error: `Unknown tool: ${toolCall.name}` } }
        }
        const result = yield* handler(toolCall.params).pipe(
          Effect.catchAll((e) => Effect.succeed({ error: e.message }))
        )
        return { id: toolCall.id, result }
      })

    // Process a single turn and return accumulated tool calls
    const processTurn = (
      ctx: ConversationContext,
      input: ConversationInput
    ): Effect.Effect<Array<PendingToolCall>, ConversationError> =>
      Effect.gen(function*() {
        if (connection._tag !== "stateless") return []

        const responseStream = connection.sendTurn(ctx, input, tools)
        let fullResponse = ""
        const toolCalls: Array<PendingToolCall> = []

        yield* responseStream.pipe(
          Stream.tap((event) =>
            Effect.gen(function*() {
              yield* Queue.offer(eventQueue, event)
              if (event._tag === "TextDelta") {
                fullResponse += event.delta
              } else if (event._tag === "ToolCall") {
                toolCalls.push({ id: event.id, name: event.name, params: event.params })
              }
            })
          ),
          Stream.runDrain
        )

        // Update context with assistant response (including any tool calls)
        yield* Ref.update(contextRef, (c) =>
          addAssistantMessage(
            c,
            fullResponse,
            toolCalls.length > 0 ? toolCalls : undefined
          ))

        return toolCalls
      })

    // Run the agent loop: process turn, execute tools, repeat until no tool calls
    const runAgentLoop = (input: ConversationInput): Effect.Effect<void, ConversationError> =>
      Effect.gen(function*() {
        let ctx = yield* Ref.get(contextRef)
        let toolCalls = yield* processTurn(ctx, input)

        while (toolCalls.length > 0) {
          // Execute all tool calls
          for (const toolCall of toolCalls) {
            const { id, result } = yield* executeToolCall(toolCall)
            // Emit tool result event
            yield* Queue.offer(eventQueue, new ToolResult({ id, result }))
            // Update context with tool result
            yield* Ref.update(contextRef, (c) => addToolResult(c, id, result))
          }

          // Get updated context and send another turn
          ctx = yield* Ref.get(contextRef)
          toolCalls = yield* processTurn(ctx, new ToolResponseInput({ id: "", result: null }))
        }
      })

    // For stateful connections, fork a fiber to pump events to queue
    // and automatically execute tool calls
    if (connection._tag === "stateful") {
      yield* connection.events.pipe(
        Stream.tap((event) =>
          Effect.gen(function*() {
            yield* Queue.offer(eventQueue, event)

            // Auto-execute tool calls for stateful connections
            if (event._tag === "ToolCall") {
              const { id, result } = yield* executeToolCall({
                id: event.id,
                name: event.name,
                params: event.params
              })
              yield* Queue.offer(eventQueue, new ToolResult({ id, result }))
              yield* connection.sendToolResult(id, result)
            }
          })
        ),
        Stream.runDrain,
        Effect.forkDaemon
      )
    }

    const sendText = (text: string): Effect.Effect<void, ConversationError> =>
      Effect.gen(function*() {
        yield* Ref.update(contextRef, (ctx) => addUserMessage(ctx, text))

        if (connection._tag === "stateless") {
          yield* runAgentLoop(new TextInput({ text }))
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
          yield* runAgentLoop(new ToolResponseInput({ id, result }))
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
