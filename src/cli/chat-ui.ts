/**
 * Chat UI Service
 *
 * Interactive chat with interruptible LLM streaming.
 * Return during streaming interrupts (with optional new message); Escape exits.
 */
import type { AiError, LanguageModel } from "@effect/ai"
import type { Error as PlatformError, FileSystem } from "@effect/platform"
import { Cause, Context, Effect, Fiber, Layer, Mailbox, Stream } from "effect"
import { is } from "effect/Schema"
import {
  AssistantMessageEvent,
  type ContextEvent,
  LLMRequestInterruptedEvent,
  TextDeltaEvent,
  UserMessageEvent
} from "../context.model.ts"
import { ContextService } from "../context.service.ts"
import type { ContextLoadError, ContextSaveError } from "../errors.ts"
import type { CurrentLlmConfig } from "../llm-config.ts"
import { streamLLMResponse } from "../llm.ts"
import { type ChatController, runOpenTUIChat } from "./components/opentui-chat.tsx"

type ChatSignal =
  | { readonly _tag: "Input"; readonly text: string }
  | { readonly _tag: "Exit" }

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
              mailbox.unsafeOffer({ _tag: "Input", text })
            },
            onExit: () => {
              mailbox.unsafeOffer({ _tag: "Exit" })
            }
          })
        )

        yield* runChatLoop(contextName, contextService, chat, mailbox).pipe(
          Effect.catchAll((error) => Effect.logError("Chat error", { error }).pipe(Effect.as(undefined))),
          Effect.catchAllCause((cause) =>
            Cause.isInterruptedOnly(cause) ? Effect.void : Effect.logError("Chat loop error", cause)
          ),
          Effect.ensuring(Effect.sync(() => chat.cleanup()))
        )
      })

      return ChatUI.of({ runChat })
    })
  )

  static readonly testLayer = Layer.sync(ChatUI, () => ChatUI.of({ runChat: () => Effect.void }))
}

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
    while (true) {
      const result = yield* runChatTurn(contextName, contextService, chat, mailbox, null)
      if (result._tag === "exit") {
        return
      }
    }
  })()

type TurnResult =
  | { readonly _tag: "continue" }
  | { readonly _tag: "exit" }

const runChatTurn = (
  contextName: string,
  contextService: Context.Tag.Service<typeof ContextService>,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>,
  pendingMessage: string | null
): Effect.Effect<
  TurnResult,
  AiError.AiError | PlatformError.PlatformError | ContextLoadError | ContextSaveError,
  LanguageModel.LanguageModel | FileSystem.FileSystem | CurrentLlmConfig
> =>
  Effect.fn("ChatUI.runChatTurn")(function*() {
    // Get message either from pending or by waiting for input
    let userMessage: string
    if (pendingMessage !== null) {
      userMessage = pendingMessage
    } else {
      const signal = yield* mailbox.take.pipe(
        Effect.catchTag("NoSuchElementException", () => Effect.succeed({ _tag: "Exit" } as const))
      )
      if (signal._tag === "Exit") {
        return { _tag: "exit" } as const
      }
      userMessage = signal.text
    }

    // Empty message = just interrupt (already handled), continue waiting
    if (!userMessage) {
      return { _tag: "continue" } as const
    }

    const userEvent = new UserMessageEvent({ content: userMessage })

    yield* contextService.persistEvent(contextName, userEvent)
    chat.addEvent(userEvent)

    const events = yield* contextService.load(contextName)
    let accumulatedText = ""

    const streamFiber = yield* Effect.fork(
      streamLLMResponse(events).pipe(
        Stream.tap((event: ContextEvent) =>
          Effect.sync(() => {
            if (is(TextDeltaEvent)(event)) {
              accumulatedText += event.delta
              chat.addEvent(event)
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

    const result = yield* awaitStreamCompletion(streamFiber, mailbox)

    if (result._tag === "completed") {
      return { _tag: "continue" } as const
    }

    if (result._tag === "exit") {
      if (accumulatedText.length > 0) {
        const interruptedEvent = new LLMRequestInterruptedEvent({
          requestId: crypto.randomUUID(),
          reason: "user_cancel",
          partialResponse: accumulatedText
        })
        yield* contextService.persistEvent(contextName, interruptedEvent)
        chat.addEvent(interruptedEvent)
      }
      return { _tag: "exit" } as const
    }

    // result._tag === "interrupted" - user hit return during streaming
    if (accumulatedText.length > 0) {
      const interruptedEvent = new LLMRequestInterruptedEvent({
        requestId: crypto.randomUUID(),
        reason: result.newMessage ? "user_new_message" : "user_cancel",
        partialResponse: accumulatedText
      })
      yield* contextService.persistEvent(contextName, interruptedEvent)
      chat.addEvent(interruptedEvent)
    }

    if (result.newMessage) {
      return yield* runChatTurn(contextName, contextService, chat, mailbox, result.newMessage)
    }

    return { _tag: "continue" } as const
  })()

type StreamResult =
  | { readonly _tag: "completed" }
  | { readonly _tag: "exit" }
  | { readonly _tag: "interrupted"; readonly newMessage: string | null }

const awaitStreamCompletion = (
  fiber: Fiber.RuntimeFiber<void, AiError.AiError | PlatformError.PlatformError | ContextLoadError | ContextSaveError>,
  mailbox: Mailbox.Mailbox<ChatSignal>
): Effect.Effect<StreamResult, AiError.AiError | PlatformError.PlatformError | ContextLoadError | ContextSaveError> =>
  Effect.fn("ChatUI.awaitStreamCompletion")(function*() {
    const waitForFiber = Fiber.join(fiber).pipe(Effect.as({ _tag: "completed" } as StreamResult))
    const waitForInterrupt = Effect.gen(function*() {
      const signal = yield* mailbox.take.pipe(
        Effect.catchTag("NoSuchElementException", () => Effect.succeed({ _tag: "Exit" } as const))
      )
      yield* Fiber.interrupt(fiber)
      if (signal._tag === "Exit") {
        return { _tag: "exit" } as StreamResult
      }
      return { _tag: "interrupted", newMessage: signal.text || null } as StreamResult
    })

    return yield* Effect.race(waitForFiber, waitForInterrupt)
  })()
