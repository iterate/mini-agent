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
}

export interface ChatAppProps {
  /** Initial messages to display */
  messages: Message[]
  /** How many messages were loaded from history (shown dimmed) */
  initialMessageCount: number
  /** Current streaming text (shown with cursor) */
  streamingText: string
  /** Whether LLM is currently streaming */
  isStreaming: boolean
  /** Called when user submits input */
  onSubmit: (text: string) => void
  /** Called when user presses Escape */
  onEscape: () => void
  /** Context name to display */
  contextName: string
}

// =============================================================================
// Colors (matching cli.ts non-interactive mode)
// =============================================================================

const colors = {
  cyan: "#00FFFF",
  green: "#00FF00",
  dimCyan: "#5F8787",    // dimmed cyan for history
  dimGreen: "#5F875F",   // dimmed green for history
  dim: "#666666",        // dimmed text
  red: "#FF6666",        // streaming indicator
  separator: "#444444"
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

  // Handle keyboard input
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
      // During streaming, Enter interrupts
      onEscape()
    } else if (value.trim()) {
      onSubmit(value)
      setInputValue("")
    }
  }

  // Messages loaded from history (shown dimmed)
  const historyMessages = messages.slice(0, initialMessageCount)
  // Messages added this session (shown bright)
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
          {/* History separator if there's history */}
          {historyMessages.length > 0 && (
            <box flexDirection="column" marginBottom={1}>
              <text color={colors.dim}>{"─".repeat(50)}</text>
              <text color={colors.dim}>Previous conversation:</text>
              <text> </text>
            </box>
          )}

          {/* Historical messages (dimmed) */}
          {historyMessages.map((msg, idx) => (
            <box key={idx} flexDirection="column" marginBottom={1}>
              <text
                color={msg.role === "user" ? colors.dimCyan : colors.dimGreen}
              >
                {msg.role === "user" ? "You:" : "Assistant:"}
              </text>
              <text color={colors.dim}>{msg.content}</text>
            </box>
          ))}

          {/* End of history separator */}
          {historyMessages.length > 0 && (
            <box marginBottom={1}>
              <text color={colors.dim}>{"─".repeat(50)}</text>
            </box>
          )}

          {/* New messages from this session (bright colors) */}
          {newMessages.map((msg, idx) => (
            <box key={`new-${idx}`} flexDirection="column" marginBottom={1}>
              <text
                color={msg.role === "user" ? colors.cyan : colors.green}
                bold
              >
                {msg.role === "user" ? "You:" : "Assistant:"}
              </text>
              <text>{msg.content}</text>
            </box>
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

      {/* Input area - single line */}
      <box height={1} width="100%" flexDirection="row">
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

      {/* Footer */}
      <box height={1} width="100%">
        <text color={colors.dim}>
          Context: {contextName} | Esc to exit
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
  initialMessageCount: number  // How many messages were loaded from history
  streamingText: string
  isStreaming: boolean
}

/**
 * Run the OpenTUI chat interface.
 * Returns controls to update state and cleanup.
 */
export async function runOpenTUIChat(
  contextName: string,
  initialMessages: Message[],
  callbacks: ChatCallbacks
) {
  const renderer = await createCliRenderer()
  const root = createRoot(renderer)

  // State management
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

  // Initial render
  render()
  renderer.start()

  return {
    /** Add a message to the conversation */
    addMessage(msg: Message) {
      state = { ...state, messages: [...state.messages, msg] }
      render()
    },

    /** Start streaming mode */
    startStreaming() {
      state = { ...state, isStreaming: true, streamingText: "" }
      render()
    },

    /** Append text to the streaming buffer */
    appendStreamingText(delta: string) {
      state = { ...state, streamingText: state.streamingText + delta }
      render()
    },

    /** End streaming and optionally add the final message */
    endStreaming(finalContent?: string) {
      const messages = finalContent
        ? [...state.messages, { role: "assistant" as const, content: finalContent }]
        : state.messages
      state = { ...state, isStreaming: false, streamingText: "", messages }
      render()
    },

    /** Cleanup and exit */
    cleanup() {
      root.unmount()
      renderer.stop()
    },

    /** Get current state */
    getState() {
      return state
    }
  }
}

export type ChatController = Awaited<ReturnType<typeof runOpenTUIChat>>
