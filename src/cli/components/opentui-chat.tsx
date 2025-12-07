/**
 * OpenTUI Chat Component
 *
 * Architecture:
 * - ContextEvent[] dispatched via controller.addEvent()
 * - feedReducer folds each event into FeedItem[] (accumulated state)
 * - Feed component renders feedItems (pure render, knows nothing about events)
 *
 * Key reducer transitions:
 * - TextDeltaEvent: create/append to InProgressAssistant
 * - AssistantMessageEvent: remove InProgressAssistant, add AssistantMessage
 * - AgentTurnInterruptedEvent: remove InProgressAssistant, add LLMInterruption
 */
import { createCliRenderer, TextAttributes } from "@opentui/core"
import { createRoot } from "@opentui/react/renderer"
import { DateTime, Option, Schema } from "effect"
import { memo, useCallback, useMemo, useReducer, useRef, useState } from "react"
import type { ContextEvent } from "../../domain.ts"

/** Format timestamp as human-readable "HH:MM:SS" or "Dec 7, HH:MM" if older than today */
function formatTimestamp(timestamp: DateTime.DateTime): string {
  const date = DateTime.toDateUtc(timestamp)
  const now = new Date()
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  if (isToday) {
    return date.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    })
  }

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  })
}

/** User's message in the conversation */
class UserMessageItem extends Schema.TaggedClass<UserMessageItem>()("UserMessageItem", {
  id: Schema.String,
  content: Schema.String,
  isHistory: Schema.Boolean,
  timestamp: Schema.DateTimeUtc
}) {}

/** Streaming response in progress - accumulates TextDelta events */
class InProgressAssistantItem extends Schema.TaggedClass<InProgressAssistantItem>()("InProgressAssistantItem", {
  id: Schema.String,
  text: Schema.String,
  timestamp: Schema.DateTimeUtc
}) {}

/** Completed assistant response */
class AssistantMessageItem extends Schema.TaggedClass<AssistantMessageItem>()("AssistantMessageItem", {
  id: Schema.String,
  content: Schema.String,
  isHistory: Schema.Boolean,
  timestamp: Schema.DateTimeUtc
}) {}

/** Response that was interrupted (user cancel, new message, or timeout) */
class LLMInterruptionItem extends Schema.TaggedClass<LLMInterruptionItem>()("LLMInterruptionItem", {
  id: Schema.String,
  partialResponse: Schema.String,
  reason: Schema.String,
  isHistory: Schema.Boolean,
  timestamp: Schema.DateTimeUtc
}) {}

/** Fallback for unknown event types - displays muted warning */
class UnknownEventItem extends Schema.TaggedClass<UnknownEventItem>()("UnknownEventItem", {
  id: Schema.String,
  eventTag: Schema.String,
  isHistory: Schema.Boolean,
  timestamp: Schema.DateTimeUtc
}) {}

const FeedItem = Schema.Union(
  UserMessageItem,
  InProgressAssistantItem,
  AssistantMessageItem,
  LLMInterruptionItem,
  UnknownEventItem
)
type FeedItem = typeof FeedItem.Type

type FeedAction = { event: ContextEvent; isHistory: boolean }

/**
 * Folds a context event into accumulated feed items.
 * Called exactly once per event via useReducer dispatch.
 */
