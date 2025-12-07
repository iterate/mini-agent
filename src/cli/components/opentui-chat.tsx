/**
 * OpenTUI Chat Component
 *
 * Architecture:
 * - Event objects dispatched via controller.addEvent()
 * - feedReducer folds each event into FeedItem[] (accumulated state)
 * - Feed component renders feedItems (pure render, knows nothing about events)
 *
 * Key reducer transitions:
 * - TextDelta: create/append to InProgressAssistant
 * - AssistantMessage: remove InProgressAssistant, add AssistantMessage
 * - LLMRequestInterrupted: remove InProgressAssistant, add LLMInterruption
 */
import { Option, Schema } from "effect"
import { createCliRenderer, TextAttributes } from "@opentui/core"
import { createRoot } from "@opentui/react/renderer"
import { memo, useCallback, useMemo, useReducer, useRef, useState } from "react"
import { AttachmentSource } from "../../domain.ts"

/**
 * Simplified event interface for the chat UI.
 * This decouples the TUI from the full ContextEvent structure.
 */
export interface ChatEvent {
  _tag: string
  content?: string
  delta?: string
  partialResponse?: string
  reason?: string
  source?: { type: "file"; path: string } | { type: "url"; url: string }
  fileName?: string
  requestId?: string
  turnNumber?: number
  durationMs?: number
  error?: string
  model?: string
  provider?: string
  timeoutMs?: number
}

/** User's message in the conversation */
class UserMessageItem extends Schema.TaggedClass<UserMessageItem>()("UserMessageItem", {
  id: Schema.String,
  content: Schema.String,
  isHistory: Schema.Boolean
}) {}

/** Streaming response in progress - accumulates TextDelta events */
class InProgressAssistantItem extends Schema.TaggedClass<InProgressAssistantItem>()("InProgressAssistantItem", {
  id: Schema.String,
  text: Schema.String
}) {}

/** Completed assistant response */
class AssistantMessageItem extends Schema.TaggedClass<AssistantMessageItem>()("AssistantMessageItem", {
  id: Schema.String,
  content: Schema.String,
  isHistory: Schema.Boolean
}) {}

/** Response that was interrupted (user cancel, new message, or timeout) */
class LLMInterruptionItem extends Schema.TaggedClass<LLMInterruptionItem>()("LLMInterruptionItem", {
  id: Schema.String,
  partialResponse: Schema.String,
  reason: Schema.String,
  isHistory: Schema.Boolean
}) {}

/** File or image attachment */
class FileAttachmentItem extends Schema.TaggedClass<FileAttachmentItem>()("FileAttachmentItem", {
  id: Schema.String,
  source: AttachmentSource,
  fileName: Schema.OptionFromNullOr(Schema.String),
  isHistory: Schema.Boolean
}) {}

/** System prompt configuration */
class SystemPromptItem extends Schema.TaggedClass<SystemPromptItem>()("SystemPromptItem", {
  id: Schema.String,
  content: Schema.String,
  isHistory: Schema.Boolean
}) {}

/** Session started lifecycle event */
class SessionStartedItem extends Schema.TaggedClass<SessionStartedItem>()("SessionStartedItem", {
  id: Schema.String,
  isHistory: Schema.Boolean
}) {}

/** Agent turn started lifecycle event */
class AgentTurnStartedItem extends Schema.TaggedClass<AgentTurnStartedItem>()("AgentTurnStartedItem", {
  id: Schema.String,
  turnNumber: Schema.Number,
  isHistory: Schema.Boolean
}) {}

/** Agent turn completed lifecycle event */
class AgentTurnCompletedItem extends Schema.TaggedClass<AgentTurnCompletedItem>()("AgentTurnCompletedItem", {
  id: Schema.String,
  turnNumber: Schema.Number,
  durationMs: Schema.Number,
  isHistory: Schema.Boolean
}) {}

/** Agent turn failed lifecycle event */
class AgentTurnFailedItem extends Schema.TaggedClass<AgentTurnFailedItem>()("AgentTurnFailedItem", {
  id: Schema.String,
  turnNumber: Schema.Number,
  error: Schema.String,
  isHistory: Schema.Boolean
}) {}

/** LLM config change event */
class SetLlmConfigItem extends Schema.TaggedClass<SetLlmConfigItem>()("SetLlmConfigItem", {
  id: Schema.String,
  model: Schema.String,
  provider: Schema.String,
  isHistory: Schema.Boolean
}) {}

