/**
 * Chat UI Service
 *
 * Interactive chat with interruptible LLM streaming.
 * Escape during streaming cancels; Escape at prompt exits.
 */
import type { AiError, LanguageModel } from "@effect/ai"
import { Cause, Context, Effect, Exit, Fiber, Layer, Mailbox, Stream } from "effect"
import * as fs from "node:fs"

// Debug logging to file (bypasses OpenTUI's terminal management)
const DEBUG_LOG = "/tmp/chat-ui-debug.log"
const debug = (msg: string) => {
  fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`)
}
import { is } from "effect/Schema"
import {
  AssistantMessageEvent,
  LLMRequestInterruptedEvent,
  type PersistedEvent,
  TextDeltaEvent,
  UserMessageEvent
} from "../context.model.ts"
import { ContextService } from "../context.service.ts"
import type { ContextLoadError, ContextSaveError } from "../errors.ts"
import { streamLLMResponse } from "../llm.ts"
import { type ChatController, type Message, runOpenTUIChat } from "./components/opentui-chat.tsx"

// =============================================================================
// Types
// =============================================================================

/** Signal from UI callbacks to Effect-land */
type ChatSignal =
  | { readonly _tag: "Input"; readonly text: string }
  | { readonly _tag: "Escape" }
  | { readonly _tag: "Exit" }

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

        // Mailbox for callback-to-Effect communication
        // unsafeOffer is designed for JS callbacks - properly wakes waiting fibers
        const mailbox = yield* Mailbox.make<ChatSignal>()

        const chat = yield* Effect.promise(() =>
          runOpenTUIChat(contextName, initialMessages, {
            onSubmit: (text) => {
              debug(`onSubmit callback, text: ${text}`)
              mailbox.unsafeOffer({ _tag: "Input", text })
            },
            onEscape: () => {
              debug("onEscape callback")
              mailbox.unsafeOffer({ _tag: "Escape" })
            },
            onExit: () => {
              debug("onExit callback - offering Exit to mailbox")
              // Signal exit and end the mailbox
              const offerResult = mailbox.unsafeOffer({ _tag: "Exit" })
              debug(`mailbox.unsafeOffer returned: ${offerResult}`)
              const doneResult = mailbox.unsafeDone(Exit.void)
              debug(`mailbox.unsafeDone returned: ${doneResult}`)
            }
          })
        )

        yield* runChatLoop(contextName, contextService, chat, mailbox).pipe(
          Effect.tap(() => Effect.sync(() => debug("runChatLoop completed normally"))),
          Effect.catchAll((e) => {
            debug(`runChatLoop catchAll error: ${e}`)
            return Effect.void
          }),
          Effect.catchAllCause((cause) => {
            debug(`runChatLoop catchAllCause, isInterruptedOnly: ${Cause.isInterruptedOnly(cause)}`)
            return Cause.isInterruptedOnly(cause) ? Effect.void : Effect.logError("Chat loop error", cause)
          }),
          Effect.ensuring(Effect.sync(() => {
            debug("Running cleanup")
            chat.cleanup()
            debug("Cleanup completed")
          }))
        )
        debug("runChat completed")
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
  mailbox: Mailbox.Mailbox<ChatSignal>
): Effect.Effect<
  void,
  AiError.AiError | ContextLoadError | ContextSaveError,
  LanguageModel.LanguageModel
> =>
  Effect.fn("ChatUI.runChatLoop")(function*() {
    debug("runChatLoop starting")
    while (true) {
      debug("runChatLoop waiting for turn result")
      const result = yield* runChatTurn(contextName, contextService, chat, mailbox)
      debug(`runChatLoop got result: ${result === EXIT_REQUESTED ? "EXIT_REQUESTED" : "continue"}`)
      if (result === EXIT_REQUESTED) {
        debug("runChatLoop exiting")
        return
      }
    }
  })()

const runChatTurn = (
  contextName: string,
  contextService: Context.Tag.Service<typeof ContextService>,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>
): Effect.Effect<
  void | typeof EXIT_REQUESTED,
  AiError.AiError | ContextLoadError | ContextSaveError,
  LanguageModel.LanguageModel
> =>
  Effect.fn("ChatUI.runChatTurn")(function*() {
    // Wait for input or escape/exit (blocks on mailbox.take)
    debug("runChatTurn waiting on mailbox.take")
    const signal = yield* mailbox.take.pipe(
      Effect.tap((s) => Effect.sync(() => debug(`mailbox.take received: ${JSON.stringify(s)}`))),
      Effect.catchTag("NoSuchElementException", () => {
        debug("mailbox.take got NoSuchElementException (mailbox done)")
        return Effect.succeed({ _tag: "Exit" } as const)
      })
    )
    debug(`runChatTurn got signal: ${JSON.stringify(signal)}`)
    if (signal._tag === "Escape" || signal._tag === "Exit") {
      debug("runChatTurn returning EXIT_REQUESTED")
      return EXIT_REQUESTED
    }

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
    const wasInterrupted = yield* awaitStreamCompletion(streamFiber, mailbox)

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
  mailbox: Mailbox.Mailbox<ChatSignal>
): Effect.Effect<boolean, AiError.AiError | ContextLoadError | ContextSaveError> =>
  Effect.fn("ChatUI.awaitStreamCompletion")(function*() {
    // Race: fiber completion vs escape signal
    const waitForFiber = Fiber.join(fiber).pipe(Effect.as(false))
    const waitForEscape = Effect.gen(function*() {
      while (true) {
        const signal = yield* mailbox.take.pipe(
          Effect.catchTag("NoSuchElementException", () => Effect.succeed({ _tag: "Exit" } as const))
        )
        if (signal._tag === "Escape" || signal._tag === "Exit") {
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
