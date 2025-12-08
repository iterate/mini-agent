/**
 * Mini-Agent Actor Architecture
 *
 * Event-sourced actor system for LLM interactions.
 * Philosophy: "Agent events are all you need"
 *
 * @module
 */

// Domain types and events
export {
  // Error types
  AgentError,
  // Branded types
  AgentName,
  AgentNotFoundError,
  // Event types
  AgentTurnCompletedEvent,
  AgentTurnFailedEvent,
  AgentTurnInterruptedEvent,
  AgentTurnNumber,
  AgentTurnStartedEvent,
  ApiFormat,
  AssistantMessageEvent,
  ContextEvent,
  ContextLoadError,
  ContextName,
  ContextSaveError,
  // Utilities
  EventId,
  InterruptReason,
  // Config types
  LlmConfig,
  makeBaseEventFields,
  makeEventId,
  // Service types
  type MiniAgent,
  MiniAgentTurn,
  // State types
  type ReducedContext,
  ReducedContext as ReducedContextHelpers,
  ReducerError,
  SessionEndedEvent,
  SessionStartedEvent,
  SetLlmConfigEvent,
  SystemPromptEvent,
  TextDeltaEvent,
  UserMessageEvent
} from "./domain.ts"

// Services
export { AgentRegistry } from "./agent-registry.ts"
export { AgentService, AgentServiceRemote, AgentEventInput } from "./agent-service.ts"
export { EventReducer } from "./event-reducer.ts"
export { EventStore } from "./event-store.ts"

// Agent factory
export { makeMiniAgent } from "./mini-agent.ts"

// Production layers
export { EventStoreFileSystem } from "./event-store-fs.ts"
export { LlmTurnLive } from "./llm-turn.ts"
