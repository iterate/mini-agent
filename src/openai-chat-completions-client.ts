/**
 * OpenAI Chat Completions Client
 *
 * A generic client for OpenAI-compatible chat completions APIs (Groq, Cerebras, etc).
 * Uses the standard /chat/completions endpoint.
 */
import * as AiError from "@effect/ai/AiError"
import * as LanguageModel from "@effect/ai/LanguageModel"
import type * as Response from "@effect/ai/Response"
import { addGenAIAnnotations } from "@effect/ai/Telemetry"
import * as Tool from "@effect/ai/Tool"
import * as Sse from "@effect/experimental/Sse"
import * as HttpBody from "@effect/platform/HttpBody"
import * as HttpClient from "@effect/platform/HttpClient"
import * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import * as Arr from "effect/Array"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import type * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import type { Span } from "effect/Tracer"

const ChatCompletionRequest = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(Schema.Struct({
    role: Schema.Literal("system", "user", "assistant", "tool"),
    content: Schema.Union(Schema.String, Schema.Null, Schema.Array(Schema.Unknown)),
    name: Schema.optional(Schema.String),
    tool_calls: Schema.optional(Schema.Array(Schema.Struct({
      id: Schema.String,
      type: Schema.Literal("function"),
      function: Schema.Struct({
        name: Schema.String,
        arguments: Schema.String
      })
    }))),
    tool_call_id: Schema.optional(Schema.String)
  })),
  tools: Schema.optional(Schema.Array(Schema.Struct({
    type: Schema.Literal("function"),
    function: Schema.Struct({
      name: Schema.String,
      description: Schema.optional(Schema.String),
      parameters: Schema.optional(Schema.Unknown),
      strict: Schema.optional(Schema.Boolean)
    })
  }))),
  tool_choice: Schema.optional(Schema.Union(
    Schema.Literal("none", "auto", "required"),
    Schema.Struct({
      type: Schema.Literal("function"),
      function: Schema.Struct({ name: Schema.String })
    })
  )),
  response_format: Schema.optional(Schema.Struct({
    type: Schema.Literal("json_schema"),
    json_schema: Schema.Struct({
      name: Schema.String,
      description: Schema.optional(Schema.String),
      schema: Schema.Unknown,
      strict: Schema.optional(Schema.Boolean)
    })
  })),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
  max_tokens: Schema.optional(Schema.Number),
  stop: Schema.optional(Schema.Union(Schema.String, Schema.Array(Schema.String))),
  stream: Schema.optional(Schema.Boolean),
  stream_options: Schema.optional(Schema.Struct({
    include_usage: Schema.optional(Schema.Boolean)
  }))
})

const ChatCompletionChoice = Schema.Struct({
  index: Schema.Number,
  message: Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.NullOr(Schema.String),
    tool_calls: Schema.optional(Schema.Array(Schema.Struct({
      id: Schema.String,
      type: Schema.Literal("function"),
      function: Schema.Struct({
        name: Schema.String,
        arguments: Schema.String
      })
    })))
  }),
  finish_reason: Schema.NullOr(Schema.String)
})

const ChatCompletionUsage = Schema.Struct({
  prompt_tokens: Schema.optional(Schema.Number),
  completion_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number)
})

const ChatCompletionResponse = Schema.Struct({
  id: Schema.String,
  object: Schema.String,
  created: Schema.Number,
  model: Schema.String,
  choices: Schema.Array(ChatCompletionChoice),
  usage: Schema.optional(ChatCompletionUsage)
})

const ChatStreamingDelta = Schema.Struct({
  role: Schema.optional(Schema.Literal("assistant")),
  content: Schema.optional(Schema.NullOr(Schema.String)),
  tool_calls: Schema.optional(Schema.Array(Schema.Struct({
    index: Schema.Number,
    id: Schema.optional(Schema.String),
    type: Schema.optional(Schema.Literal("function")),
    function: Schema.Struct({
      name: Schema.optional(Schema.String),
      arguments: Schema.optional(Schema.String)
    })
  })))
})

const ChatStreamingChoice = Schema.Struct({
  index: Schema.Number,
  delta: Schema.optional(ChatStreamingDelta),
  finish_reason: Schema.optional(Schema.NullOr(Schema.String))
})

const ChatStreamingChunk = Schema.Struct({
  id: Schema.optional(Schema.String),
  object: Schema.optional(Schema.String),
  created: Schema.optional(Schema.Number),
  model: Schema.optional(Schema.String),
  choices: Schema.Array(ChatStreamingChoice),
  usage: Schema.optional(ChatCompletionUsage)
})

