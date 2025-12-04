/**
 * Chat UI Service
 *
 * Interactive chat with interruptible LLM streaming.
 * Escape during streaming cancels; Escape at prompt exits.
 */
import type { AiError, LanguageModel } from "@effect/ai"
import type { Error as PlatformError, FileSystem } from "@effect/platform"
import { Cause, Context, Effect, Exit, Fiber, Layer, Mailbox, Stream } from "effect"
import { is } from "effect/Schema"
import * as fs from "node:fs"
import {
  AssistantMessageEvent,
  LLMRequestInterruptedEvent,
  TextDeltaEvent,
  UserMessageEvent
} from "../context.model.ts"
import { ContextService } from "../context.service.ts"
import type { ContextLoadError, ContextSaveError } from "../errors.ts"
import type { CurrentLlmConfig } from "../llm-config.ts"
import { streamLLMResponse } from "../llm.ts"
import { type ChatController, runOpenTUIChat } from "./components/opentui-chat.tsx"

const DEBUG_LOG = "/tmp/chat-ui-debug.log"
const debug = (msg: string) => {
  fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`)
}

// =============================================================================
// Types
// =============================================================================

type ChatSignal =
  | { readonly _tag: "Input"; readonly text: string }
  | { readonly _tag: "Escape" }
  | { readonly _tag: "Exit" }

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
      AiError.AiError | PlatformError.PlatformError | ContextLoadError | ContextSaveError,
      LanguageModel.LanguageModel | FileSystem.FileSystem | CurrentLlmConfig
    >
  }
>() {
  static readonly layer = Layer.effect(
    ChatUI,
    Effect.gen(function*() {
      const contextService = yield* ContextService

      const runChat = Effect.fn("ChatUI.runChat")(function*(contextName: string) {
        const existingEvents = yield* contextService.load(contextName)

        const mailbox = yield* Mailbox.make<ChatSignal>()

        const chat = yield* Effect.promise(() =>
          runOpenTUIChat(contextName, existingEvents, {
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
  AiError.AiError | PlatformError.PlatformError | ContextLoadError | ContextSaveError,
  LanguageModel.LanguageModel | FileSystem.FileSystem | CurrentLlmConfig
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
  AiError.AiError | PlatformError.PlatformError | ContextLoadError | ContextSaveError,
  LanguageModel.LanguageModel | FileSystem.FileSystem | CurrentLlmConfig
> =>
  Effect.fn("ChatUI.runChatTurn")(function*() {
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
    const userEvent = new UserMessageEvent({ content: userMessage })

    yield* contextService.persistEvent(contextName, userEvent)
    chat.addEvent(userEvent)
    chat.startStreaming()

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
        Stream.tap((event) =>
          Effect.gen(function*() {
            yield* contextService.persistEvent(contextName, event)
            chat.addEvent(event)
          })
        ),
        Stream.runDrain
      )
    )

    const wasInterrupted = yield* awaitStreamCompletion(streamFiber, mailbox)

    if (wasInterrupted && accumulatedText.length > 0) {
      const interruptedEvent = new LLMRequestInterruptedEvent({
        requestId: crypto.randomUUID(),
        reason: "user_cancel",
        partialResponse: accumulatedText
      })
      yield* contextService.persistEvent(contextName, interruptedEvent)
      chat.addEvent(interruptedEvent)
    }

    chat.endStreaming()
  })()

// =============================================================================
// Helpers
// =============================================================================

const awaitStreamCompletion = (
  fiber: Fiber.RuntimeFiber<void, AiError.AiError | PlatformError.PlatformError | ContextLoadError | ContextSaveError>,
  mailbox: Mailbox.Mailbox<ChatSignal>
): Effect.Effect<boolean, AiError.AiError | PlatformError.PlatformError | ContextLoadError | ContextSaveError> =>
  Effect.fn("ChatUI.awaitStreamCompletion")(function*() {
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
      }
    })

    return yield* Effect.race(waitForFiber, waitForEscape)
  })()