function feedReducer(items: Array<FeedItem>, action: FeedAction): Array<FeedItem> {
  const { event, isHistory } = action

  switch (event._tag) {
    case "TextDeltaEvent": {
      const last = items.at(-1)
      if (last?._tag === "InProgressAssistantItem") {
        return [
          ...items.slice(0, -1),
          new InProgressAssistantItem({ ...last, text: last.text + event.delta })
        ]
      }
      return [
        ...items,
        new InProgressAssistantItem({
          id: crypto.randomUUID(),
          text: event.delta,
          timestamp: event.timestamp
        })
      ]
    }

    case "AssistantMessageEvent": {
      const filtered = items.filter((i) => i._tag !== "InProgressAssistantItem")
      return [
        ...filtered,
        new AssistantMessageItem({
          id: crypto.randomUUID(),
          content: event.content,
          isHistory,
          timestamp: event.timestamp
        })
      ]
    }

    case "AgentTurnInterruptedEvent": {
      const filtered = items.filter((i) => i._tag !== "InProgressAssistantItem")
      const partialResponse = Option.isSome(event.partialResponse)
        ? event.partialResponse.value
        : ""
      return [
        ...filtered,
        new LLMInterruptionItem({
          id: crypto.randomUUID(),
          partialResponse,
          reason: event.reason,
          isHistory,
          timestamp: event.timestamp
        })
      ]
    }

    case "UserMessageEvent":
      return [
        ...items,
        new UserMessageItem({
          id: crypto.randomUUID(),
          content: event.content,
          isHistory,
          timestamp: event.timestamp
        })
      ]

    // Lifecycle events - don't display
    case "SystemPromptEvent":
    case "SetLlmConfigEvent":
    case "SessionStartedEvent":
    case "SessionEndedEvent":
    case "AgentTurnStartedEvent":
    case "AgentTurnCompletedEvent":
    case "AgentTurnFailedEvent":
      return items

    default:
      return [
        ...items,
        new UnknownEventItem({
          id: crypto.randomUUID(),
          eventTag: (event as { _tag: string })._tag,
          isHistory,
          timestamp: (event as { timestamp: DateTime.Utc }).timestamp
        })
      ]
  }
}

const colors = {
  cyan: "#00FFFF",
  green: "#00FF00",
  white: "#FFFFFF",
  red: "#FF5555",
  yellow: "#FFFF00",
  dimCyan: "#5F8787",
  dimGreen: "#5F875F",
  dim: "#666666",
  dimRed: "#8B4040",
  separator: "#444444",
  placeholder: "#555555",
  userBg: "#1a2a3a",
  userBgHistory: "#141e28",
  assistantBg: "#1a2a1a",
  assistantBgHistory: "#141e14"
}

const UserMessageRenderer = memo<{ item: UserMessageItem }>(({ item }) => {
  const labelColor = item.isHistory ? colors.dimCyan : colors.cyan
  const textColor = item.isHistory ? colors.dim : colors.white
  const bgColor = item.isHistory ? colors.userBgHistory : colors.userBg
  const timeStr = formatTimestamp(item.timestamp)

  return (
    <box flexDirection="column" marginBottom={1} backgroundColor={bgColor} padding={1}>
      <box flexDirection="row" width="100%">
        <text fg={labelColor} attributes={item.isHistory ? TextAttributes.NONE : TextAttributes.BOLD}>
          You:
        </text>
        <box flexGrow={1} />
        <text fg={colors.dim}>{timeStr}</text>
      </box>
      <text fg={textColor}>{item.content}</text>
    </box>
  )
})

const InProgressAssistantRenderer = memo<{ item: InProgressAssistantItem }>(({ item }) => {
  const timeStr = formatTimestamp(item.timestamp)

  if (!item.text) {
    return (
      <box flexDirection="column" marginBottom={1} backgroundColor={colors.assistantBg} padding={1}>
        <box flexDirection="row" width="100%">
          <text fg={colors.green} attributes={TextAttributes.BOLD}>
            Assistant:
          </text>
          <box flexGrow={1} />
          <text fg={colors.dim}>{timeStr}</text>
        </box>
        <text fg={colors.dim}>Thinking...</text>
      </box>
    )
  }

  return (
    <box flexDirection="column" marginBottom={1} backgroundColor={colors.assistantBg} padding={1}>
      <box flexDirection="row" width="100%">
        <text fg={colors.green} attributes={TextAttributes.BOLD}>
          Assistant:
        </text>
        <box flexGrow={1} />
        <text fg={colors.dim}>{timeStr}</text>
      </box>
      <text fg={colors.white}>
        {item.text}
        <span fg={colors.cyan}>▌</span>
      </text>
    </box>
  )
})

