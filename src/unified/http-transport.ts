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
  type StatelessConnection,
  TextDelta,
  ToolCall,
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
          sendTurn: (ctx: ConversationContext, _input: ConversationInput) => {
            const messages = buildMessages(ctx)

            const request = {
              model: config.model,
              messages,
              stream: true as const,
              stream_options: { include_usage: true }
            }

            return client.createChatCompletionStream(request).pipe(
              Stream.mapEffect((chunk) =>
                Effect.sync(() => {
                  const events: Array<
                    TextDelta | ToolCall | TurnComplete | ConversationError
                  > = []

                  const choice = chunk.choices[0]
                  if (choice?.delta) {
                    const delta = choice.delta

                    // Text content
                    if (delta.content && delta.content.length > 0) {
                      events.push(new TextDelta({ delta: delta.content }))
                    }

                    // Tool calls
                    if (delta.tool_calls) {
                      for (const tc of delta.tool_calls) {
                        if (tc.id && tc.function?.name) {
                          // Tool call start - we get id and name
                          // Arguments stream in chunks, so we'd need to accumulate
                          // For simplicity, emit on first chunk with name
                          try {
                            const params = tc.function.arguments
                              ? JSON.parse(tc.function.arguments)
                              : {}
                            events.push(new ToolCall({ id: tc.id, name: tc.function.name, params }))
                          } catch {
                            // Arguments incomplete, skip for now
                          }
                        }
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