/** Fallback for unknown event types - displays muted warning */
class UnknownEventItem extends Schema.TaggedClass<UnknownEventItem>()("UnknownEventItem", {
  id: Schema.String,
  eventTag: Schema.String,
  isHistory: Schema.Boolean
}) {}

const FeedItem = Schema.Union(
  UserMessageItem,
  InProgressAssistantItem,
  AssistantMessageItem,
  LLMInterruptionItem,
  FileAttachmentItem,
  SystemPromptItem,
  SessionStartedItem,
  AgentTurnStartedItem,
  AgentTurnCompletedItem,
  AgentTurnFailedItem,
  SetLlmConfigItem,
  UnknownEventItem
)
type FeedItem = typeof FeedItem.Type

type FeedAction = { event: ChatEvent; isHistory: boolean }

/**
 * Folds a context event into accumulated feed items.
 * Called exactly once per event via useReducer dispatch.
 */
function feedReducer(items: FeedItem[], action: FeedAction): FeedItem[] {
  const { event, isHistory } = action

  switch (event._tag) {
    case "TextDelta": {
      const last = items.at(-1)
      if (last && "_tag" in last && last._tag === "InProgressAssistantItem") {
        const lastItem = last as InProgressAssistantItem
        return [
          ...items.slice(0, -1),
          new InProgressAssistantItem({ ...lastItem, text: lastItem.text + (event.delta ?? "") })
        ]
      }
      return [
        ...items,
        new InProgressAssistantItem({ id: crypto.randomUUID(), text: event.delta ?? "" })
      ]
    }

    case "AssistantMessage": {
      const filtered = items.filter((i) => "_tag" in i && i._tag !== "InProgressAssistantItem")
      return [
        ...filtered,
        new AssistantMessageItem({
          id: crypto.randomUUID(),
          content: event.content ?? "",
          isHistory
        })
      ]
    }

    case "LLMRequestInterrupted": {
      const filtered = items.filter((i) => "_tag" in i && i._tag !== "InProgressAssistantItem")
      return [
        ...filtered,
        new LLMInterruptionItem({
          id: crypto.randomUUID(),
          partialResponse: event.partialResponse ?? "",
          reason: event.reason ?? "unknown",
          isHistory
        })
      ]
    }

    case "UserMessage":
      return [
        ...items,
        new UserMessageItem({
          id: crypto.randomUUID(),
          content: event.content ?? "",
          isHistory
        })
      ]

    case "FileAttachment":
      return [
        ...items,
        new FileAttachmentItem({
          id: crypto.randomUUID(),
          source: event.source ?? { type: "file", path: "" },
          fileName: Option.fromNullable(event.fileName),
          isHistory
        })
      ]

    case "SystemPrompt":
      return [
        ...items,
        new SystemPromptItem({
          id: crypto.randomUUID(),
          content: event.content ?? "",
          isHistory
        })
      ]

    case "SessionStarted":
      return [
        ...items,
        new SessionStartedItem({
          id: crypto.randomUUID(),
          isHistory
        })
      ]

    case "AgentTurnStarted":
      return [
        ...items,
        new AgentTurnStartedItem({
          id: crypto.randomUUID(),
          turnNumber: event.turnNumber ?? 0,
          isHistory
        })
      ]

    case "AgentTurnCompleted":
      return [
        ...items,
        new AgentTurnCompletedItem({
          id: crypto.randomUUID(),
          turnNumber: event.turnNumber ?? 0,
          durationMs: event.durationMs ?? 0,
          isHistory
        })
      ]

    case "AgentTurnFailed":
      return [
        ...items,
        new AgentTurnFailedItem({
          id: crypto.randomUUID(),
          turnNumber: event.turnNumber ?? 0,
          error: event.error ?? "Unknown error",
          isHistory
        })
      ]

    case "SetLlmConfig":
      return [
        ...items,
        new SetLlmConfigItem({
          id: crypto.randomUUID(),
          model: event.model ?? "",
          provider: event.provider ?? "",
          isHistory
        })
      ]

    case "SessionEnded":
    case "SetTimeout":
      // Don't display these events in the UI
      return items

    default:
      return [
        ...items,
        new UnknownEventItem({
          id: crypto.randomUUID(),
          eventTag: event._tag,
          isHistory
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
  placeholder: "#555555"
}

const UserMessageRenderer = memo<{ item: UserMessageItem }>(({ item }) => {
  const labelColor = item.isHistory ? colors.dimCyan : colors.cyan
  const textColor = item.isHistory ? colors.dim : colors.white

  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={labelColor} attributes={item.isHistory ? TextAttributes.NONE : TextAttributes.BOLD}>
        You:
      </text>
      <text fg={textColor}>{item.content}</text>
    </box>
  )
})

const InProgressAssistantRenderer = memo<{ item: InProgressAssistantItem }>(({ item }) => {
  if (!item.text) {
    return (
      <box flexDirection="column" marginBottom={1}>
        <text fg={colors.green} attributes={TextAttributes.BOLD}>
          Assistant:
        </text>
        <text fg={colors.dim}>Thinking...</text>
      </box>
    )
  }

  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={colors.green} attributes={TextAttributes.BOLD}>
        Assistant:
      </text>
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

  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={labelColor} attributes={item.isHistory ? TextAttributes.NONE : TextAttributes.BOLD}>
        Assistant:
      </text>
      <text fg={textColor}>{item.content}</text>
    </box>
  )
})

const LLMInterruptionRenderer = memo<{ item: LLMInterruptionItem }>(({ item }) => {
  const labelColor = item.isHistory ? colors.dimGreen : colors.green
  const textColor = item.isHistory ? colors.dim : colors.white
  const interruptColor = item.isHistory ? colors.dimRed : colors.red

  return (
    <box flexDirection="column" marginTop={1} marginBottom={1}>
      <text fg={labelColor} attributes={item.isHistory ? TextAttributes.NONE : TextAttributes.BOLD}>
        Assistant:
      </text>
      <text fg={textColor}>{item.partialResponse}</text>
      <text fg={interruptColor}>— interrupted —</text>
    </box>
  )
})

const FileAttachmentRenderer = memo<{ item: FileAttachmentItem }>(({ item }) => {
  const textColor = item.isHistory ? colors.dim : colors.yellow
  const name =
    item.fileName._tag === "Some"
      ? item.fileName.value
      : item.source.type === "file"
        ? item.source.path
        : item.source.url

  return (
    <box marginBottom={1}>
      <text fg={textColor}>📎 {name}</text>
    </box>
  )
})

const SystemPromptRenderer = memo<{ item: SystemPromptItem }>(({ item }) => {
  const textColor = item.isHistory ? colors.dim : colors.yellow

  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={textColor}>⚙️ System: {item.content.slice(0, 60)}{item.content.length > 60 ? "..." : ""}</text>
    </box>
  )
})

const SessionStartedRenderer = memo<{ item: SessionStartedItem }>(({ item }) => {
  const textColor = item.isHistory ? colors.dim : colors.yellow

  return (
    <box marginBottom={1}>
      <text fg={textColor}>🔵 Session started</text>
    </box>
  )
})

const AgentTurnStartedRenderer = memo<{ item: AgentTurnStartedItem }>(({ item }) => {
  const textColor = item.isHistory ? colors.dim : colors.yellow

  return (
    <box marginBottom={1}>
      <text fg={textColor}>▶️ Turn {item.turnNumber} started</text>
    </box>
  )
})

const AgentTurnCompletedRenderer = memo<{ item: AgentTurnCompletedItem }>(({ item }) => {
  const textColor = item.isHistory ? colors.dim : colors.yellow

  return (
    <box marginBottom={1}>
      <text fg={textColor}>✅ Turn {item.turnNumber} completed ({item.durationMs}ms)</text>
    </box>
  )
})

const AgentTurnFailedRenderer = memo<{ item: AgentTurnFailedItem }>(({ item }) => {
  const textColor = item.isHistory ? colors.dimRed : colors.red

  return (
    <box marginBottom={1}>
      <text fg={textColor}>❌ Turn {item.turnNumber} failed: {item.error}</text>
    </box>
  )
})

const SetLlmConfigRenderer = memo<{ item: SetLlmConfigItem }>(({ item }) => {
  const textColor = item.isHistory ? colors.dim : colors.yellow

  return (
    <box marginBottom={1}>
      <text fg={textColor}>🤖 LLM: {item.provider}:{item.model}</text>
    </box>
  )
})

const UnknownEventRenderer = memo<{ item: UnknownEventItem }>(({ item }) => {
  return (
    <box marginBottom={1}>
      <text fg={colors.dim}>No renderer for {item.eventTag}</text>
    </box>
  )
})

const FeedItemRenderer = memo<{ item: FeedItem }>(({ item }) => {
  if (!("_tag" in item)) return null

  switch (item._tag) {
    case "UserMessageItem":
      return <UserMessageRenderer item={item as UserMessageItem} />
    case "InProgressAssistantItem":
      return <InProgressAssistantRenderer item={item as InProgressAssistantItem} />
    case "AssistantMessageItem":
      return <AssistantMessageRenderer item={item as AssistantMessageItem} />
    case "LLMInterruptionItem":
      return <LLMInterruptionRenderer item={item as LLMInterruptionItem} />
    case "FileAttachmentItem":
      return <FileAttachmentRenderer item={item as FileAttachmentItem} />
    case "SystemPromptItem":
      return <SystemPromptRenderer item={item as SystemPromptItem} />
    case "SessionStartedItem":
      return <SessionStartedRenderer item={item as SessionStartedItem} />
    case "AgentTurnStartedItem":
      return <AgentTurnStartedRenderer item={item as AgentTurnStartedItem} />
    case "AgentTurnCompletedItem":
      return <AgentTurnCompletedRenderer item={item as AgentTurnCompletedItem} />
    case "AgentTurnFailedItem":
      return <AgentTurnFailedRenderer item={item as AgentTurnFailedItem} />
    case "SetLlmConfigItem":
      return <SetLlmConfigRenderer item={item as SetLlmConfigItem} />
    case "UnknownEventItem":
      return <UnknownEventRenderer item={item as UnknownEventItem} />
    default:
      return null
  }
})

interface FeedProps {
  feedItems: FeedItem[]
  hasHistory: boolean
}

const getItemId = (item: FeedItem): string => {
  if ("id" in item) return item.id as string
  return crypto.randomUUID()
}

const Feed = memo<FeedProps>(({ feedItems, hasHistory }) => {
  return (
    <box flexDirection="column" width="100%" padding={1}>
      {hasHistory && (
        <box flexDirection="column" marginBottom={1}>
          <text fg={colors.dim}>{"─".repeat(50)}</text>
          <text fg={colors.dim}>Previous conversation:</text>
          <text> </text>
        </box>
      )}

      {feedItems.map((item) => (
        <FeedItemRenderer key={getItemId(item)} item={item} />
      ))}
    </box>
  )
})

export interface ChatCallbacks {
  onSubmit: (text: string) => void
  onExit: () => void
}

export interface ChatController {
  addEvent: (event: ChatEvent) => void
  cleanup: () => void
}

interface ChatAppProps {
  contextName: string
  initialEvents: ChatEvent[]
  callbacks: ChatCallbacks
  controllerRef: React.MutableRefObject<ChatController | null>
}

const hasTag = (item: FeedItem): item is FeedItem & { _tag: string } => "_tag" in item

function ChatApp({ contextName, initialEvents, callbacks, controllerRef }: ChatAppProps) {
  // Derive initial feed items from history events (runs once on mount)
  const initialFeedItems = useMemo(
    () =>
      initialEvents.reduce<FeedItem[]>(
        (items, event) => feedReducer(items, { event, isHistory: true }),
        []
      ),
    [] // eslint-disable-line react-hooks/exhaustive-deps
  )

  const [feedItems, dispatch] = useReducer(feedReducer, initialFeedItems)
  const [inputValue, setInputValue] = useState("")
  const dispatchRef = useRef(dispatch)
  dispatchRef.current = dispatch

  // Check if we have any history (for separator display)
  const hasHistory = initialFeedItems.some(
    (item) =>
      hasTag(item) && (
        item._tag === "UserMessageItem" ||
        item._tag === "AssistantMessageItem" ||
        item._tag === "LLMInterruptionItem"
      )
  )

  // Check if currently streaming (for input placeholder)
  const isStreaming = feedItems.some((item) => hasTag(item) && item._tag === "InProgressAssistantItem")
  const isStreamingRef = useRef(false)
  isStreamingRef.current = isStreaming

  // Set up controller synchronously during first render
  if (!controllerRef.current) {
    controllerRef.current = {
      addEvent(event: ChatEvent) {
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
        borderStyle="single"
        borderColor={colors.separator}
        stickyScroll={true}
        stickyStart="bottom"
      >
        <Feed feedItems={feedItems} hasHistory={hasHistory} />
      </scrollbox>

      <box height={1} width="100%" flexDirection="row">
        <text fg={colors.cyan} attributes={TextAttributes.BOLD}>
          {">"}{" "}
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
          <span fg={colors.yellow}>context: </span>
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
  initialEvents: ChatEvent[],
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
    addEvent(event: ChatEvent) {
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
