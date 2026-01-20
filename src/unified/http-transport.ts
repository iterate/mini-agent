/**
 * HTTP Transport for Unified Session
 *
 * Wraps OpenAI-compatible chat completions API as a stateless transport.
 */
import { Effect, Layer, Option, Stream } from "effect"

import { OpenAiChatClient } from "../openai-chat-completions-client.ts"
import {
  type ConversationContext,
  ConversationError,
  type ConversationInput,
  LlmTransport,
  type Message,
  RawEvent,
  type StatelessConnection,
  TextDelta,
  ToolCall,
  type ToolDefinition,
  TurnComplete
} from "./domain.ts"

interface HttpTransportConfig {
  readonly model: string
}

/**
 * Convert our Message format to OpenAI chat message format
 */
const messageToOpenAi = (msg: Message) => {
  const base: {
    role: "system" | "user" | "assistant" | "tool"
    content: string | null
    name?: string
    tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
    tool_call_id?: string
  } = {
    role: msg.role,
    content: msg.content
  }

  if (msg.toolCallId) {
    base.tool_call_id = msg.toolCallId
  }

  if (msg.toolCalls && msg.toolCalls.length > 0) {
    base.tool_calls = msg.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.params)
      }
    }))
  }

  return base
}

/**
 * Build messages array from conversation context
 */
const buildMessages = (ctx: ConversationContext) => {
  const messages: Array<ReturnType<typeof messageToOpenAi>> = []

  // Add system prompt if present
  if (Option.isSome(ctx.systemPrompt)) {
    messages.push({ role: "system", content: ctx.systemPrompt.value })
  }

  // Add conversation messages
  for (const msg of ctx.messages) {
    messages.push(messageToOpenAi(msg))
  }

  return messages
}

/**
 * Convert tool definitions to OpenAI format
 */
const toolsToOpenAi = (tools: ReadonlyArray<ToolDefinition>) =>
  tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }))

/**
 * Create HTTP transport layer
 */
export const HttpTransportLive = (
  config: HttpTransportConfig
): Layer.Layer<LlmTransport, never, OpenAiChatClient> =>
  Layer.effect(
    LlmTransport,
    Effect.gen(function*() {
      const client = yield* OpenAiChatClient

      return {
        connect: Effect.succeed<StatelessConnection>({
          _tag: "stateless",
          sendTurn: (
            ctx: ConversationContext,
            _input: ConversationInput,
            tools?: ReadonlyArray<ToolDefinition>
          ) => {
            const messages = buildMessages(ctx)

            const request = {
              model: config.model,
              messages,
              stream: true as const,
              stream_options: { include_usage: true },
              ...(tools && tools.length > 0 ? { tools: toolsToOpenAi(tools) } : {})
            }

            // Track tool calls being built across streaming chunks
            const activeToolCalls: Record<number, { id: string; name: string; args: string }> = {}

            return client.createChatCompletionStream(request).pipe(
              Stream.mapEffect((chunk) =>
                Effect.sync(() => {
                  const events: Array<
                    TextDelta | ToolCall | TurnComplete | ConversationError | RawEvent
                  > = []

                  // Log raw chunk
                  events.push(new RawEvent({ type: "chat.completion.chunk", data: chunk }))

                  const choice = chunk.choices[0]
                  if (choice?.delta) {
                    const delta = choice.delta

                    // Text content
                    if (delta.content && delta.content.length > 0) {
                      events.push(new TextDelta({ delta: delta.content }))
                    }

                    // Tool calls - accumulate across chunks
                    if (delta.tool_calls) {
                      for (const tc of delta.tool_calls) {
                        const idx = tc.index
                        if (tc.id && tc.function?.name) {
                          // New tool call starting
                          activeToolCalls[idx] = {
                            id: tc.id,
                            name: tc.function.name,
                            args: tc.function.arguments ?? ""
                          }
                        } else if (activeToolCalls[idx] && tc.function?.arguments) {
                          // Continuing to accumulate arguments
                          activeToolCalls[idx].args += tc.function.arguments
                        }
                      }
                    }
                  }

                  // On finish_reason, emit accumulated tool calls
                  if (choice?.finish_reason === "tool_calls") {
                    for (const tc of Object.values(activeToolCalls)) {
                      try {
                        const params = tc.args ? JSON.parse(tc.args) : {}
                        events.push(new ToolCall({ id: tc.id, name: tc.name, params }))
                      } catch {
                        events.push(new ToolCall({ id: tc.id, name: tc.name, params: {} }))
                      }
                    }
                  }

                  // Finish event
                  if (chunk.usage) {
                    events.push(
                      new TurnComplete({
                        inputTokens: chunk.usage.prompt_tokens,
                        outputTokens: chunk.usage.completion_tokens
                      })
                    )
                  }

                  return events
                })
              ),
              Stream.flatMap((events) => Stream.fromIterable(events)),
              Stream.catchAll((error) =>
                Stream.succeed(
                  new ConversationError({
                    message: error.message,
                    code: Option.some("HTTP_ERROR")
                  })
                )
              )
            )
          }
        })
      }
    })
  )
