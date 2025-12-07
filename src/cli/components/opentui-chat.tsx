/**
 * OpenTUI Chat Component
 *
 * Architecture:
 * - ContextEvent[] dispatched via controller.addEvent()
 * - feedReducer folds each event into FeedItem[] (accumulated state)
 * - Feed component renders feedItems (pure render, knows nothing about events)
 *
 * Why reduce to data (FeedItem[]) rather than directly to React components?
 * - React's state model expects serializable data for reconciliation
 * - Stable `id` fields on FeedItem enable memo() to skip re-renders
 * - Streaming updates: append to existing AssistantMessageItem, not mutate JSX
 * - Testable: unit test feedReducer without React
 * - Debuggable: inspect feedItems as JSON
 *
 * Key reducer transitions:
 * - TextDeltaEvent: create/append to InProgressAssistant
 * - AssistantMessageEvent: remove InProgressAssistant, add AssistantMessage
 * - AgentTurnInterruptedEvent: remove InProgressAssistant, add LLMInterruption
 */
import { createCliRenderer, TextAttributes } from "@opentui/core"
import type { JSX } from "@opentui/react/jsx-runtime"
import { createRoot } from "@opentui/react/renderer"
import { DateTime, Option, Schema } from "effect"
import { memo, useCallback, useMemo, useReducer, useRef, useState } from "react"
import type { ContextEvent } from "../../domain.ts"

/** Format as "Sunday, Dec 7, 2025" */
function formatDateOnly(timestamp: DateTime.DateTime): string {
  const date = DateTime.toDateUtc(timestamp)
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric"
  })
}

/** Format as "14:30:45" */
function formatTimeOnly(timestamp: DateTime.DateTime): string {
  const date = DateTime.toDateUtc(timestamp)
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  })
}