const AssistantMessageRenderer = memo<{ item: AssistantMessageItem }>(({ item }) => {
  const labelColor = item.isHistory ? colors.dimGreen : colors.green
  const textColor = item.isHistory ? colors.dim : colors.white
  const bgColor = item.isHistory ? colors.assistantBgHistory : colors.assistantBg
  const timeStr = formatTimestamp(item.timestamp)

  return (
    <box flexDirection="column" marginBottom={1} backgroundColor={bgColor} padding={1}>
      <box flexDirection="row" width="100%">
        <text fg={labelColor} attributes={item.isHistory ? TextAttributes.NONE : TextAttributes.BOLD}>
          Assistant:
        </text>
        <box flexGrow={1} />
        <text fg={colors.dim}>{timeStr}</text>
      </box>
      <text fg={textColor}>{item.content}</text>
    </box>
  )
})

const LLMInterruptionRenderer = memo<{ item: LLMInterruptionItem }>(({ item }) => {
  const labelColor = item.isHistory ? colors.dimGreen : colors.green
  const textColor = item.isHistory ? colors.dim : colors.white
  const interruptColor = item.isHistory ? colors.dimRed : colors.red
  const bgColor = item.isHistory ? colors.assistantBgHistory : colors.assistantBg
  const timeStr = formatTimestamp(item.timestamp)

  return (
    <box flexDirection="column" marginTop={1} marginBottom={1} backgroundColor={bgColor} padding={1}>
      <box flexDirection="row" width="100%">
        <text fg={labelColor} attributes={item.isHistory ? TextAttributes.NONE : TextAttributes.BOLD}>
          Assistant:
        </text>
        <box flexGrow={1} />
        <text fg={colors.dim}>{timeStr}</text>
      </box>
      <text fg={textColor}>{item.partialResponse}</text>
      <text fg={interruptColor}>— interrupted —</text>
    </box>
  )
})

const UnknownEventRenderer = memo<{ item: UnknownEventItem }>(({ item }) => {
  const timeStr = formatTimestamp(item.timestamp)

  return (
    <box flexDirection="column" marginBottom={1}>
      <box flexDirection="row" width="100%">
        <text fg={colors.dim}>No renderer for {item.eventTag}</text>
        <box flexGrow={1} />
        <text fg={colors.dim}>{timeStr}</text>
      </box>
    </box>
  )
})

const FeedItemRenderer = memo<{ item: FeedItem }>(({ item }) => {
  switch (item._tag) {
    case "UserMessageItem":
      return <UserMessageRenderer item={item} />
    case "InProgressAssistantItem":
      return <InProgressAssistantRenderer item={item} />
    case "AssistantMessageItem":
      return <AssistantMessageRenderer item={item} />
    case "LLMInterruptionItem":
      return <LLMInterruptionRenderer item={item} />
    case "UnknownEventItem":
      return <UnknownEventRenderer item={item} />
  }
})

interface FeedProps {
  feedItems: Array<FeedItem>
  hasHistory: boolean
}

const Feed = memo<FeedProps>(({ feedItems, hasHistory }) => {
  return (
    <box flexDirection="column" width="100%">
      {hasHistory && (
        <box flexDirection="column" marginBottom={1}>
          <text fg={colors.dim}>{"─".repeat(50)}</text>
          <text fg={colors.dim}>Previous conversation:</text>
          <text></text>
        </box>
      )}

      {feedItems.map((item) => <FeedItemRenderer key={item.id} item={item} />)}
    </box>
  )
})

export interface ChatCallbacks {
  onSubmit: (text: string) => void
  onExit: () => void
}

export interface ChatController {
  addEvent: (event: ContextEvent) => void
  cleanup: () => void
}

interface ChatAppProps {
  contextName: string
  initialEvents: ReadonlyArray<ContextEvent>
  callbacks: ChatCallbacks
  controllerRef: React.MutableRefObject<ChatController | null>
}

