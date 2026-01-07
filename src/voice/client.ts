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
  InputAudioBufferAppendMessage,
  InputAudioBufferSpeechStartedEvent,
  InputAudioTranscriptionCompletedEvent,
  ResponseCreateMessage,
  ResponseDoneEvent,
  ResponseOutputAudioDeltaEvent,
  ResponseOutputAudioTranscriptDeltaEvent,
  SessionUpdatedEvent,
  SessionUpdateMessage,
  type VoiceName,
  type VoiceSessionConfig
} from "./domain.ts"

export interface GrokVoiceConnection {
  readonly send: (audio: Buffer) => Effect.Effect<void>
  readonly sendText: (text: string) => Effect.Effect<void>
  readonly audioOutput: Stream.Stream<Buffer>
  readonly transcripts: Stream.Stream<string>
  readonly userTranscripts: Stream.Stream<string>
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
        const sampleRate = config.sampleRate ?? DEFAULT_SAMPLE_RATE
        const instructions = config.instructions ?? DEFAULT_INSTRUCTIONS

        yield* Effect.log(`Connecting to ${apiUrl}`)

        const audioQueue = yield* Queue.unbounded<Buffer>()
        const transcriptQueue = yield* Queue.unbounded<string>()
        const userTranscriptQueue = yield* Queue.unbounded<string>()
        const eventQueue = yield* Queue.unbounded<unknown>()
        const readyQueue = yield* Queue.bounded<void>(1)

        const holder: WsHolder = { ws: null }
        let isConfigured = false

        const sendSessionConfig = (socket: WebSocket) => {
          const sessionConfig = new SessionUpdateMessage({
            session: {
              instructions,
              voice: voice as VoiceName,
              audio: {
                input: { format: { type: "audio/pcm", rate: sampleRate } },
                output: { format: { type: "audio/pcm", rate: sampleRate } }
              },
              turn_detection: { type: "server_vad" }
            }
          })

          const encoded = Schema.encodeSync(SessionUpdateMessage)(sessionConfig)
          socket.send(JSON.stringify({ type: "session.update", ...encoded }))
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
              const message = new InputAudioBufferAppendMessage({ audio: base64Audio })
              const encoded = Schema.encodeSync(InputAudioBufferAppendMessage)(message)
              ws.send(JSON.stringify({ type: "input_audio_buffer.append", ...encoded }))
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
          audioOutput: Stream.fromQueue(audioQueue),
          transcripts: Stream.fromQueue(transcriptQueue),
          userTranscripts: Stream.fromQueue(userTranscriptQueue),
          events: Stream.fromQueue(eventQueue),
          close,
          waitForReady
        }
      })
  })
}) {}
