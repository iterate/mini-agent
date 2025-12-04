/**
 * OpenTUI Chat Component
 *
 * A chat interface with:
 * - Scrollable event log at top with pluggable renderers by _tag
 * - Input field at bottom
 * - Enter submits, Escape cancels streaming or exits
 *
 * Streaming behavior: during LLM request, streaming text accumulates.
 * Once complete, the streaming display is replaced by the final AssistantMessageEvent.
 */
import { createCliRenderer, TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { createRoot } from "@opentui/react/renderer"
import * as fs from "node:fs"
import { memo, useCallback, useEffect, useRef, useState } from "react"
import type {
  AssistantMessageEvent,
  FileAttachmentEvent,
  LLMRequestInterruptedEvent,
  PersistedEvent,
  UserMessageEvent
} from "../../context.model.ts"

const DEBUG_LOG = "/tmp/chat-ui-debug.log"
const debug = (msg: string) => {
  fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] [opentui] ${msg}\n`)
}

// =============================================================================
// Types
// =============================================================================

export interface ChatCallbacks {
  onSubmit: (text: string) => void
  onEscape: () => void
  onExit: () => void
}

export interface ChatController {
  addEvent: (event: PersistedEvent) => void
  startStreaming: () => void
  appendStreamingText: (delta: string) => void
  endStreaming: () => void
  cleanup: () => void
}

// =============================================================================
// Colors
// =============================================================================

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

// =============================================================================
// Event Renderer Registry
// =============================================================================

interface EventRendererProps<E extends PersistedEvent> {
  event: E
  isHistory: boolean
}

const UserMessageRenderer = memo<EventRendererProps<UserMessageEvent>>(({ event, isHistory }) => {
  const labelColor = isHistory ? colors.dimCyan : colors.cyan
  const textColor = isHistory ? colors.dim : colors.white

  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={labelColor} attributes={isHistory ? TextAttributes.NONE : TextAttributes.BOLD}>
        You:
      </text>
      <text fg={textColor}>{event.content}</text>
    </box>
  )
})

const AssistantMessageRenderer = memo<EventRendererProps<AssistantMessageEvent>>(({ event, isHistory }) => {
  const labelColor = isHistory ? colors.dimGreen : colors.green
  const textColor = isHistory ? colors.dim : colors.white

  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={labelColor} attributes={isHistory ? TextAttributes.NONE : TextAttributes.BOLD}>
        Assistant:
      </text>
      <text fg={textColor}>{event.content}</text>
    </box>
  )
})

const InterruptedMessageRenderer = memo<EventRendererProps<LLMRequestInterruptedEvent>>(({ event, isHistory }) => {
  const labelColor = isHistory ? colors.dimGreen : colors.green
  const textColor = isHistory ? colors.dim : colors.white
  const interruptColor = isHistory ? colors.dimRed : colors.red

  return (
    <box flexDirection="column" marginTop={1} marginBottom={1}>
      <text fg={labelColor} attributes={isHistory ? TextAttributes.NONE : TextAttributes.BOLD}>
        Assistant:
      </text>
      <text fg={textColor}>{event.partialResponse}</text>
      <text fg={interruptColor}>— interrupted —</text>
    </box>
  )
})

const FileAttachmentRenderer = memo<EventRendererProps<FileAttachmentEvent>>(({ event, isHistory }) => {
  const textColor = isHistory ? colors.dim : colors.yellow
  const name = event.fileName ?? (event.source.type === "file" ? event.source.path : event.source.url)

  return (
    <box marginBottom={1}>
      <text fg={textColor}>📎 {name}</text>
    </box>
  )
})

const EventView = memo<{ event: PersistedEvent; isHistory: boolean }>(({ event, isHistory }) => {
  switch (event._tag) {
    case "UserMessage":
      return <UserMessageRenderer event={event} isHistory={isHistory} />
    case "AssistantMessage":
      return <AssistantMessageRenderer event={event} isHistory={isHistory} />
    case "LLMRequestInterrupted":
      return <InterruptedMessageRenderer event={event} isHistory={isHistory} />
    case "FileAttachment":
      return <FileAttachmentRenderer event={event} isHistory={isHistory} />
    case "SystemPrompt":
    case "SetLlmConfig":
      return null
  }
})

// =============================================================================
// Streaming Display
// =============================================================================

interface StreamingDisplayProps {
  text: string
}

const StreamingDisplay = memo<StreamingDisplayProps>(({ text }) => {
  if (!text) {
    return (
      <box flexDirection="column" marginBottom={1}>
        <text fg={colors.green} attributes={TextAttributes.BOLD}>Assistant:</text>
        <text fg={colors.dim}>Thinking...</text>
      </box>
    )
  }

  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={colors.green} attributes={TextAttributes.BOLD}>Assistant:</text>
      <text fg={colors.white}>{text}<span fg={colors.cyan}>▌</span></text>
    </box>
  )
})

// =============================================================================
// Chat App Component
// =============================================================================

interface ChatAppProps {
  contextName: string
  initialEvents: PersistedEvent[]
  callbacks: ChatCallbacks
  controllerRef: React.MutableRefObject<ChatController | null>
}

function ChatApp({ contextName, initialEvents, callbacks, controllerRef }: ChatAppProps) {
  const [events, setEvents] = useState<PersistedEvent[]>(initialEvents)
  const [initialEventCount] = useState(initialEvents.length)
  const [streamingText, setStreamingText] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [inputValue, setInputValue] = useState("")
  const isStreamingRef = useRef(isStreaming)

  useEffect(() => {
    isStreamingRef.current = isStreaming
  }, [isStreaming])

  useKeyboard((key) => {
    if (key.name === "escape") {
      debug("useKeyboard: Escape pressed")
      if (isStreamingRef.current) {
        callbacks.onEscape()
      } else {
        callbacks.onExit()
      }
    }
  })

  useEffect(() => {
    controllerRef.current = {
      addEvent(event: PersistedEvent) {
        setEvents(prev => [...prev, event])
      },
      startStreaming() {
        setIsStreaming(true)
        setStreamingText("")
      },
      appendStreamingText(delta: string) {
        setStreamingText(prev => prev + delta)
      },
      endStreaming() {
        setIsStreaming(false)
        setStreamingText("")
      },
      cleanup() {
        // handled by runner
      }
    }
  }, [controllerRef])

  const handleInput = useCallback((value: string) => {
    setInputValue(value)
  }, [])

  const handleSubmit = useCallback((value: string) => {
    if (value.trim()) {
      if (isStreamingRef.current) {
        callbacks.onEscape()
      }
      setInputValue("")
      callbacks.onSubmit(value.trim())
    } else if (isStreamingRef.current) {
      callbacks.onEscape()
    } else {
      callbacks.onExit()
    }
  }, [callbacks])

  const historyEvents = events.slice(0, initialEventCount)
  const newEvents = events.slice(initialEventCount)

  const hasHistory = historyEvents.some(e => e._tag === "UserMessage" || e._tag === "AssistantMessage")

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
        <box flexDirection="column" width="100%" padding={1}>
          {hasHistory && (
            <box flexDirection="column" marginBottom={1}>
              <text fg={colors.dim}>{"─".repeat(50)}</text>
              <text fg={colors.dim}>Previous conversation:</text>
              <text> </text>
            </box>
          )}

          {historyEvents.map((event, idx) => (
            <EventView key={`hist-${idx}-${event._tag}`} event={event} isHistory={true} />
          ))}

          {hasHistory && (
            <box marginBottom={1}>
              <text fg={colors.dim}>{"─".repeat(50)}</text>
            </box>
          )}

          {newEvents.map((event, idx) => (
            <EventView key={`new-${idx}-${event._tag}`} event={event} isHistory={false} />
          ))}

          {isStreaming && <StreamingDisplay text={streamingText} />}
        </box>
      </scrollbox>

      <box height={1} width="100%" flexDirection="row">
        <text fg={colors.cyan} attributes={TextAttributes.BOLD}>{">"} </text>
        <input
          flexGrow={1}
          value={inputValue}
          placeholder={isStreaming ? "Type to interrupt and send..." : "Type your message..."}
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
          <span fg={colors.yellow}>{isStreaming ? "Enter to cancel" : "Enter to exit"}</span>
        </text>
      </box>
    </box>
  )
}

// =============================================================================
// Chat Runner
// =============================================================================

export async function runOpenTUIChat(
  contextName: string,
  initialEvents: PersistedEvent[],
  callbacks: ChatCallbacks
): Promise<ChatController> {
  debug("runOpenTUIChat starting")

  let exitSignaled = false
  const signalExit = () => {
    if (!exitSignaled) {
      exitSignaled = true
      debug("signalExit: calling callbacks.onExit()")
      callbacks.onExit()
    }
  }

  const onSigint = () => {
    debug("SIGINT received - signaling exit")
    signalExit()
  }
  const onSigterm = () => {
    debug("SIGTERM received - signaling exit")
    signalExit()
  }
  process.once("SIGINT", onSigint)
  process.once("SIGTERM", onSigterm)

  const renderer = await createCliRenderer({
    exitOnCtrlC: true
  })
  debug("renderer created")
  const root = createRoot(renderer)
  const controllerRef: { current: ChatController | null } = { current: null }

  const pollInterval = setInterval(() => {
    if (!process.stdin.isRaw) {
      debug("stdin no longer in raw mode - OpenTUI exited")
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
    addEvent(event: PersistedEvent) {
      controllerRef.current?.addEvent(event)
    },
    startStreaming() {
      controllerRef.current?.startStreaming()
    },
    appendStreamingText(delta: string) {
      controllerRef.current?.appendStreamingText(delta)
    },
    endStreaming() {
      controllerRef.current?.endStreaming()
    },
    cleanup() {
      debug("cleanup() called")
      clearInterval(pollInterval)
      process.off("SIGINT", onSigint)
      process.off("SIGTERM", onSigterm)
      root.unmount()
      renderer.stop()
      debug("cleanup() completed")
    }
  }
}
