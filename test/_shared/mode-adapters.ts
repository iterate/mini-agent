/**
 * Mode Adapters - Unified interface for testing across server/CLI/pipe modes.
 *
 * Each adapter implements the same interface, enabling behavior tests to run
 * identically across all interaction modes.
 */
import type { Effect, Stream } from "effect"
import type { ContextEvent } from "../../src/domain.ts"

export interface ModeAdapter {
  /** Send a message and collect all response events */
  sendMessage: (
    contextName: string,
    content: string
  ) => Effect.Effect<ReadonlyArray<ContextEvent>, Error>

  /** Stream events as they arrive (for streaming behavior tests) */
  streamEvents: (
    contextName: string,
    content: string
  ) => Stream.Stream<ContextEvent, Error>

  /** Clean up resources */
  cleanup: Effect.Effect<void>
}

export interface ModeAdapterConfig {
  readonly baseUrl?: string
  readonly cwd?: string
  readonly env?: Record<string, string>
}

/** Extract assistant response text from events */
export const extractAssistantText = (events: ReadonlyArray<ContextEvent>): string =>
  events
    .filter((e): e is typeof e & { _tag: "AssistantMessageEvent" } => e._tag === "AssistantMessageEvent")
    .map((e) => e.content)
    .join("")

/** Extract text deltas for streaming verification */
export const extractDeltas = (events: ReadonlyArray<ContextEvent>): ReadonlyArray<string> =>
  events
    .filter((e): e is typeof e & { _tag: "TextDeltaEvent" } => e._tag === "TextDeltaEvent")
    .map((e) => e.delta)

/** Check if events include expected lifecycle events */
export const hasLifecycleEvents = (events: ReadonlyArray<ContextEvent>) => ({
  hasSessionStarted: events.some((e) => e._tag === "SessionStartedEvent"),
  hasTurnStarted: events.some((e) => e._tag === "AgentTurnStartedEvent"),
  hasTurnCompleted: events.some((e) => e._tag === "AgentTurnCompletedEvent"),
  hasAssistantMessage: events.some((e) => e._tag === "AssistantMessageEvent")
})

/** Verify blockchain chain integrity */
export const verifyChain = (events: ReadonlyArray<ContextEvent>): boolean => {
  if (events.length === 0) return true

  // First event should have no parent
  const first = events[0]!
  if (first.parentEventId._tag !== "None") return false

  // Each subsequent event should point to previous
  for (let i = 1; i < events.length; i++) {
    const current = events[i]!
    const previous = events[i - 1]!
    if (current.parentEventId._tag !== "Some") return false
    if (current.parentEventId.value !== previous.id) return false
  }

  return true
}
