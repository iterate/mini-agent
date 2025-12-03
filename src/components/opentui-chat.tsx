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
// Chat App Component
// =============================================================================

function ChatApp({
  messages,
  streamingText,
  isStreaming,
  onSubmit,
  onEscape,
  contextName
}: ChatAppProps) {
  const [inputValue, setInputValue] = useState("")
  const [inputFocused] = useState(true)

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
    if (value.trim()) {
      onSubmit(value)
      setInputValue("")
    }
  }

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
    >
      {/* Header */}
      <box height={1} width="100%">
        <text color="#888888">
          Chat - Context: {contextName} | Press Escape to {isStreaming ? "cancel" : "exit"}
        </text>
      </box>

      {/* Conversation history */}
      <scrollbox
        flexGrow={1}
        width="100%"
        borderStyle="single"
        borderColor="#444444"
        focused={!inputFocused}
      >
        <box flexDirection="column" width="100%" padding={1}>
          {messages.map((msg, idx) => (
            <box key={idx} flexDirection="column" marginBottom={1}>
              <text
                color={msg.role === "user" ? "#00FFFF" : msg.role === "assistant" ? "#00FF00" : "#888888"}
                bold
              >
                {msg.role === "user" ? "You:" : msg.role === "assistant" ? "Assistant:" : "System:"}
              </text>
              <text>{msg.content}</text>
            </box>
          ))}

          {/* Streaming text with cursor */}
          {isStreaming && streamingText && (
            <box flexDirection="column" marginBottom={1}>
              <text color="#00FF00" bold>Assistant:</text>
              <text>{streamingText}<text color="#00FFFF">▌</text></text>
            </box>
          )}

          {/* Streaming indicator when no text yet */}
          {isStreaming && !streamingText && (
            <box>
              <text color="#888888">Thinking...</text>
            </box>
          )}
        </box>
      </scrollbox>

      {/* Input area */}
      <box height={3} width="100%" flexDirection="row" alignItems="center" padding={1}>
        <text color="#00FFFF" bold>You: </text>
        <input
          flexGrow={1}
          value={inputValue}
          placeholder={isStreaming ? "(streaming...)" : "Type your message..."}
          focused={inputFocused && !isStreaming}
          onInput={handleInputChange}
          onSubmit={handleInputSubmit}
          backgroundColor="transparent"
          focusedBackgroundColor="#222222"
        />
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
    streamingText: "",
    isStreaming: false
  }

  const render = () => {
    root.render(
      <ChatApp
        messages={state.messages}
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
