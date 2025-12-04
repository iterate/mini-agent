/**
 * Chat UI Service
 *
 * Interactive chat with interruptible LLM streaming.
 * Escape during streaming cancels; Escape at prompt exits.
 */
import type { AiError, LanguageModel } from "@effect/ai"
import { Context, Effect, Fiber, Layer, Queue, Stream } from "effect"
import { is } from "effect/Schema"
import { type ChatController, type Message, runOpenTUIChat } from "./components/opentui-chat.tsx"
import {
  AssistantMessageEvent,
  LLMRequestInterruptedEvent,
  type PersistedEvent,
  TextDeltaEvent,
  UserMessageEvent
} from "./context.model.ts"
import { ContextService } from "./context.service.ts"
import type { ContextLoadError, ContextSaveError } from "./errors.ts"
import { streamLLMResponse } from "./llm.ts"

// =============================================================================
// Types
// =============================================================================

/** Signal from UI callbacks to Effect-land */
type ChatSignal =
  | { readonly _tag: "Input"; readonly text: string }
  | { readonly _tag: "Escape" }

/** Sentinel value to signal exit */
const EXIT_REQUESTED = Symbol("EXIT_REQUESTED")

// =============================================================================
// Chat UI Service
// =============================================================================

export class ChatUI extends Context.Tag("@app/ChatUI")<
  ChatUI,
  {
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

      const runChat = Effect.fn("ChatUI.runChat")(function*(contextName: string) {
        const existingEvents = yield* contextService.load(contextName)
        const initialMessages = eventsToMessages(existingEvents)

        // Queue for callback-to-Effect communication (no polling needed)
        const signalQueue = yield* Queue.unbounded<ChatSignal>()

        const chat = yield* Effect.promise(() =>
          runOpenTUIChat(contextName, initialMessages, {
            onSubmit: (text) => {
              Effect.runFork(Queue.offer(signalQueue, { _tag: "Input", text }))
            },
            onEscape: () => {
              Effect.runFork(Queue.offer(signalQueue, { _tag: "Escape" }))
            }
          })
        )

        yield* runChatLoop(contextName, contextService, chat, signalQueue).pipe(
          Effect.catchAll(() => Effect.void),
          Effect.ensuring(Effect.sync(() => chat.cleanup()))
        )
      })

      return ChatUI.of({ runChat })
    })
  )

  static readonly testLayer = Layer.sync(ChatUI, () => ChatUI.of({ runChat: () => Effect.void }))
}

// =============================================================================
// Chat Loop
// =============================================================================

const runChatLoop = (
  contextName: string,
  contextService: Context.Tag.Service<typeof ContextService>,
  chat: ChatController,
  signalQueue: Queue.Queue<ChatSignal>
): Effect.Effect<
  void,
  AiError.AiError | ContextLoadError | ContextSaveError,
  LanguageModel.LanguageModel
> =>
  Effect.fn("ChatUI.runChatLoop")(function*() {
    while (true) {
      const result = yield* runChatTurn(contextName, contextService, chat, signalQueue)
      if (result === EXIT_REQUESTED) return
    }
  })()

const runChatTurn = (
  contextName: string,
  contextService: Context.Tag.Service<typeof ContextService>,
  chat: ChatController,
  signalQueue: Queue.Queue<ChatSignal>
): Effect.Effect<
  void | typeof EXIT_REQUESTED,
  AiError.AiError | ContextLoadError | ContextSaveError,
  LanguageModel.LanguageModel
> =>
  Effect.fn("ChatUI.runChatTurn")(function*() {
    // Wait for input or escape (no polling - blocks on queue)
    const signal = yield* Queue.take(signalQueue)
    if (signal._tag === "Escape") return EXIT_REQUESTED

    const userMessage = signal.text

    // Persist and display user message
    yield* contextService.persistEvent(contextName, new UserMessageEvent({ content: userMessage }))
    chat.addMessage({ role: "user", content: userMessage })
    chat.startStreaming()

    // Stream LLM response
    const events = yield* contextService.load(contextName)
    let accumulatedText = ""

    const streamFiber = yield* Effect.fork(
      streamLLMResponse(events).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            if (is(TextDeltaEvent)(event)) {
              accumulatedText += event.delta
              chat.appendStreamingText(event.delta)
            }
          })
        ),
        Stream.filter(is(AssistantMessageEvent)),
        Stream.tap((event) => contextService.persistEvent(contextName, event)),
        Stream.runDrain
      )
    )

    // Wait for completion or interruption
    const wasInterrupted = yield* awaitStreamCompletion(streamFiber, signalQueue)

    if (wasInterrupted && accumulatedText.length > 0) {
      yield* contextService.persistEvent(
        contextName,
        new LLMRequestInterruptedEvent({
          requestId: crypto.randomUUID(),
          reason: "user_cancel",
          partialResponse: accumulatedText
        })
      )
      chat.endStreaming(accumulatedText, true)
    } else if (wasInterrupted) {
      chat.endStreaming()
    } else {
      chat.endStreaming(accumulatedText)
    }
  })()

// =============================================================================
// Helpers
// =============================================================================

/** Wait for stream fiber to complete or be interrupted by escape. Returns true if interrupted. */
const awaitStreamCompletion = (
  fiber: Fiber.RuntimeFiber<void, AiError.AiError | ContextLoadError | ContextSaveError>,
  signalQueue: Queue.Queue<ChatSignal>
): Effect.Effect<boolean, AiError.AiError | ContextLoadError | ContextSaveError> =>
  Effect.fn("ChatUI.awaitStreamCompletion")(function*() {
    // Race: fiber completion vs escape signal
    const waitForFiber = Fiber.join(fiber).pipe(Effect.as(false))
    const waitForEscape = Effect.gen(function*() {
      while (true) {
        const signal = yield* Queue.take(signalQueue)
        if (signal._tag === "Escape") {
          yield* Fiber.interrupt(fiber)
          return true
        }
        // Input during streaming - ignored since UI handles interrupt-then-send
      }
    })

    return yield* Effect.race(waitForFiber, waitForEscape)
  })()

/** Convert persisted events to UI messages */
const eventsToMessages = (events: ReadonlyArray<PersistedEvent>): Array<Message> =>
  events.flatMap((e): Array<Message> => {
    switch (e._tag) {
      case "UserMessage":
        return [{ role: "user", content: e.content }]
      case "AssistantMessage":
        return [{ role: "assistant", content: e.content }]
      case "LLMRequestInterrupted":
        return [{ role: "assistant", content: e.partialResponse, interrupted: true }]
      case "SystemPrompt":
        return []
    }
  })
