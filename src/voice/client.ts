/**
 * Grok Voice Client
 *
 * WebSocket client for XAI's realtime voice API.
 */
import { Effect, Queue, Schema, Stream } from "effect"
import WebSocket from "ws"

import {
  ConversationCreatedEvent,
  ConversationItemCreateMessage,
  DEFAULT_API_URL,
  DEFAULT_INSTRUCTIONS,
  DEFAULT_SAMPLE_RATE,
  DEFAULT_VOICE,
  ErrorEvent,
  InputAudioBufferSpeechStartedEvent,
  InputAudioTranscriptionCompletedEvent,
  ResponseCreateMessage,
  ResponseDoneEvent,
  ResponseOutputAudioDeltaEvent,
  ResponseOutputAudioTranscriptDeltaEvent,
  SessionUpdatedEvent,
  type VoiceSessionConfig
} from "./domain.ts"

export interface ToolCallEvent {
  readonly id: string
  readonly name: string
  readonly params: unknown
}

export interface GrokVoiceConnection {
  readonly send: (audio: Buffer) => Effect.Effect<void>
  readonly sendText: (text: string) => Effect.Effect<void>
  readonly sendToolResult: (callId: string, result: unknown) => Effect.Effect<void>
  readonly audioOutput: Stream.Stream<Buffer>
  readonly transcripts: Stream.Stream<string>
  readonly userTranscripts: Stream.Stream<string>
  readonly toolCalls: Stream.Stream<ToolCallEvent>
  readonly events: Stream.Stream<unknown>
  readonly close: Effect.Effect<void>
  readonly waitForReady: Effect.Effect<void>
}

interface WsHolder {
  ws: WebSocket | null
}

