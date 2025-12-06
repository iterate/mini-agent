/**
 * Chat UI Service
 *
 * Interactive chat with interruptible LLM streaming.
 * Return during streaming interrupts (with optional new message); Escape exits.
 */
import type { AiError, LanguageModel } from "@effect/ai"
import type { Error as PlatformError, FileSystem } from "@effect/platform"
import { Cause, Context, Effect, Fiber, Layer, Mailbox, Schema, Stream } from "effect"
import {
  AssistantMessageEvent,
  CodemodeResultEvent,
  CodemodeValidationErrorEvent,
  LLMRequestInterruptedEvent,
  TextDeltaEvent,
  UserMessageEvent
} from "../context.model.ts"
import { type ContextOrCodemodeEvent, ContextService } from "../context.service.ts"
import type { CodeStorageError, ContextLoadError, ContextSaveError } from "../errors.ts"
import type { CurrentLlmConfig } from "../llm-config.ts"
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
      AiError.AiError | PlatformError.PlatformError | ContextLoadError | ContextSaveError | CodeStorageError,
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
  AiError.AiError | PlatformError.PlatformError | ContextLoadError | ContextSaveError | CodeStorageError,
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

/** Check if event is displayable in the chat feed */
const isDisplayableEvent = (event: ContextOrCodemodeEvent): boolean =>
  Schema.is(TextDeltaEvent)(event) ||
  Schema.is(AssistantMessageEvent)(event) ||
  Schema.is(CodemodeResultEvent)(event) ||
  Schema.is(CodemodeValidationErrorEvent)(event)

/** Check if event triggers continuation (agent loop) */
const triggersContinuation = (event: ContextOrCodemodeEvent): boolean =>
  (Schema.is(CodemodeResultEvent)(event) && event.triggerAgentTurn === "after-current-turn") ||
  (Schema.is(CodemodeValidationErrorEvent)(event) && event.triggerAgentTurn === "after-current-turn")

const runChatTurn = (
  contextName: string,
  contextService: Context.Tag.Service<typeof ContextService>,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>,
  pendingMessage: string | null
): Effect.Effect<
  TurnResult,
  AiError.AiError | PlatformError.PlatformError | ContextLoadError | ContextSaveError | CodeStorageError,
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
    chat.addEvent(userEvent)

    let accumulatedText = ""
    let needsContinuation = false

    // Use contextService.addEvents with codemode enabled
    const eventStream = contextService.addEvents(contextName, [userEvent], { codemode: true })

    const streamFiber = yield* Effect.fork(
      eventStream.pipe(
        Stream.tap((event: ContextOrCodemodeEvent) =>
          Effect.sync(() => {
            if (Schema.is(TextDeltaEvent)(event)) {
              accumulatedText += event.delta
            }
            if (triggersContinuation(event)) {
              needsContinuation = true
            }
            if (isDisplayableEvent(event)) {
              chat.addEvent(event)
            }
          })
        ),
        Stream.runDrain
      )
    )

    const result = yield* awaitStreamCompletion(streamFiber, mailbox)

    if (result._tag === "completed") {
      // If we need continuation (codemode result with output), run another turn
      if (needsContinuation) {
        return yield* runAgentContinuation(contextName, contextService, chat, mailbox)
      }
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

/** Run agent continuation loop (for codemode results that need follow-up) */
const runAgentContinuation = (
  contextName: string,
  contextService: Context.Tag.Service<typeof ContextService>,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>
): Effect.Effect<
  TurnResult,
  AiError.AiError | PlatformError.PlatformError | ContextLoadError | ContextSaveError | CodeStorageError,
  LanguageModel.LanguageModel | FileSystem.FileSystem | CurrentLlmConfig
> =>
  Effect.fn("ChatUI.runAgentContinuation")(function*() {
    let accumulatedText = ""
    let needsContinuation = false

    // Empty input events - the persisted CodemodeResult triggers the turn
    const eventStream = contextService.addEvents(contextName, [], { codemode: true })

    const streamFiber = yield* Effect.fork(
      eventStream.pipe(
        Stream.tap((event: ContextOrCodemodeEvent) =>
          Effect.sync(() => {
            if (Schema.is(TextDeltaEvent)(event)) {
              accumulatedText += event.delta
            }
            if (triggersContinuation(event)) {
              needsContinuation = true
            }
            if (isDisplayableEvent(event)) {
              chat.addEvent(event)
            }
          })
        ),
        Stream.runDrain
      )
    )

    const result = yield* awaitStreamCompletion(streamFiber, mailbox)

    if (result._tag === "completed") {
      if (needsContinuation) {
        return yield* runAgentContinuation(contextName, contextService, chat, mailbox)
      }
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

    // Interrupted - save partial and return to wait for input
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
  fiber: Fiber.RuntimeFiber<
    void,
    AiError.AiError | PlatformError.PlatformError | ContextLoadError | ContextSaveError | CodeStorageError
  >,
  mailbox: Mailbox.Mailbox<ChatSignal>
): Effect.Effect<
  StreamResult,
  AiError.AiError | PlatformError.PlatformError | ContextLoadError | ContextSaveError | CodeStorageError
> =>
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
