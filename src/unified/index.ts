/**
 * Unified LLM Abstraction
 *
 * Transport-agnostic conversation interface for text and voice LLMs.
 */

// Core domain types
export {
  // Context helpers
  addAssistantMessage,
  addToolResult,
  addUserMessage,
  // Event types
  AudioComplete,
  AudioDelta,
  AudioInput,
  type ConversationContext,
  ConversationError,
  ConversationEvent,
  ConversationInput,
  emptyContext,
  // Transport types
  type LlmConnection,
  LlmTransport,
  // Session
  makeUnifiedSession,
  type Message,
  setSystemPrompt,
  type StatefulConnection,
  type StatelessConnection,
  TextComplete,
  TextDelta,
  TextInput,
  ToolCall,
  ToolResponseInput,
  ToolResult,
  TurnComplete,
  UnifiedSession,
  type UnifiedSessionConfig,
  UserTranscript
} from "./domain.ts"

// Transport implementations
export { HttpTransportLive } from "./http-transport.ts"
export { WsTransportLive } from "./ws-transport.ts"