type ChatCompletionRequest = typeof ChatCompletionRequest.Type
type ChatCompletionResponse = typeof ChatCompletionResponse.Type
type ChatStreamingChunk = typeof ChatStreamingChunk.Type

export class OpenAiChatClient extends Context.Tag("@app/OpenAiChatClient")<
  OpenAiChatClient,
  {
    readonly createChatCompletion: (
      request: ChatCompletionRequest
    ) => Effect.Effect<ChatCompletionResponse, AiError.AiError>
    readonly createChatCompletionStream: (
      request: ChatCompletionRequest
    ) => Stream.Stream<ChatStreamingChunk, AiError.AiError>
  }
>() {
  static layer(options: {
    readonly apiKey?: Redacted.Redacted | undefined
    readonly apiUrl?: string | undefined
  }): Layer.Layer<OpenAiChatClient, never, HttpClient.HttpClient> {
    return Layer.effect(
      OpenAiChatClient,
      Effect.gen(function*() {
        const httpClient = (yield* HttpClient.HttpClient).pipe(
          HttpClient.mapRequest((request) =>
            request.pipe(
              HttpClientRequest.prependUrl(options.apiUrl ?? "https://api.openai.com/v1"),
              options.apiKey ? HttpClientRequest.bearerToken(options.apiKey) : identity,
              HttpClientRequest.acceptJson
            )
          )
        )
        const httpClientOk = HttpClient.filterStatusOk(httpClient)

        const decodeResponse = Schema.decodeUnknown(ChatCompletionResponse)
        const decodeChunk = Schema.decode(Schema.parseJson(ChatStreamingChunk))

        const createChatCompletion = (
          request: ChatCompletionRequest
        ): Effect.Effect<ChatCompletionResponse, AiError.AiError> =>
          Effect.gen(function*() {
            const httpRequest = HttpClientRequest.post("/chat/completions", {
              body: HttpBody.unsafeJson(request)
            })
            const response = yield* httpClientOk.execute(httpRequest).pipe(
              Effect.flatMap((r) => r.json),
              Effect.scoped,
              Effect.catchTags({
                RequestError: (error) =>
                  AiError.HttpRequestError.fromRequestError({
                    module: "OpenAiChatClient",
                    method: "createChatCompletion",
                    error
                  }),
                ResponseError: (error) =>
                  AiError.HttpResponseError.fromResponseError({
                    module: "OpenAiChatClient",
                    method: "createChatCompletion",
                    error
                  })
              })
            )
            return yield* decodeResponse(response).pipe(
              Effect.catchTag("ParseError", (error) =>
                AiError.MalformedOutput.fromParseError({
                  module: "OpenAiChatClient",
                  method: "createChatCompletion",
                  error
                }))
            )
          })

        const createChatCompletionStream = (
          request: ChatCompletionRequest
        ): Stream.Stream<ChatStreamingChunk, AiError.AiError> => {
          const httpRequest = HttpClientRequest.post("/chat/completions", {
            body: HttpBody.unsafeJson({
              ...request,
              stream: true,
              stream_options: { include_usage: true }
            })
          })
          return httpClientOk.execute(httpRequest).pipe(
            Effect.map((r) => r.stream),
            Stream.unwrapScoped,
            Stream.decodeText(),
            Stream.pipeThroughChannel(Sse.makeChannel()),
            Stream.takeWhile((event) => event.data !== "[DONE]"),
            Stream.mapEffect((event) => decodeChunk(event.data)),
            Stream.catchTags({
              RequestError: (error) =>
                AiError.HttpRequestError.fromRequestError({
                  module: "OpenAiChatClient",
                  method: "streamRequest",
                  error
                }),
              ResponseError: (error) =>
                AiError.HttpResponseError.fromResponseError({
                  module: "OpenAiChatClient",
                  method: "streamRequest",
                  error
                }),
              ParseError: (error) =>
                AiError.MalformedOutput.fromParseError({
                  module: "OpenAiChatClient",
                  method: "streamRequest",
                  error
                })
            })
          )
        }

        return OpenAiChatClient.of({
          createChatCompletion,
          createChatCompletionStream
        })
      })
    )
  }
}

