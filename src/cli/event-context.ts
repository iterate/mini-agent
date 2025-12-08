import { type AgentName, type ContextEvent, type ContextName } from "../domain.ts"

export interface EventContextMetadata {
  readonly contextName: ContextName
  readonly nextEventNumber: number
}

const DEFAULT_CONTEXT_SUFFIX = "-v1"

export const deriveContextMetadata = (
  agentName: AgentName,
  events: ReadonlyArray<ContextEvent>
): EventContextMetadata => {
  const fallbackContext = `${agentName}${DEFAULT_CONTEXT_SUFFIX}` as ContextName
  if (events.length === 0) {
    return { contextName: fallbackContext, nextEventNumber: 0 }
  }

  const lastEvent = events[events.length - 1]!
  const segments = lastEvent.id.split(":")
  const counterRaw = segments.pop() ?? "0"
  const contextSegment = segments.join(":")
  const parsedCounter = Number.parseInt(counterRaw, 10)

  return {
    contextName: (contextSegment || fallbackContext) as ContextName,
    nextEventNumber: Number.isNaN(parsedCounter) ? 0 : parsedCounter + 1
  }
}
