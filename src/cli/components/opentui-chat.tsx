/**
 * OpenTUI Chat Component
 *
 * A chat interface with:
 * - Scrollable conversation history at top
 * - Input field at bottom
 * - Enter submits, Escape cancels streaming or exits
 *
 * Uses React state internally for proper reconciliation and performance.
 * External control is done via refs, not repeated root.render() calls.
 */
import { createCliRenderer, TextAttributes } from "@opentui/core"
import { createRoot } from "@opentui/react/renderer"
import * as fs from "node:fs"
import { useCallback, useEffect, useRef, useState } from "react"

// Debug logging to file (bypasses OpenTUI's terminal management)
const DEBUG_LOG = "/tmp/chat-ui-debug.log"
const debug = (msg: string) => {
  fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] [opentui] ${msg}\n`)
}

// =============================================================================
// Types
// =============================================================================

export interface Message {
  role: "user" | "assistant" | "system"
  content: string
  interrupted?: boolean
}

export interface ChatCallbacks {
  onSubmit: (text: string) => void
  onEscape: () => void
  onExit: () => void
}

export interface ChatController {
  addMessage: (msg: Message) => void
  startStreaming: () => void
  appendStreamingText: (delta: string) => void
  endStreaming: (finalContent?: string, interrupted?: boolean) => void
  cleanup: () => void
}

// =============================================================================
// Colors - using hex strings for fg/bg props
// =============================================================================

const colors = {
  // Bright colors for current session
  cyan: "#00FFFF",
  green: "#00FF00",
  white: "#FFFFFF",
  red: "#FF5555",
  yellow: "#FFFF00",

  // Muted colors for history
  dimCyan: "#5F8787",
  dimGreen: "#5F875F",
  dim: "#666666",
  dimRed: "#8B4040",

  // UI elements
  separator: "#444444",
  placeholder: "#555555"
}

// =============================================================================
// Message Renderer Component
// =============================================================================

function MessageView({ msg, isHistory }: { msg: Message; isHistory: boolean }) {
  const userColor = isHistory ? colors.dimCyan : colors.cyan
  const assistantColor = isHistory ? colors.dimGreen : colors.green
  const textColor = isHistory ? colors.dim : colors.white
  const labelColor = msg.role === "user" ? userColor : assistantColor

  if (msg.interrupted) {
    // Interrupted messages: extra margin, red styling
    return (
      <box flexDirection="column" marginTop={1} marginBottom={1}>
        <text fg={isHistory ? colors.dimGreen : colors.green} attributes={isHistory ? TextAttributes.NONE : TextAttributes.BOLD}>
          Assistant:
        </text>
        <text fg={textColor}>{msg.content}</text>
        <text fg={isHistory ? colors.dimRed : colors.red}>— interrupted —</text>
      </box>
    )
  }

  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={labelColor} attributes={isHistory ? TextAttributes.NONE : TextAttributes.BOLD}>
        {msg.role === "user" ? "You:" : "Assistant:"}
      </text>
      <text fg={textColor}>{msg.content}</text>
    </box>
  )
}

// =============================================================================
// Chat App Component (uses internal React state)
// =============================================================================

interface ChatAppInternalProps {
  contextName: string
  initialMessages: Message[]
  callbacks: ChatCallbacks
  controllerRef: React.MutableRefObject<ChatController | null>
}

function ChatApp({ contextName, initialMessages, callbacks, controllerRef }: ChatAppInternalProps) {
  const [messages, setMessages] = useState<Message[]>(initialMessages)
  const [initialMessageCount] = useState(initialMessages.length)
  const [streamingText, setStreamingText] = useState("")
  const [isStreaming, setIsStreaming] = useState(false)
  const [inputValue, setInputValue] = useState("")
  const isStreamingRef = useRef(isStreaming)

  // Keep ref in sync with state for callbacks
  useEffect(() => {
    isStreamingRef.current = isStreaming
  }, [isStreaming])

  // Expose controller methods via ref (no re-renders needed from outside)
  useEffect(() => {
    controllerRef.current = {
      addMessage(msg: Message) {
        setMessages(prev => [...prev, msg])
      },
      startStreaming() {
        setIsStreaming(true)
        setStreamingText("")
      },
      appendStreamingText(delta: string) {
        setStreamingText(prev => prev + delta)
      },
      endStreaming(finalContent?: string, interrupted = false) {
        if (finalContent) {
          setMessages(prev => [...prev, { role: "assistant", content: finalContent, interrupted }])
        }
        setIsStreaming(false)
        setStreamingText("")
      },
      cleanup() {
        // cleanup handled by runner
      }
    }
  }, [controllerRef])

  // Note: useKeyboard doesn't receive events when <input> is focused.
  // Ctrl+C is handled via renderer.stop() interception in runOpenTUIChat.
  // Escape during streaming must use Enter (empty) instead.

  // Handle input change
  const handleInput = useCallback((value: string) => {
    setInputValue(value)
  }, [])

  // Handle submit from input
  // - Text: submit (interrupt first if streaming)
  // - Empty during streaming: cancel streaming
  // - Empty when idle: exit
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

  const historyMessages = messages.slice(0, initialMessageCount)
  const newMessages = messages.slice(initialMessageCount)

  return (
    <box width="100%" height="100%" flexDirection="column">
      {/* Conversation history */}
      <scrollbox
        flexGrow={1}
        width="100%"
        borderStyle="single"
        borderColor={colors.separator}
        stickyScroll={true}
        stickyStart="bottom"
      >
        <box flexDirection="column" width="100%" padding={1}>
          {/* History header */}
          {historyMessages.length > 0 && (
            <box flexDirection="column" marginBottom={1}>
              <text fg={colors.dim}>{"─".repeat(50)}</text>
              <text fg={colors.dim}>Previous conversation:</text>
              <text> </text>
            </box>
          )}

          {/* Historical messages (muted) */}
          {historyMessages.map((msg, idx) => (
            <MessageView key={`hist-${idx}`} msg={msg} isHistory={true} />
          ))}

          {/* End of history separator */}
          {historyMessages.length > 0 && (
            <box marginBottom={1}>
              <text fg={colors.dim}>{"─".repeat(50)}</text>
            </box>
          )}

          {/* New messages from this session (bright) */}
          {newMessages.map((msg, idx) => (
            <MessageView key={`new-${idx}`} msg={msg} isHistory={false} />
          ))}

          {/* Streaming indicator when no text yet */}
          {isStreaming && !streamingText && (
            <box flexDirection="column" marginBottom={1}>
              <text fg={colors.green} attributes={TextAttributes.BOLD}>Assistant:</text>
              <text fg={colors.dim}>Thinking...</text>
            </box>
          )}

          {/* Streaming text with cursor */}
          {isStreaming && streamingText && (
            <box flexDirection="column" marginBottom={1}>
              <text fg={colors.green} attributes={TextAttributes.BOLD}>Assistant:</text>
              <text fg={colors.white}>{streamingText}<span fg={colors.cyan}>▌</span></text>
            </box>
          )}
        </box>
      </scrollbox>

      {/* Input area */}
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

      {/* Footer with context label and instructions */}
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
  initialMessages: Message[],
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

  // Ensure we propagate Ctrl+C to the Effect-side even if OpenTUI swallows it.
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

  // Poll for OpenTUI exit: when it closes, stdin exits raw mode
  const pollInterval = setInterval(() => {
    if (!process.stdin.isRaw) {
      debug("stdin no longer in raw mode - OpenTUI exited")
      clearInterval(pollInterval)
      signalExit()
    }
  }, 50)

  // Single render - React handles all subsequent updates via state
  root.render(
    <ChatApp
      contextName={contextName}
      initialMessages={initialMessages}
      callbacks={callbacks}
      controllerRef={controllerRef}
    />
  )

  renderer.start()

  // Return proxy that delegates to the ref (once component mounts)
  return {
    addMessage(msg: Message) {
      controllerRef.current?.addMessage(msg)
    },
    startStreaming() {
      controllerRef.current?.startStreaming()
    },
    appendStreamingText(delta: string) {
      controllerRef.current?.appendStreamingText(delta)
    },
    endStreaming(finalContent?: string, interrupted = false) {
      controllerRef.current?.endStreaming(finalContent, interrupted)
    },
    cleanup() {
      debug("cleanup() called")
      clearInterval(pollInterval)
      // Remove signal listeners added above
      process.off("SIGINT", onSigint)
      process.off("SIGTERM", onSigterm)
      root.unmount()
      renderer.stop()
      debug("cleanup() completed")
    }
  }
}