export const OpenAiChatLanguageModel = {
  layer(options: { readonly model: string }): Layer.Layer<LanguageModel.LanguageModel, never, OpenAiChatClient> {
    return Layer.effect(
      LanguageModel.LanguageModel,
      Effect.gen(function*() {
        const client = yield* OpenAiChatClient

        const makeRequest = (providerOptions: LanguageModel.ProviderOptions): Effect.Effect<
          ChatCompletionRequest,
          AiError.AiError
        > =>
          Effect.gen(function*() {
            const messages = yield* prepareMessages(providerOptions)
            const { toolChoice, tools } = yield* prepareTools(providerOptions)
            const responseFormat = providerOptions.responseFormat

            return {
              model: options.model,
              messages,
              tools,
              tool_choice: toolChoice,
              response_format: responseFormat.type === "text" ? undefined : {
                type: "json_schema" as const,
                json_schema: {
                  name: responseFormat.objectName,
                  description: Tool.getDescriptionFromSchemaAst(responseFormat.schema.ast) ??
                    "Respond with a JSON object",
                  schema: Tool.getJsonSchemaFromSchemaAst(responseFormat.schema.ast),
                  strict: true
                }
              }
            }
          })

        return yield* LanguageModel.make({
          generateText: Effect.fnUntraced(function*(opts) {
            const request = yield* makeRequest(opts)
            annotateRequest(opts.span, request)
            const rawResponse = yield* client.createChatCompletion(request)
            annotateResponse(opts.span, rawResponse)
            return yield* makeResponse(rawResponse)
          }),
          streamText: Effect.fnUntraced(
            function*(opts) {
              const request = yield* makeRequest(opts)
              annotateRequest(opts.span, request)
              return client.createChatCompletionStream(request)
            },
            (effect, opts) =>
              effect.pipe(
                Effect.flatMap((stream) => makeStreamResponse(stream)),
                Stream.unwrap,
                Stream.map((response) => {
                  annotateStreamResponse(opts.span, response)
                  return response
                })
              )
          )
        })
      })
    )
  }
}

type Message = ChatCompletionRequest["messages"][number]
type ToolDef = NonNullable<ChatCompletionRequest["tools"]>[number]
type ToolChoice = NonNullable<ChatCompletionRequest["tool_choice"]>

const prepareMessages = (options: LanguageModel.ProviderOptions): Effect.Effect<
  Array<Message>,
  AiError.AiError
> =>
  Effect.sync(() => {
    const messages: Array<Message> = []

    for (const message of options.prompt.content) {
      switch (message.role) {
        case "system": {
          messages.push({
            role: "system",
            content: message.content
          })
          break
        }

        case "user": {
          const firstPart = message.content[0]
          if (message.content.length === 1 && firstPart !== undefined && firstPart.type === "text") {
            messages.push({
              role: "user",
              content: firstPart.text
            })
          } else {
            const content: Array<unknown> = []
            for (const part of message.content) {
              switch (part.type) {
                case "text": {
                  content.push({
                    type: "text",
                    text: part.text
                  })
                  break
                }
                case "file": {
                  if (part.mediaType.startsWith("image/")) {
                    const mediaType = part.mediaType === "image/*" ? "image/jpeg" : part.mediaType
                    content.push({
                      type: "image_url",
                      image_url: {
                        url: part.data instanceof URL
                          ? part.data.toString()
                          : part.data instanceof Uint8Array
                          ? `data:${mediaType};base64,${Encoding.encodeBase64(part.data)}`
                          : part.data
                      }
                    })
                  }
                  break
                }
              }
            }
            messages.push({
              role: "user",
              content
            })
          }
          break
        }

        case "assistant": {
          let text = ""
          const toolCalls: Array<{
            id: string
            type: "function"
            function: { name: string; arguments: string }
          }> = []
          for (const part of message.content) {
            switch (part.type) {
              case "text": {
                text += part.text
                break
              }
              case "tool-call": {
                toolCalls.push({
                  id: part.id,
                  type: "function",
                  function: {
                    name: part.name,
                    arguments: JSON.stringify(part.params)
                  }
                })
                break
              }
            }
          }
          messages.push({
            role: "assistant",
            content: text || null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined
          })
          break
        }

        case "tool": {
          for (const part of message.content) {
            messages.push({
              role: "tool",
              tool_call_id: part.id,
              content: JSON.stringify(part.result)
            })
          }
          break
        }
      }
    }

    return messages
  })

