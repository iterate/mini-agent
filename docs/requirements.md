# Requirements

Actor-based LLM request handling using Effect. Philosophy: **"Agent events are all you need"**

See [architecture.md](./architecture.md) for conceptual model and [design.ts](./design.ts) for types.

## MVP Scope

### Core Capabilities

- **Fire-and-forget input**: `addEvent` persists immediately, returns void
- **Live event stream**: Subscribers receive events after subscription (no replay)
- **Immediate persistence**: Events persist before processing
- **Single LLM per turn**: Primary with retry, fallback on exhaustion

### Interruption

New triggering event during agent turn:
1. Cancel in-flight LLM request
2. Emit AgentTurnInterruptedEvent
3. Start new turn with updated context

### Debouncing

Wait 100ms after last triggering event before starting agent turn.

### Session Lifecycle

- SessionStartedEvent on actor creation
- SessionEndedEvent on scope close
- Both persisted for audit

### Event Categories

All events have: id, timestamp, agentName, parentEventId, triggersAgentTurn

| Category | Events |
|----------|--------|
| Content | SystemPrompt, UserMessage, AssistantMessage, FileAttachment, TextDelta |
| Config | SetLlmConfig, SetTimeout |
| Lifecycle | SessionStarted, SessionEnded, AgentTurnStarted/Completed/Interrupted/Failed |

## Non-Functional

- **Testability**: InMemory EventStore, mock services via Layer.succeed
- **Observability**: Lifecycle events for tracing, structured logging
- **Constraints**: Bun runtime, @effect/platform for I/O, @effect/ai for LLM

## Future Scope

Documented for awareness, not MVP:

- **Event-driven extensions**: SetRetryConfig, DefineTool, DefineWorkflow, SetMemoryConfig
- **Parallel LLM**: Racing providers, A/B testing prompts
- **Advanced reducers**: Truncating, summarizing
- **Agent forking**: Branch via parentEventId for alternate paths
- **Context bricking**: Switch to fresh context when current is poisoned
- **Distribution**: @effect/cluster Entity + Sharding
