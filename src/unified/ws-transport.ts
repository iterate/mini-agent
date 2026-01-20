/**
 * WebSocket Transport for Unified Session
 *
 * Wraps GrokVoiceClient as a stateful transport for voice conversations.
 */
import { Effect, Layer, Option, Stream } from "effect"

import { GrokVoiceClient, type GrokVoiceConnection } from "../voice/client.ts"
import type { ToolDefinition as VoiceToolDefinition, VoiceSessionConfig } from "../voice/domain.ts"
import {
  AudioDelta,
  ConversationError,
  type ConversationEvent,
  LlmTransport,
  RawEvent,
  ResponseStarted,
  SessionReady,
  SpeechStarted,
  SpeechStopped,
  type StatefulConnection,
  TextDelta,
  ToolCall,
  TurnComplete,
  UserTranscript
} from "./domain.ts"

interface WsTransportConfig {
  readonly apiKey: string
  readonly apiUrl?: string
  readonly voice?: "ara" | "rex" | "sal" | "eve" | "leo"
  readonly instructions?: string
  readonly tools?: ReadonlyArray<VoiceToolDefinition>
}

/**
 * Translate voice connection events to unified ConversationEvents
 */
const translateVoiceEvents = (
  conn: GrokVoiceConnection
): Stream.Stream<ConversationEvent, ConversationError> => {
  // Merge all event streams into a single stream of ConversationEvents
  const textEvents: Stream.Stream<ConversationEvent, never> = conn.transcripts.pipe(
    Stream.map((delta): ConversationEvent => new TextDelta({ delta }))
  )

  const audioEvents: Stream.Stream<ConversationEvent, never> = conn.audioOutput.pipe(
    Stream.map((chunk): ConversationEvent => new AudioDelta({ chunk }))
  )

  const userTranscriptEvents: Stream.Stream<ConversationEvent, never> = conn.userTranscripts.pipe(
    Stream.map((transcript): ConversationEvent => new UserTranscript({ transcript }))
  )

  const toolCallEvents: Stream.Stream<ConversationEvent, never> = conn.toolCalls.pipe(
    Stream.map((tc): ConversationEvent => new ToolCall({ id: tc.id, name: tc.name, params: tc.params }))
  )

  // Translate all raw events to typed ConversationEvents
  const rawEventStream: Stream.Stream<ConversationEvent, never> = conn.events.pipe(
    Stream.filter(
      (event): event is { type: string; [key: string]: unknown } =>
        typeof event === "object" && event !== null && "type" in event
    ),
    Stream.map((event): ConversationEvent => {
      switch (event.type) {
        case "session.updated":
          return new SessionReady({})
        case "input_audio_buffer.speech_started":
          return new SpeechStarted({})
        case "input_audio_buffer.speech_stopped":
          return new SpeechStopped({})
        case "response.created":
          return new ResponseStarted({})
        case "response.done":
          return new TurnComplete({})
        default:
          // Capture all other events as RawEvent
          return new RawEvent({ type: event.type, data: event })
      }
    })
  )

  return Stream.mergeAll([textEvents, audioEvents, userTranscriptEvents, toolCallEvents, rawEventStream], {
    concurrency: "unbounded"
  }).pipe(
    Stream.catchAll((error: unknown) =>
      Stream.succeed<ConversationEvent>(
        new ConversationError({
          message: error instanceof Error ? error.message : String(error),
          code: Option.some("WS_ERROR")
        })
      )
    )
  )
}

/**
 * Create WebSocket transport layer
 */
export const WsTransportLive = (
  config: WsTransportConfig
): Layer.Layer<LlmTransport, never, GrokVoiceClient> =>
  Layer.effect(
    LlmTransport,
    Effect.gen(function*() {
      const voiceClient = yield* GrokVoiceClient

      return {
        connect: Effect.gen(function*() {
          const sessionConfig: VoiceSessionConfig = {
            apiKey: config.apiKey,
            apiUrl: config.apiUrl,
            voice: config.voice,
            instructions: config.instructions,
            tools: config.tools
          }

          const conn = yield* voiceClient.connect(sessionConfig).pipe(
            Effect.mapError(
              (error) =>
                new ConversationError({
                  message: error.message,
                  code: Option.some("CONNECTION_ERROR")
                })
            )
          )

          // Wait for connection to be ready
          yield* conn.waitForReady.pipe(
            Effect.mapError(
              () =>
                new ConversationError({
                  message: "Connection timeout waiting for ready",
                  code: Option.some("TIMEOUT")
                })
            )
          )

          const statefulConn: StatefulConnection = {
            _tag: "stateful",

            sendText: (text: string) =>
              conn.sendText(text).pipe(
                Effect.mapError(
                  () =>
                    new ConversationError({
                      message: "Failed to send text",
                      code: Option.some("SEND_ERROR")
                    })
                )
              ),

            sendAudio: (chunk: Buffer) =>
              conn.send(chunk).pipe(
                Effect.mapError(
                  () =>
                    new ConversationError({
                      message: "Failed to send audio",
                      code: Option.some("SEND_ERROR")
                    })
                )
              ),

            sendToolResult: (id: string, result: unknown) =>
              conn.sendToolResult(id, result).pipe(
                Effect.mapError(
                  () =>
                    new ConversationError({
                      message: "Failed to send tool result",
                      code: Option.some("SEND_ERROR")
                    })
                )
              ),

            events: translateVoiceEvents(conn),

            close: conn.close
          }

          return statefulConn
        })
      }
    })
  )