const prepareTools = (options: LanguageModel.ProviderOptions): Effect.Effect<{
  readonly tools: Array<ToolDef> | undefined
  readonly toolChoice: ToolChoice | undefined
}, AiError.AiError> =>
  Effect.gen(function*() {
    if (options.tools.length === 0) {
      return { tools: undefined, toolChoice: undefined }
    }

    const hasProviderDefinedTools = options.tools.some((tool) => Tool.isProviderDefined(tool))
    if (hasProviderDefinedTools) {
      return yield* new AiError.MalformedInput({
        module: "OpenAiChatLanguageModel",
        method: "prepareTools",
        description: "Provider-defined tools are unsupported"
      })
    }

    let tools: Array<ToolDef> = []
    let toolChoice: ToolChoice | undefined = undefined

    for (const tool of options.tools) {
      tools.push({
        type: "function",
        function: {
          name: tool.name,
          description: Tool.getDescription(tool as any),
          parameters: Tool.getJsonSchema(tool as any) as any,
          strict: true
        }
      })
    }

    if (options.toolChoice === "none") {
      toolChoice = "none"
    } else if (options.toolChoice === "auto") {
      toolChoice = "auto"
    } else if (options.toolChoice === "required") {
      toolChoice = "required"
    } else if ("tool" in options.toolChoice) {
      toolChoice = { type: "function", function: { name: options.toolChoice.tool } }
    } else {
      const allowedTools = new Set(options.toolChoice.oneOf)
      tools = tools.filter((tool) => allowedTools.has(tool.function.name))
      toolChoice = options.toolChoice.mode === "auto" ? "auto" : "required"
    }

    return { tools, toolChoice }
  })

const resolveFinishReason = (reason: string | null | undefined): Response.FinishReason => {
  switch (reason) {
    case "stop":
      return "stop"
    case "length":
      return "length"
    case "tool_calls":
      return "tool-calls"
    case "content_filter":
      return "content-filter"
    default:
      return "unknown"
  }
}

const makeResponse = (response: ChatCompletionResponse): Effect.Effect<
  Array<Response.PartEncoded>,
  AiError.AiError
> =>
  Effect.gen(function*() {
    const choice = response.choices[0]

    if (Predicate.isUndefined(choice)) {
      return yield* new AiError.MalformedOutput({
        module: "OpenAiChatLanguageModel",
        method: "makeResponse",
        description: "Received response with no valid choices"
      })
    }

    const parts: Array<Response.PartEncoded> = []
    const message = choice.message

    const createdAt = new Date(response.created * 1000)
    parts.push({
      type: "response-metadata",
      id: response.id,
      modelId: response.model,
      timestamp: DateTime.formatIso(DateTime.unsafeFromDate(createdAt))
    })

    if (Predicate.isNotNullable(message.content) && message.content.length > 0) {
      parts.push({
        type: "text",
        text: message.content
      })
    }

    if (Predicate.isNotNullable(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        const toolName = toolCall.function.name
        const toolParams = toolCall.function.arguments
        const params = yield* Effect.try({
          try: () => Tool.unsafeSecureJsonParse(toolParams),
          catch: (cause) =>
            new AiError.MalformedOutput({
              module: "OpenAiChatLanguageModel",
              method: "makeResponse",
              description: `Failed to parse tool call parameters for tool '${toolName}':\nParameters: ${toolParams}`,
              cause
            })
        })
        parts.push({
          type: "tool-call",
          id: toolCall.id,
          name: toolName,
          params
        })
      }
    }

    parts.push({
      type: "finish",
      reason: resolveFinishReason(choice.finish_reason),
      usage: {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
        totalTokens: response.usage?.total_tokens
      }
    })

    return parts
  })

const makeStreamResponse = (stream: Stream.Stream<ChatStreamingChunk, AiError.AiError>): Effect.Effect<
  Stream.Stream<Response.StreamPartEncoded, AiError.AiError>