function ChatApp({ callbacks, contextName, controllerRef, initialEvents }: ChatAppProps) {
  // Derive initial feed items from history events (runs once on mount)
  const initialFeedItems = useMemo(
    () =>
      initialEvents.reduce<Array<FeedItem>>(
        (items, event) => feedReducer(items, { event, isHistory: true }),
        []
      ),
    []
  )

  const [feedItems, dispatch] = useReducer(feedReducer, initialFeedItems)
  const [inputValue, setInputValue] = useState("")
  const dispatchRef = useRef(dispatch)
  dispatchRef.current = dispatch

  // Check if we have any history (for separator display)
  const hasHistory = initialFeedItems.some(
    (item) =>
      item._tag === "UserMessageItem" ||
      item._tag === "AssistantMessageItem" ||
      item._tag === "LLMInterruptionItem"
  )

  // Check if currently streaming (for input placeholder)
  const isStreaming = feedItems.some((item) => item._tag === "InProgressAssistantItem")
  const isStreamingRef = useRef(false)
  isStreamingRef.current = isStreaming

  // Set up controller synchronously during first render
  if (!controllerRef.current) {
    controllerRef.current = {
      addEvent(event: ContextEvent) {
        dispatchRef.current({ event, isHistory: false })
      },
      cleanup() {
        // handled by runner
      }
    }
  }

  const handleInput = useCallback((value: string) => {
    setInputValue(value)
  }, [])

  const handleSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim()
      if (trimmed) {
        setInputValue("")
        callbacks.onSubmit(trimmed)
      } else if (isStreamingRef.current) {
        callbacks.onSubmit("")
      }
    },
    [callbacks]
  )

  return (
    <box width="100%" height="100%" flexDirection="column">
      <scrollbox
        flexGrow={1}
        width="100%"
        stickyScroll={true}
        stickyStart="bottom"
      >
        <Feed feedItems={feedItems} hasHistory={hasHistory} />
      </scrollbox>

      <box height={1} width="100%" flexDirection="row">
        <text fg={colors.cyan} attributes={TextAttributes.BOLD}>
          {">"}
          {" "}
        </text>
        <input
          flexGrow={1}
          value={inputValue}
          placeholder={isStreaming ? "Hit return to interrupt..." : "Type your message..."}
          focused={true}
          onInput={handleInput}
          onSubmit={handleSubmit}
        />
      </box>

      <box height={1} width="100%" flexDirection="row">
        <box flexGrow={1} />
        <text>
          <span fg={colors.yellow}>Agent: </span>
          <span fg={colors.dim}>{contextName}</span>
          <span fg={colors.dim}> · </span>
          <span fg={colors.yellow}>{isStreaming ? "Return to interrupt" : "Ctrl+C to exit"}</span>
        </text>
      </box>
    </box>
  )
}

export async function runOpenTUIChat(
  contextName: string,
  initialEvents: ReadonlyArray<ContextEvent>,
  callbacks: ChatCallbacks
): Promise<ChatController> {
  let exitSignaled = false
  const signalExit = () => {
    if (!exitSignaled) {
      exitSignaled = true
      callbacks.onExit()
    }
  }

  const onSigint = () => signalExit()
  const onSigterm = () => signalExit()
  process.once("SIGINT", onSigint)
  process.once("SIGTERM", onSigterm)

  const renderer = await createCliRenderer({
    exitOnCtrlC: true
  })
  const root = createRoot(renderer)
  const controllerRef: { current: ChatController | null } = { current: null }

  const pollInterval = setInterval(() => {
    if (!process.stdin.isRaw) {
      clearInterval(pollInterval)
      signalExit()
    }
  }, 50)

  root.render(
    <ChatApp
      contextName={contextName}
      initialEvents={initialEvents}
      callbacks={callbacks}
      controllerRef={controllerRef}
    />
  )

  renderer.start()

  return {
    addEvent(event: ContextEvent) {
      controllerRef.current?.addEvent(event)
    },
    cleanup() {
      clearInterval(pollInterval)
      process.off("SIGINT", onSigint)
      process.off("SIGTERM", onSigterm)
      root.unmount()
      renderer.stop()
    }
  }
}
