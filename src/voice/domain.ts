/**
 * Voice Domain Types
 *
 * Types for the Grok realtime voice API integration.
 */
import { Schema } from "effect"

export const VoiceName = Schema.Literal("ara", "rex", "sal", "eve", "leo")
export type VoiceName = typeof VoiceName.Type

export const AudioFormat = Schema.Struct({
  type: Schema.Literal("audio/pcm", "audio/pcmu"),
  rate: Schema.optional(Schema.Number)
})
export type AudioFormat = typeof AudioFormat.Type

export const TurnDetection = Schema.Struct({
  type: Schema.Literal("server_vad")
})

export const SessionConfig = Schema.Struct({
  instructions: Schema.optional(Schema.String),
  voice: Schema.optional(VoiceName),
  audio: Schema.optional(Schema.Struct({
    input: Schema.optional(Schema.Struct({ format: AudioFormat })),
    output: Schema.optional(Schema.Struct({ format: AudioFormat }))
  })),
  turn_detection: Schema.optional(TurnDetection)
})
export type SessionConfig = typeof SessionConfig.Type

export class SessionUpdateMessage extends Schema.TaggedClass<SessionUpdateMessage>()("session.update", {
  session: SessionConfig
}) {}

export class InputAudioBufferAppendMessage extends Schema.TaggedClass<InputAudioBufferAppendMessage>()(
  "input_audio_buffer.append",
  { audio: Schema.String }
) {}

export class InputAudioBufferCommitMessage extends Schema.TaggedClass<InputAudioBufferCommitMessage>()(
  "input_audio_buffer.commit",
  {}
) {}

export class ResponseCreateMessage extends Schema.TaggedClass<ResponseCreateMessage>()("response.create", {}) {}

export const ConversationItemContent = Schema.Struct({
  type: Schema.Literal("input_text"),
  text: Schema.String
})

export class ConversationItemCreateMessage extends Schema.TaggedClass<ConversationItemCreateMessage>()(
  "conversation.item.create",
  {
    item: Schema.Struct({
      type: Schema.Literal("message"),
      role: Schema.Literal("user", "assistant"),
      content: Schema.Array(ConversationItemContent)
    })
  }
) {}

export const OutboundMessage = Schema.Union(
  SessionUpdateMessage,
  InputAudioBufferAppendMessage,
  InputAudioBufferCommitMessage,
  ResponseCreateMessage,
  ConversationItemCreateMessage
)
export type OutboundMessage = typeof OutboundMessage.Type

export const ConversationCreatedEvent = Schema.Struct({
  type: Schema.Literal("conversation.created"),
  conversation: Schema.optional(Schema.Struct({
    id: Schema.optional(Schema.String)
  }))
})
export type ConversationCreatedEvent = typeof ConversationCreatedEvent.Type

export const SessionUpdatedEvent = Schema.Struct({
  type: Schema.Literal("session.updated"),
  session: Schema.optional(Schema.Unknown)
})
export type SessionUpdatedEvent = typeof SessionUpdatedEvent.Type

export const ResponseCreatedEvent = Schema.Struct({
  type: Schema.Literal("response.created")
})
export type ResponseCreatedEvent = typeof ResponseCreatedEvent.Type

export const ResponseDoneEvent = Schema.Struct({
  type: Schema.Literal("response.done")
})
export type ResponseDoneEvent = typeof ResponseDoneEvent.Type

export const ResponseOutputAudioDeltaEvent = Schema.Struct({
  type: Schema.Literal("response.output_audio.delta"),
  delta: Schema.String
})
export type ResponseOutputAudioDeltaEvent = typeof ResponseOutputAudioDeltaEvent.Type

export const ResponseOutputAudioTranscriptDeltaEvent = Schema.Struct({
  type: Schema.Literal("response.output_audio_transcript.delta"),
  delta: Schema.String
})
export type ResponseOutputAudioTranscriptDeltaEvent = typeof ResponseOutputAudioTranscriptDeltaEvent.Type

export const InputAudioTranscriptionCompletedEvent = Schema.Struct({
  type: Schema.Literal("conversation.item.input_audio_transcription.completed"),
  transcript: Schema.optional(Schema.String)
})
export type InputAudioTranscriptionCompletedEvent = typeof InputAudioTranscriptionCompletedEvent.Type

export const InputAudioBufferSpeechStartedEvent = Schema.Struct({
  type: Schema.Literal("input_audio_buffer.speech_started")
})
export type InputAudioBufferSpeechStartedEvent = typeof InputAudioBufferSpeechStartedEvent.Type

export const InputAudioBufferSpeechStoppedEvent = Schema.Struct({
  type: Schema.Literal("input_audio_buffer.speech_stopped")
})
export type InputAudioBufferSpeechStoppedEvent = typeof InputAudioBufferSpeechStoppedEvent.Type

export const ErrorEvent = Schema.Struct({
  type: Schema.Literal("error"),
  error: Schema.optional(Schema.Struct({
    message: Schema.optional(Schema.String),
    type: Schema.optional(Schema.String),
    code: Schema.optional(Schema.String)
  }))
})
export type ErrorEvent = typeof ErrorEvent.Type

export const InboundEvent = Schema.Union(
  ConversationCreatedEvent,
  SessionUpdatedEvent,
  ResponseCreatedEvent,
  ResponseDoneEvent,
  ResponseOutputAudioDeltaEvent,
  ResponseOutputAudioTranscriptDeltaEvent,
  InputAudioTranscriptionCompletedEvent,
  InputAudioBufferSpeechStartedEvent,
  InputAudioBufferSpeechStoppedEvent,
  ErrorEvent
)
export type InboundEvent = typeof InboundEvent.Type

export const VoiceSessionConfig = Schema.Struct({
  apiKey: Schema.String,
  apiUrl: Schema.optional(Schema.String),
  voice: Schema.optional(VoiceName),
  sampleRate: Schema.optional(Schema.Number),
  instructions: Schema.optional(Schema.String)
})
export type VoiceSessionConfig = typeof VoiceSessionConfig.Type

export const DEFAULT_API_URL = "wss://api.x.ai/v1/realtime"
export const DEFAULT_SAMPLE_RATE = 24000
export const DEFAULT_VOICE: VoiceName = "ara"
export const DEFAULT_INSTRUCTIONS =
  "You are a helpful voice assistant. Keep your responses conversational and concise since they will be spoken aloud."