> =>
  Effect.sync(() => {
    let idCounter = 0
    let activeTextId: string | undefined = undefined
    let finishReason: Response.FinishReason = "unknown"
    let responseMetadataEmitted = false

    const activeToolCalls: Record<number, {
      readonly index: number
      readonly id: string
      readonly name: string
      params: string
    }> = {}

    return stream.pipe(
      Stream.mapEffect((event) =>
        Effect.gen(function*() {
          const parts: Array<Response.StreamPartEncoded> = []

          if (Predicate.isNotUndefined(event.id) && !responseMetadataEmitted) {
            parts.push({
              type: "response-metadata",
              id: event.id,
              modelId: event.model,
              timestamp: DateTime.formatIso(yield* DateTime.now)
            })
            responseMetadataEmitted = true
          }

          const choice = event.choices[0]

          // Handle final usage-only chunk (empty choices array)
          if (Predicate.isUndefined(choice)) {
            if (Predicate.isNotUndefined(event.usage)) {
              // Flush text parts
              if (Predicate.isNotUndefined(activeTextId)) {
                parts.push({
                  type: "text-end",
                  id: activeTextId
                })
                activeTextId = undefined
              }

              parts.push({
                type: "finish",
                reason: finishReason,
                usage: {
                  inputTokens: event.usage?.prompt_tokens,
                  outputTokens: event.usage?.completion_tokens,
                  totalTokens: event.usage?.total_tokens
                }
              })
            }
            return parts
          }

          const delta = choice.delta

          if (Predicate.isUndefined(delta)) {
            return parts
          }

          // Text Parts
          if (Predicate.isNotNullable(delta.content) && delta.content.length > 0) {
            if (Predicate.isUndefined(activeTextId)) {
              activeTextId = (idCounter++).toString()
              parts.push({
                type: "text-start",
                id: activeTextId
              })
            }
            parts.push({
              type: "text-delta",
              id: activeTextId,
              delta: delta.content
            })
          }

          // Tool Call Parts
          if (Predicate.isNotNullable(delta.tool_calls) && delta.tool_calls.length > 0) {
            for (const toolCall of delta.tool_calls) {
              let activeToolCall = activeToolCalls[toolCall.index]

              if (Predicate.isUndefined(activeToolCall)) {
                activeToolCall = {
                  index: toolCall.index,
                  id: toolCall.id!,
                  name: toolCall.function.name!,
                  params: toolCall.function.arguments ?? ""
                }
                activeToolCalls[toolCall.index] = activeToolCall

                parts.push({
                  type: "tool-params-start",
                  id: activeToolCall.id,
                  name: activeToolCall.name
                })

                if (activeToolCall.params.length > 0) {
                  parts.push({
                    type: "tool-params-delta",
                    id: activeToolCall.id,
                    delta: activeToolCall.params
                  })
                }
              } else {
                activeToolCall.params += toolCall.function.arguments ?? ""
                parts.push({
                  type: "tool-params-delta",
                  id: activeToolCall.id,
                  delta: toolCall.function.arguments ?? ""
                })
              }

              try {
                const params = Tool.unsafeSecureJsonParse(activeToolCall.params)
                parts.push({
                  type: "tool-params-end",
                  id: activeToolCall.id
                })
                parts.push({
                  type: "tool-call",
                  id: activeToolCall.id,
                  name: activeToolCall.name,
                  params
                })
                delete activeToolCalls[toolCall.index]
              } catch {
                // Tool call incomplete
              }
            }
          }

          // Finish Parts
          if (Predicate.isNotNullable(choice.finish_reason)) {
            finishReason = resolveFinishReason(choice.finish_reason)
          }

          if (Predicate.isNotUndefined(event.usage)) {
            // Complete any remaining tool calls
            if (finishReason === "tool-calls") {
              for (const toolCall of Object.values(activeToolCalls)) {
                const params = yield* Effect.try(() => Tool.unsafeSecureJsonParse(toolCall.params)).pipe(
                  Effect.catchAll(() => Effect.succeed({}))
                )
                parts.push({
                  type: "tool-params-end",
                  id: toolCall.id
                })
                parts.push({
                  type: "tool-call",
                  id: toolCall.id,
                  name: toolCall.name,
                  params
                })
                delete activeToolCalls[toolCall.index]
              }
            }

            // Flush text parts
            if (Predicate.isNotUndefined(activeTextId)) {
              parts.push({
                type: "text-end",
                id: activeTextId
              })
              activeTextId = undefined
            }

            parts.push({
              type: "finish",
              reason: finishReason,
              usage: {
                inputTokens: event.usage?.prompt_tokens,
                outputTokens: event.usage?.completion_tokens,
                totalTokens: event.usage?.total_tokens
              }
            })
          }

          return parts
        })
      ),
      Stream.flattenIterables
    )
  })

const annotateRequest = (span: Span, request: ChatCompletionRequest): void => {
  addGenAIAnnotations(span, {
    system: "openai-compatible",
    operation: { name: "chat" },
    request: {
      model: request.model,
      temperature: request.temperature,
      topP: request.top_p,
      maxTokens: request.max_tokens,
      stopSequences: Arr.ensure(request.stop).filter(Predicate.isNotNullable)
    }
  })
}

const annotateResponse = (span: Span, response: ChatCompletionResponse): void => {
  addGenAIAnnotations(span, {
    response: {
      id: response.id,
      model: response.model,
      finishReasons: response.choices.map((choice) => choice.finish_reason).filter(Predicate.isNotNullable)
    },
    usage: {
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens
    }
  })
}

const annotateStreamResponse = (span: Span, part: Response.StreamPartEncoded) => {
  if (part.type === "response-metadata") {
    addGenAIAnnotations(span, {
      response: {
        id: part.id,
        model: part.modelId
      }
    })
  }
  if (part.type === "finish") {
    addGenAIAnnotations(span, {
      response: {
        finishReasons: [part.reason]
      },
      usage: {
        inputTokens: part.usage.inputTokens,
        outputTokens: part.usage.outputTokens
      }
    })
  }
}