/** Get date string for comparison (YYYY-MM-DD) */
function getDateKey(timestamp: DateTime.DateTime): string {
  const date = DateTime.toDateUtc(timestamp)
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

/** Common fields for timestamp display */
const TimestampFields = {
  timestamp: Schema.DateTimeUtc,
  eventId: Schema.String,
  msSincePrevious: Schema.optionalWith(Schema.Number, { as: "Option" })
}

/** User's message in the conversation */
class UserMessageItem extends Schema.TaggedClass<UserMessageItem>()("UserMessageItem", {
  id: Schema.String,
  content: Schema.String,
  ...TimestampFields
}) {}

const AssistantMessageStatus = Schema.Literal("complete", "streaming", "interrupted")
type AssistantMessageStatus = typeof AssistantMessageStatus.Type

/** Assistant response - handles streaming, complete, and interrupted states */
class AssistantMessageItem extends Schema.TaggedClass<AssistantMessageItem>()("AssistantMessageItem", {
  id: Schema.String,
  content: Schema.String,
  status: AssistantMessageStatus,
  /** For interrupted status: ms from turn start to interruption */
  interruptedAfterMs: Schema.optionalWith(Schema.Number, { as: "Option" }),
  ...TimestampFields
}) {}

/** Generic system event: shows tag + detail + timestamp */
class SystemEventItem extends Schema.TaggedClass<SystemEventItem>()("SystemEventItem", {
  id: Schema.String,
  tag: Schema.String,
  detail: Schema.String,
  ...TimestampFields
}) {}

/** Date heading inserted when crossing day boundary */
class DateHeadingItem extends Schema.TaggedClass<DateHeadingItem>()("DateHeadingItem", {
  id: Schema.String,
  dateString: Schema.String,
  timestamp: Schema.DateTimeUtc
}) {}

/**
 * Intermediate representation between events and UI. Each variant maps to a
 * visual element but is plain data - components derive from this, not the
 * reverse. Stable `id` enables React memoization.
 */
const FeedItem = Schema.Union(
  UserMessageItem,
  AssistantMessageItem,
  SystemEventItem,
  DateHeadingItem
)
type FeedItem = typeof FeedItem.Type

type FeedAction = { event: ContextEvent }

/** Calculate ms since previous item's timestamp (skip DateHeadingItem) */
function getMsSincePrevious(
  items: Array<FeedItem>,
  currentTimestamp: DateTime.Utc
): Option.Option<number> {
  const nonHeadings = items.filter((i): i is Exclude<FeedItem, DateHeadingItem> => i._tag !== "DateHeadingItem")
  const last = nonHeadings.at(-1)
  if (!last) return Option.none()
  const prevMs = DateTime.toEpochMillis(last.timestamp)
  const currMs = DateTime.toEpochMillis(currentTimestamp)
  return Option.some(currMs - prevMs)
}

/** Check if we need a date heading before this event */
function maybeAddDateHeading(
  items: Array<FeedItem>,
  timestamp: DateTime.Utc
): Array<FeedItem> {
  const currentDateKey = getDateKey(timestamp)
  const nonHeadings = items.filter((i): i is Exclude<FeedItem, DateHeadingItem> => i._tag !== "DateHeadingItem")
  const lastWithTimestamp = nonHeadings.at(-1)
  if (!lastWithTimestamp) {
    // First item - add date heading
    return [
      new DateHeadingItem({
        id: crypto.randomUUID(),
        dateString: formatDateOnly(timestamp),
        timestamp
      })
    ]
  }
  const lastDateKey = getDateKey(lastWithTimestamp.timestamp)
  if (lastDateKey !== currentDateKey) {
    // Crossed date boundary - add heading
    return [
      ...items,
      new DateHeadingItem({
        id: crypto.randomUUID(),
        dateString: formatDateOnly(timestamp),
        timestamp
      })
    ]
  }
  return items
}

/**
 * Folds a context event into accumulated feed items.
 * Called exactly once per event via useReducer dispatch.
 */
function feedReducer(items: Array<FeedItem>, action: FeedAction): Array<FeedItem> {
  const { event } = action
  const itemsWithDateHeading = maybeAddDateHeading(items, event.timestamp)
  const msSincePrevious = getMsSincePrevious(itemsWithDateHeading, event.timestamp)

  switch (event._tag) {
    case "TextDeltaEvent": {
      const last = itemsWithDateHeading.at(-1)
      if (last?._tag === "AssistantMessageItem" && last.status === "streaming") {
        return [
          ...itemsWithDateHeading.slice(0, -1),
          new AssistantMessageItem({ ...last, content: last.content + event.delta })
        ]
      }
      return [
        ...itemsWithDateHeading,
        new AssistantMessageItem({
          id: crypto.randomUUID(),
          content: event.delta,
          status: "streaming",
          interruptedAfterMs: Option.none(),
          timestamp: event.timestamp,
          eventId: event.id,
          msSincePrevious
        })
      ]
    }

    case "AssistantMessageEvent": {
      const filtered = itemsWithDateHeading.filter(
        (i) => !(i._tag === "AssistantMessageItem" && i.status === "streaming")
      )
      return [
        ...filtered,
        new AssistantMessageItem({
          id: crypto.randomUUID(),
          content: event.content,
          status: "complete",
          interruptedAfterMs: Option.none(),
          timestamp: event.timestamp,
          eventId: event.id,
          msSincePrevious: getMsSincePrevious(filtered, event.timestamp)
        })
      ]
    }

    case "AgentTurnInterruptedEvent": {
      const streamingItem = itemsWithDateHeading.find(
        (i): i is AssistantMessageItem => i._tag === "AssistantMessageItem" && i.status === "streaming"
      )
      const filtered = itemsWithDateHeading.filter(
        (i) => !(i._tag === "AssistantMessageItem" && i.status === "streaming")
      )
      const partialResponse = Option.isSome(event.partialResponse)
        ? event.partialResponse.value
        : ""
      const interruptedAfterMs = streamingItem
        ? Option.some(DateTime.toEpochMillis(event.timestamp) - DateTime.toEpochMillis(streamingItem.timestamp))
        : Option.none()

      const interruptedItem = new AssistantMessageItem({
        id: crypto.randomUUID(),
        content: partialResponse,
        status: "interrupted",
        interruptedAfterMs,
        timestamp: event.timestamp,
        eventId: event.id,
        msSincePrevious: getMsSincePrevious(filtered, event.timestamp)
      })

      // When interruptedByEventId is set, reorder so the interrupted assistant message
      // appears BEFORE the user message that caused the interruption. This makes the
      // conversation flow naturally: User asks → Assistant responds (interrupted) → User interrupts
      if (Option.isSome(event.interruptedByEventId)) {
        const interruptingEventId = event.interruptedByEventId.value
        const insertIndex = filtered.findIndex(
          (i) => i._tag === "UserMessageItem" && i.eventId === interruptingEventId
        )
        if (insertIndex !== -1) {
          // Insert the interrupted assistant message just before the interrupting user message
          return [
            ...filtered.slice(0, insertIndex),
            interruptedItem,
            ...filtered.slice(insertIndex)
          ]
        }
      }

      // Default: append at end (for user_cancel, session_ended, or if eventId not found)
      return [...filtered, interruptedItem]
    }

    case "UserMessageEvent":
      return [
        ...itemsWithDateHeading,
        new UserMessageItem({
          id: crypto.randomUUID(),
          content: event.content,
          timestamp: event.timestamp,
          eventId: event.id,
          msSincePrevious
        })
      ]

    case "SessionStartedEvent":
      return [
        ...itemsWithDateHeading,
        new SystemEventItem({
          id: crypto.randomUUID(),
          tag: event._tag,
          detail: "",
          timestamp: event.timestamp,
          eventId: event.id,
          msSincePrevious
        })
      ]

    case "SessionEndedEvent":
      return [
        ...itemsWithDateHeading,
        new SystemEventItem({
          id: crypto.randomUUID(),
          tag: event._tag,
          detail: "",
          timestamp: event.timestamp,
          eventId: event.id,
          msSincePrevious
        })
      ]

    case "SystemPromptEvent":
      return [
        ...itemsWithDateHeading,
        new SystemEventItem({
          id: crypto.randomUUID(),
          tag: event._tag,
          detail: event.content,
          timestamp: event.timestamp,
          eventId: event.id,
          msSincePrevious
        })
      ]

    case "SetLlmConfigEvent":
      return [
        ...itemsWithDateHeading,
        new SystemEventItem({
          id: crypto.randomUUID(),
          tag: event._tag,
          detail: event.model,
          timestamp: event.timestamp,
          eventId: event.id,
          msSincePrevious
        })
      ]

    // Lifecycle events we skip (too noisy)
    case "AgentTurnStartedEvent":
    case "AgentTurnCompletedEvent":
    case "AgentTurnFailedEvent":
      return items

    default:
      return [
        ...itemsWithDateHeading,
        new SystemEventItem({
          id: crypto.randomUUID(),
          tag: (event as { _tag: string })._tag,
          detail: "",
          timestamp: (event as { timestamp: DateTime.Utc }).timestamp,
          eventId: (event as { id: string }).id,
          msSincePrevious
        })
      ]
  }
}

const colors = {
  red: "#FF5555",
  yellow: "#F5A623",
  blue: "#0B93F6",
  dim: "#666666",
  placeholder: "#555555",

  // Message backgrounds
  userBg: "#0F1A28",
  userLabel: "#5A9FD4",
  assistantBg: "#0F1A15",
  assistantLabel: "#5ABF7A",

  // Event font colors
  sessionStarted: "#AA55FF",
  sessionEnded: "#8844CC",
  systemPrompt: "#55AAAA",
  setLlmConfig: "#AAAA55",
  llmInterruption: "#CC5555"
}

/** Format ms delta as human-readable string */
function formatMsDelta(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

/** Reusable right-aligned timestamp: (delta) HH:MM:SS */
interface TimestampRightProps {
  msSincePrevious?: Option.Option<number> | undefined
  timestamp: DateTime.Utc
  color?: string | undefined
}

const TimestampRight = memo<TimestampRightProps>(({ color = colors.dim, msSincePrevious, timestamp }) => {
  const deltaStr = msSincePrevious && Option.isSome(msSincePrevious) ? `(${formatMsDelta(msSincePrevious.value)}) ` : ""
  return <text fg={color}>{deltaStr}{formatTimeOnly(timestamp)}</text>
})

type BoxProps = JSX.IntrinsicElements["box"]

interface SystemEventRowProps extends Omit<BoxProps, "children" | "flexDirection" | "width"> {
  label: string
  detail?: string | undefined
  timestamp: DateTime.Utc
  msSincePrevious?: Option.Option<number> | undefined
  labelColor?: string | undefined
}

const SystemEventRow = memo<SystemEventRowProps>(({
  detail,
  label,
  labelColor = colors.dim,
  marginBottom = 1,
  marginTop = 0,
  msSincePrevious,
  paddingLeft = 1,
  paddingRight = 1,
  timestamp,
  ...boxProps
}) => {
  const displayText = detail ? `${label}: ${detail}` : label
  return (
    <box
      flexDirection="row"
      width="100%"
      marginTop={marginTop}
      marginBottom={marginBottom}
      paddingLeft={paddingLeft}
      paddingRight={paddingRight}
      {...boxProps}
    >
      <text fg={labelColor}>{displayText}</text>
      <box flexGrow={1} />
      <TimestampRight msSincePrevious={msSincePrevious} timestamp={timestamp} />
    </box>
  )
})

const UserMessageRenderer = memo<{ item: UserMessageItem }>(({ item }) => (
  <box flexDirection="column" width="100%" marginBottom={1} backgroundColor={colors.userBg} padding={1}>
    <box flexDirection="row" width="100%">
      <text fg={colors.userLabel} attributes={TextAttributes.BOLD}>You:</text>
      <box flexGrow={1} />
      <TimestampRight msSincePrevious={item.msSincePrevious} timestamp={item.timestamp} />
    </box>
    <text>{item.content}</text>
  </box>
))

interface AssistantMessageBoxProps {
  content: string
  timestamp: DateTime.Utc
  msSincePrevious?: Option.Option<number> | undefined
  interruptedAfterMs?: Option.Option<number> | undefined
  status: "complete" | "streaming" | "interrupted"
}

const AssistantMessageBox = memo<AssistantMessageBoxProps>(({
  content,
  interruptedAfterMs,
  msSincePrevious,
  status,
  timestamp
}) => {
  const interruptLabel = interruptedAfterMs && Option.isSome(interruptedAfterMs)
    ? `— interrupted after ${formatMsDelta(interruptedAfterMs.value)} —`
    : "— interrupted —"
  return (
    <box flexDirection="column" width="100%" marginBottom={1} backgroundColor={colors.assistantBg} padding={1}>
      <box flexDirection="row" width="100%">
        <text fg={colors.assistantLabel} attributes={TextAttributes.BOLD}>Assistant:</text>
        <box flexGrow={1} />
        <TimestampRight msSincePrevious={msSincePrevious} timestamp={timestamp} />
      </box>
      <text>
        {status === "streaming" && !content ? "Thinking..." : content}
        {status === "streaming" && content && <span>▌</span>}
      </text>
      {status === "interrupted" && <text fg={colors.llmInterruption}>{interruptLabel}</text>}
    </box>
  )
})

/** Date heading: right-aligned date */
const DateHeadingRenderer = memo<{ item: DateHeadingItem }>(({ item }) => (
  <box flexDirection="row" width="100%" marginTop={0} marginBottom={1} paddingLeft={1} paddingRight={1}>
    <box flexGrow={1} />
    <text fg={colors.dim}>{item.dateString}</text>
  </box>
))

/** Get font color for system event based on tag */
function getSystemEventColor(tag: string): string {
  switch (tag) {
    case "SessionStartedEvent":
      return colors.sessionStarted
    case "SessionEndedEvent":
      return colors.sessionEnded
    case "SystemPromptEvent":
      return colors.systemPrompt
    case "SetLlmConfigEvent":
      return colors.setLlmConfig
    default:
      return colors.dim
  }
}

const SystemEventRenderer = memo<{ item: SystemEventItem }>(({ item }) => {
  const isSessionEnd = item.tag === "SessionEndedEvent"
  return (
    <SystemEventRow
      label={item.tag}
      detail={item.detail || undefined}
      timestamp={item.timestamp}
      msSincePrevious={item.msSincePrevious}
      labelColor={getSystemEventColor(item.tag)}
      border={isSessionEnd ? ["bottom"] : false}
      borderColor={isSessionEnd ? colors.dim : undefined}
      marginBottom={1}
    />
  )
})

const FeedItemRenderer = memo<{ item: FeedItem }>(({ item }) => {
  switch (item._tag) {
    case "UserMessageItem":
      return <UserMessageRenderer item={item} />
    case "AssistantMessageItem":
      return (
        <AssistantMessageBox
          content={item.content}
          timestamp={item.timestamp}
          msSincePrevious={item.msSincePrevious}
          interruptedAfterMs={item.interruptedAfterMs}
          status={item.status}
        />
      )
    case "SystemEventItem":
      return <SystemEventRenderer item={item} />
    case "DateHeadingItem":
      return <DateHeadingRenderer item={item} />
  }
})

/** Pure render: maps data → JSX. Knows nothing about events or state transitions. */
const Feed = memo<{ feedItems: Array<FeedItem> }>(({ feedItems }) => (
  <box flexDirection="column" width="100%">
    {feedItems.map((item) => <FeedItemRenderer key={item.id} item={item} />)}
  </box>
))

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
  // Derive initial feed items from initial events (runs once on mount)
  const initialFeedItems = useMemo(
    () =>
      initialEvents.reduce<Array<FeedItem>>(
        (items, event) => feedReducer(items, { event }),
        []
      ),
    []
  )

  const [feedItems, dispatch] = useReducer(feedReducer, initialFeedItems)
  const [inputValue, setInputValue] = useState("")
  const dispatchRef = useRef(dispatch)
  dispatchRef.current = dispatch

  // Check if currently streaming (for input placeholder)
  const isStreaming = feedItems.some(
    (item) => item._tag === "AssistantMessageItem" && item.status === "streaming"
  )
  const isStreamingRef = useRef(false)
  isStreamingRef.current = isStreaming

  // Set up controller synchronously during first render
  if (!controllerRef.current) {
    controllerRef.current = {
      addEvent(event: ContextEvent) {
        dispatchRef.current({ event })
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
        <Feed feedItems={feedItems} />
      </scrollbox>

      <box height={1} width="100%" flexDirection="row">
        <text fg={colors.blue} attributes={TextAttributes.BOLD}>
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
        <text fg={colors.dim}>
          <span fg={colors.yellow}>Agent:</span> {contextName} ·
          <span fg={colors.yellow}>{isStreaming ? " Return to interrupt" : " Ctrl+C to exit"}</span>
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
