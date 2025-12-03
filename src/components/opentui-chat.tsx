/**
 * OpenTUI Chat Component
 *
 * A simple chat interface with:
 * - Scrollable conversation history at top
 * - Input field at bottom
 * - Escape key to cancel streaming or exit
 */
import { createCliRenderer, type KeyEvent } from "@opentui/core"
import { createRoot } from "@opentui/react/renderer"
import { useKeyboard } from "@opentui/react"
import { useState } from "react"

// =============================================================================
// Types
// =============================================================================

export interface Message {
  role: "user" | "assistant" | "system"
  content: string
  /** True if this was an interrupted response */
  interrupted?: boolean
}

export interface ChatAppProps {
  messages: Message[]
  initialMessageCount: number
  streamingText: string
  isStreaming: boolean
  onSubmit: (text: string) => void
  onEscape: () => void
  contextName: string
}

// =============================================================================
// Colors
// =============================================================================

const colors = {
  cyan: "#00FFFF",
  green: "#00FF00",
  dimCyan: "#5F8787",
  dimGreen: "#5F875F",
  dim: "#666666",
  red: "#FF6666",
  dimRed: "#8B4040",
  separator: "#444444",
  inputBorder: "#5F87AF"
}

// =============================================================================
// Message Renderer Component
// =============================================================================

function MessageView({
  msg,
  isDimmed
}: {
  msg: Message
  isDimmed: boolean
}) {
  const userColor = isDimmed ? colors.dimCyan : colors.cyan
  const assistantColor = isDimmed ? colors.dimGreen : colors.green
  const textColor = isDimmed ? colors.dim : undefined
  const interruptedColor = isDimmed ? colors.dimRed : colors.red

  return (
    <box flexDirection="column" marginBottom={1}>
      <text
        color={msg.role === "user" ? userColor : assistantColor}
        bold={!isDimmed}
      >
        {msg.role === "user" ? "You:" : "Assistant:"}
      </text>
      <text color={textColor}>{msg.content}</text>
      {msg.interrupted && (
        <text color={interruptedColor} italic>— interrupted —</text>
      )}
    </box>
  )
}

// =============================================================================
// Chat App Component
// =============================================================================

function ChatApp({
  messages,
  initialMessageCount,
  streamingText,
  isStreaming,
  onSubmit,
  onEscape,
  contextName
}: ChatAppProps) {
  const [inputValue, setInputValue] = useState("")

  useKeyboard((key: KeyEvent) => {
    if (key.name === "escape") {
      onEscape()
    }
  })

  const handleInputChange = (value: string) => {
    setInputValue(value)
  }

  const handleInputSubmit = (value: string) => {
    if (isStreaming) {
      onEscape()
    } else if (value.trim()) {
      onSubmit(value)
      setInputValue("")
    }
  }

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
      >
        <box flexDirection="column" width="100%" padding={1}>
          {/* History header */}
          {historyMessages.length > 0 && (
            <box flexDirection="column" marginBottom={1}>
              <text color={colors.dim}>{"─".repeat(50)}</text>
              <text color={colors.dim}>Previous conversation:</text>
              <text> </text>
            </box>
          )}

          {/* Historical messages (dimmed) */}
          {historyMessages.map((msg, idx) => (
            <MessageView key={`hist-${idx}`} msg={msg} isDimmed={true} />
          ))}

          {/* End of history separator */}
          {historyMessages.length > 0 && (
            <box marginBottom={1}>
              <text color={colors.dim}>{"─".repeat(50)}</text>
            </box>
          )}

          {/* New messages from this session (bright) */}
          {newMessages.map((msg, idx) => (
            <MessageView key={`new-${idx}`} msg={msg} isDimmed={false} />
          ))}

          {/* Streaming indicator when no text yet */}
          {isStreaming && !streamingText && (
            <box flexDirection="column" marginBottom={1}>
              <text color={colors.green} bold>Assistant:</text>
              <text color={colors.dim}>Thinking...</text>
            </box>
          )}

          {/* Streaming text with cursor */}
          {isStreaming && streamingText && (
            <box flexDirection="column" marginBottom={1}>
              <text color={colors.green} bold>Assistant:</text>
              <box flexDirection="row">
                <text>{streamingText}</text>
                <text color={colors.cyan}>▌</text>
              </box>
            </box>
          )}
        </box>
      </scrollbox>

      {/* Status bar when streaming */}
      {isStreaming && (
        <box height={1} width="100%">
          <text color={colors.red}>↵ Enter or Esc to interrupt</text>
        </box>
      )}

      {/* Input area with border */}
      <box
        height={3}
        width="100%"
        borderStyle="single"
        borderColor={colors.inputBorder}
        flexDirection="row"
        alignItems="center"
        paddingLeft={1}
        paddingRight={1}
      >
        <text color={colors.cyan} bold>You: </text>
        <input
          flexGrow={1}
          value={inputValue}
          placeholder="Type your message..."
          focused={true}
          onInput={handleInputChange}
          onSubmit={handleInputSubmit}
          backgroundColor="transparent"
        />
      </box>

      {/* Footer - right aligned */}
      <box height={1} width="100%" justifyContent="flex-end">
        <text color={colors.dim}>
          {contextName} · Esc to exit
        </text>
      </box>
    </box>
  )
}

// =============================================================================
// Chat Runner
// =============================================================================

export interface ChatCallbacks {
  onSubmit: (text: string) => void
  onEscape: () => void
}

export interface ChatState {
  messages: Message[]
  initialMessageCount: number
  streamingText: string
  isStreaming: boolean
}

export async function runOpenTUIChat(
  contextName: string,
  initialMessages: Message[],
  callbacks: ChatCallbacks
) {
  const renderer = await createCliRenderer()
  const root = createRoot(renderer)

  let state: ChatState = {
    messages: initialMessages,
    initialMessageCount: initialMessages.length,
    streamingText: "",
    isStreaming: false
  }

  const render = () => {
    root.render(
      <ChatApp
        messages={state.messages}
        initialMessageCount={state.initialMessageCount}
        streamingText={state.streamingText}
        isStreaming={state.isStreaming}
        onSubmit={callbacks.onSubmit}
        onEscape={callbacks.onEscape}
        contextName={contextName}
      />
    )
  }

  render()
  renderer.start()

  return {
    addMessage(msg: Message) {
      state = { ...state, messages: [...state.messages, msg] }
      render()
    },

    startStreaming() {
      state = { ...state, isStreaming: true, streamingText: "" }
      render()
    },

    appendStreamingText(delta: string) {
      state = { ...state, streamingText: state.streamingText + delta }
      render()
    },

    /** End streaming. Pass content to add as message, interrupted flag for cancelled responses. */
    endStreaming(finalContent?: string, interrupted?: boolean) {
      const messages = finalContent
        ? [...state.messages, { role: "assistant" as const, content: finalContent, interrupted }]
        : state.messages
      state = { ...state, isStreaming: false, streamingText: "", messages }
      render()
    },

    cleanup() {
      root.unmount()
      renderer.stop()
    },

    getState() {
      return state
    }
  }
}

export type ChatController = Awaited<ReturnType<typeof runOpenTUIChat>>