export class GrokVoiceClient extends Effect.Service<GrokVoiceClient>()("@lome/GrokVoiceClient", {
  effect: Effect.succeed({
    connect: (config: VoiceSessionConfig): Effect.Effect<GrokVoiceConnection, Error> =>
      Effect.gen(function*() {
        const apiUrl = config.apiUrl ?? DEFAULT_API_URL
        const voice = config.voice ?? DEFAULT_VOICE
        const instructions = config.instructions ?? DEFAULT_INSTRUCTIONS

        yield* Effect.log(`Connecting to ${apiUrl}`)

        const audioQueue = yield* Queue.unbounded<Buffer>()
        const transcriptQueue = yield* Queue.unbounded<string>()
        const userTranscriptQueue = yield* Queue.unbounded<string>()
        const toolCallQueue = yield* Queue.unbounded<ToolCallEvent>()
        const eventQueue = yield* Queue.unbounded<unknown>()
        const readyQueue = yield* Queue.bounded<void>(1)

        // Track active function calls being built
        const activeFunctionCalls: Record<string, { name: string; args: string }> = {}

        const holder: WsHolder = { ws: null }
        let isConfigured = false

        const sendSessionConfig = (socket: WebSocket) => {
          const sampleRate = config.sampleRate ?? DEFAULT_SAMPLE_RATE
          const sessionConfig: {
            type: string
            session: {
              instructions: string
              voice: string
              audio: {
                input: { format: { type: string; rate: number } }
                output: { format: { type: string; rate: number } }
              }
              input_audio_transcription: { model: string }
              turn_detection: {
                type: string
                threshold: number
                prefix_padding_ms: number
                silence_duration_ms: number
                create_response: boolean
              }
              tools?: Array<{ type: string; name: string; description: string; parameters: unknown }>
            }
          } = {
            type: "session.update",
            session: {
              instructions,
              voice,
              audio: {
                input: {
                  format: {
                    type: "audio/pcm",
                    rate: sampleRate
                  }
                },
                output: {
                  format: {
                    type: "audio/pcm",
                    rate: sampleRate
                  }
                }
              },
              input_audio_transcription: { model: "whisper-large-v3-turbo" },
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
                create_response: true
              }
            }
          }

          // Add tools if provided
          if (config.tools && config.tools.length > 0) {
            sessionConfig.session.tools = config.tools.map((t) => ({
              type: "function",
              name: t.name,
              description: t.description,
              parameters: t.parameters
            }))
          }

          socket.send(JSON.stringify(sessionConfig))
          isConfigured = true
        }

        const handleMessage = (data: WebSocket.Data) => {
          try {
            const message = JSON.parse(data.toString()) as { type: string; [key: string]: unknown }
            const eventType = message.type

            Effect.runSync(Queue.offer(eventQueue, message))

            if (eventType === "conversation.created") {
              Schema.decodeUnknownSync(ConversationCreatedEvent)(message)
              if (!isConfigured && holder.ws) {
                Effect.runSync(Effect.log("Configuring session..."))
                sendSessionConfig(holder.ws)
              }
            } else if (eventType === "session.updated") {
              Schema.decodeUnknownSync(SessionUpdatedEvent)(message)
              Effect.runSync(Effect.log("Session configured, ready for voice"))
              Effect.runSync(Queue.offer(readyQueue, void 0))
            } else if (eventType === "response.output_audio.delta") {
              const evt = Schema.decodeUnknownSync(ResponseOutputAudioDeltaEvent)(message)
              const audioBuffer = Buffer.from(evt.delta, "base64")
              Effect.runSync(Queue.offer(audioQueue, audioBuffer))
            } else if (eventType === "response.output_audio_transcript.delta") {
              const evt = Schema.decodeUnknownSync(ResponseOutputAudioTranscriptDeltaEvent)(message)
              Effect.runSync(Queue.offer(transcriptQueue, evt.delta))
            } else if (eventType === "conversation.item.input_audio_transcription.completed") {
              const evt = Schema.decodeUnknownSync(InputAudioTranscriptionCompletedEvent)(message)
              if (evt.transcript) {
                Effect.runSync(Queue.offer(userTranscriptQueue, evt.transcript))
              }
            } else if (eventType === "input_audio_buffer.speech_started") {
              Schema.decodeUnknownSync(InputAudioBufferSpeechStartedEvent)(message)
              Effect.runSync(Effect.log("Speech detected"))
            } else if (eventType === "response.created") {
              Effect.runSync(Effect.log("Response started"))
            } else if (eventType === "response.done") {
              Schema.decodeUnknownSync(ResponseDoneEvent)(message)
              Effect.runSync(Effect.log("Response complete"))
            } else if (eventType === "response.output_item.added") {
              // Check if this is a function call item
              const item = (message as { item?: { type?: string; call_id?: string; name?: string } }).item
              if (item?.type === "function_call" && item.call_id && item.name) {
                activeFunctionCalls[item.call_id] = { name: item.name, args: "" }
                Effect.runSync(Effect.log(`Function call started: ${item.name}`))
              }
            } else if (eventType === "response.function_call_arguments.delta") {
              const msg = message as { call_id?: string; delta?: string }
              const callId = msg.call_id
              if (callId && msg.delta) {
                const fc = activeFunctionCalls[callId]
                if (fc) {
                  fc.args += msg.delta
                }
              }
            } else if (eventType === "response.function_call_arguments.done") {
              const msg = message as { call_id?: string; arguments?: string }
              const callId = msg.call_id
              if (callId) {
                const fc = activeFunctionCalls[callId]
                if (fc) {
                  const args = msg.arguments ?? fc.args
                  try {
                    const params = args ? JSON.parse(args) : {}
                    Effect.runSync(Queue.offer(toolCallQueue, { id: callId, name: fc.name, params }))
                    Effect.runSync(Effect.log(`Function call complete: ${fc.name}`))
                  } catch {
                    Effect.runSync(Queue.offer(toolCallQueue, { id: callId, name: fc.name, params: {} }))
                  }
                  delete activeFunctionCalls[callId]
                }
              }
            } else if (eventType === "error") {
              const evt = Schema.decodeUnknownSync(ErrorEvent)(message)
              Effect.runSync(Effect.logError(`XAI Error: ${evt.error?.message ?? "Unknown error"}`))
            }
          } catch (e) {
            Effect.runSync(Effect.logDebug(`Failed to parse message: ${e}`))
          }
        }

        yield* Effect.async<void, Error>((resume) => {
          const ws = new WebSocket(apiUrl, {
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              "Content-Type": "application/json"
            }
          })
          holder.ws = ws

          ws.on("open", () => {
            Effect.runSync(Effect.log("WebSocket connected"))
            resume(Effect.void)
          })

          ws.on("message", handleMessage)

          ws.on("error", (error) => {
            Effect.runSync(Effect.logError(`WebSocket error: ${error.message}`))
            resume(Effect.fail(error as Error))
          })

          ws.on("close", (code, reason) => {
            Effect.runSync(Effect.log(`WebSocket closed: ${code} ${reason.toString()}`))
            Effect.runSync(Queue.shutdown(audioQueue))
            Effect.runSync(Queue.shutdown(transcriptQueue))
            Effect.runSync(Queue.shutdown(userTranscriptQueue))
            Effect.runSync(Queue.shutdown(toolCallQueue))
            Effect.runSync(Queue.shutdown(eventQueue))
          })

          return Effect.sync(() => {
            ws.close()
          })
        })

        const send = (audio: Buffer): Effect.Effect<void> =>
          Effect.sync(() => {
            const ws = holder.ws
            if (ws && ws.readyState === WebSocket.OPEN) {
              const base64Audio = audio.toString("base64")
              const msg = { type: "input_audio_buffer.append", audio: base64Audio }
              ws.send(JSON.stringify(msg))
            }
          })

        const sendText = (text: string): Effect.Effect<void> =>
          Effect.sync(() => {
            const ws = holder.ws
            if (ws && ws.readyState === WebSocket.OPEN) {
              const itemMessage = new ConversationItemCreateMessage({
                item: {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text }]
                }
              })
              const encodedItem = Schema.encodeSync(ConversationItemCreateMessage)(itemMessage)
              ws.send(JSON.stringify({ type: "conversation.item.create", ...encodedItem }))

              const responseMessage = new ResponseCreateMessage({})
              const encodedResponse = Schema.encodeSync(ResponseCreateMessage)(responseMessage)
              ws.send(JSON.stringify({ type: "response.create", ...encodedResponse }))
            }
          })

        const sendToolResult = (callId: string, result: unknown): Effect.Effect<void> =>
          Effect.sync(() => {
            const ws = holder.ws
            if (ws && ws.readyState === WebSocket.OPEN) {
              // Send function call output
              const outputMsg = {
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: callId,
                  output: JSON.stringify(result)
                }
              }
              ws.send(JSON.stringify(outputMsg))

              // Trigger response generation
              const responseMessage = new ResponseCreateMessage({})
              const encodedResponse = Schema.encodeSync(ResponseCreateMessage)(responseMessage)
              ws.send(JSON.stringify({ type: "response.create", ...encodedResponse }))
            }
          })

        const close = Effect.sync(() => {
          const ws = holder.ws
          if (ws) {
            ws.close()
            holder.ws = null
          }
        })

        const waitForReady = Queue.take(readyQueue)

        return {
          send,
          sendText,
          sendToolResult,
          audioOutput: Stream.fromQueue(audioQueue),
          transcripts: Stream.fromQueue(transcriptQueue),
          userTranscripts: Stream.fromQueue(userTranscriptQueue),
          toolCalls: Stream.fromQueue(toolCallQueue),
          events: Stream.fromQueue(eventQueue),
          close,
          waitForReady
        }
      })
  })
}) {}
