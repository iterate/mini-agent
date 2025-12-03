/**
 * Chat UI Service
 *
 * Provides an interactive chat interface with interruptible LLM requests.
 * Uses OpenTUI for the terminal UI with two panels:
 * - Conversation history at the top (scrollable)
 * - Input field at the bottom
 *
 * Features:
 * - Escape key during streaming cancels current request
 * - Partial responses are persisted as LLMRequestInterruptedEvent
 */
import type { AiError, LanguageModel } from "@effect/ai"
import { Context, Effect, Fiber, Layer, Ref, Schema, Stream } from "effect"
import {
  runOpenTUIChat,
  type ChatController,
  type Message
} from "./components/opentui-chat.tsx"
import {
  AssistantMessageEvent,
  LLMRequestInterruptedEvent,
  type PersistedEvent,
  TextDeltaEvent,
  UserMessageEvent
} from "./context.model.ts"
import { ContextService } from "./context.service.ts"
import type { ContextLoadError, ContextSaveError } from "./errors.ts"
import { streamLLMResponseWithStart } from "./llm.ts"

// =============================================================================
// Chat UI Service
// =============================================================================

export class ChatUI extends Context.Tag("@app/ChatUI")<
  ChatUI,
  {
    /**
     * Run an interactive chat session.
     *
     * @param contextName - The context to use for the conversation
     * @returns Effect that runs until user exits (Escape at prompt)
     */
    readonly runChat: (
      contextName: string
    ) => Effect.Effect<
      void,
      AiError.AiError | ContextLoadError | ContextSaveError,
      LanguageModel.LanguageModel
    >
  }
>() {
  static readonly layer = Layer.effect(
    ChatUI,
    Effect.gen(function*() {
      const contextService = yield* ContextService

      const runChat = (contextName: string) =>
        Effect.gen(function*() {
          // Load existing events
          const existingEvents = yield* contextService.load(contextName)
          const initialMessages = eventsToMessages(existingEvents)

          // Mutable refs for callback communication
          const pendingInputRef = yield* Ref.make<string | null>(null)
          const escapeRequestedRef = yield* Ref.make(false)
          const isStreamingRef = yield* Ref.make(false)

          // Start the OpenTUI chat
          const chat = yield* Effect.promise(() =>
            runOpenTUIChat(contextName, initialMessages, {
              onSubmit: (text) => {
                Effect.runSync(Ref.set(pendingInputRef, text))
              },
              onEscape: () => {
                // Just set the flag - logic handled in Effect-land
                Effect.runSync(Ref.set(escapeRequestedRef, true))
              }
            })
          )

          // Main chat loop - run until exit requested
          const chatLoop = Effect.gen(function*() {
            let shouldContinue = true
            while (shouldContinue) {
              const result = yield* runChatTurn(
                contextName,
                contextService,
                chat,
                pendingInputRef,
                escapeRequestedRef,
                isStreamingRef
              )
              if (result === EXIT_REQUESTED) {
                shouldContinue = false
              }
            }
          })

          yield* chatLoop.pipe(
            Effect.catchAll(() => Effect.void),
            Effect.ensuring(Effect.sync(() => chat.cleanup()))
          )
        })

      return ChatUI.of({ runChat })
    })
  )

  static readonly testLayer = Layer.sync(ChatUI, () =>
    ChatUI.of({
      runChat: () => Effect.void
    })
  )
}

// =============================================================================
// Chat Turn Logic
// =============================================================================

/** Sentinel value to signal exit was requested during input wait */
const EXIT_REQUESTED = Symbol("EXIT_REQUESTED")

const runChatTurn = (
  contextName: string,
  contextService: Context.Tag.Service<typeof ContextService>,
  chat: ChatController,
  pendingInputRef: Ref.Ref<string | null>,
  escapeRequestedRef: Ref.Ref<boolean>,
  isStreamingRef: Ref.Ref<boolean>
): Effect.Effect<
  void | typeof EXIT_REQUESTED,
  AiError.AiError | ContextLoadError | ContextSaveError,
  LanguageModel.LanguageModel
> =>
  Effect.gen(function*() {
    // Wait for user input (poll-based), also checking for exit
    let userMessage: string | null = null
    while (userMessage === null) {
      yield* Effect.sleep(50)

      // Check if escape was requested while not streaming (= exit)
      const escapeRequested = yield* Ref.get(escapeRequestedRef)
      if (escapeRequested) {
        yield* Ref.set(escapeRequestedRef, false)
        return EXIT_REQUESTED
      }

      userMessage = yield* Ref.get(pendingInputRef)
    }

    // Reset refs
    yield* Ref.set(pendingInputRef, null)
    yield* Ref.set(escapeRequestedRef, false)
    yield* Ref.set(isStreamingRef, true)

    const requestId = crypto.randomUUID()

    // Persist user message
    const userEvent = new UserMessageEvent({ content: userMessage })
    yield* contextService.persistEvent(contextName, userEvent)

    // Update chat UI with user message
    chat.addMessage({ role: "user", content: userMessage })
    chat.startStreaming()

    // Load all events for LLM
    const existingEvents = yield* contextService.load(contextName)

    // Stream LLM response
    let accumulatedText = ""

    const streamFiber = yield* Effect.fork(
      streamLLMResponseWithStart(existingEvents, requestId).pipe(
        Stream.tap((event) =>
          Effect.gen(function*() {
            if (Schema.is(TextDeltaEvent)(event)) {
              accumulatedText += event.delta
              chat.appendStreamingText(event.delta)
            } else if (Schema.is(AssistantMessageEvent)(event)) {
              yield* contextService.persistEvent(contextName, event)
            }
          })
        ),
        Stream.runDrain
      )
    )

    // Wait for stream to complete or cancel (poll-based)
    let completed = false
    while (!completed) {
      yield* Effect.sleep(50)
      const escapeRequested = yield* Ref.get(escapeRequestedRef)
      const fiberStatus = yield* Fiber.status(streamFiber)

      if (escapeRequested) {
        yield* Fiber.interrupt(streamFiber)

        // Persist interrupted event and show partial content
        if (accumulatedText.length > 0) {
          const interruptEvent = new LLMRequestInterruptedEvent({
            requestId,
            reason: "user_cancel",
            partialResponse: accumulatedText
          })
          yield* contextService.persistEvent(contextName, interruptEvent)
          // Show partial response with interrupted marker
          chat.endStreaming(accumulatedText, true)
        } else {
          chat.endStreaming()
        }

        yield* Ref.set(escapeRequestedRef, false)
        completed = true
      } else if (fiberStatus._tag === "Done") {
        chat.endStreaming(accumulatedText)
        completed = true
      }
    }

    yield* Ref.set(isStreamingRef, false)
  })

// =============================================================================
// Helpers
// =============================================================================

/** Convert persisted events to Message format for display */
const eventsToMessages = (events: ReadonlyArray<PersistedEvent>): Message[] =>
  events
    .filter((e) =>
      e._tag === "UserMessage" ||
      e._tag === "AssistantMessage" ||
      e._tag === "LLMRequestInterrupted"
    )
    .map((e) => {
      if (e._tag === "UserMessage") {
        return { role: "user" as const, content: e.content }
      } else if (e._tag === "AssistantMessage") {
        return { role: "assistant" as const, content: e.content }
      } else {
        // LLMRequestInterrupted
        return { role: "assistant" as const, content: e.partialResponse, interrupted: true }
      }
    })
