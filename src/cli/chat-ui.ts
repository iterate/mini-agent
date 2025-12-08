/**
 * Chat UI Service
 *
 * Interactive chat with interruptible LLM streaming using MiniAgent actor.
 * Return during streaming interrupts (with optional new message); Escape exits.
 */
import { DateTime, Effect, Fiber, Mailbox, Option, Stream } from "effect"
import { AgentService } from "../agent-service.ts"
import {
  type AgentName,
  type ContextSaveError,
  makeEventId,
  type ReducerError,
  UserMessageEvent
} from "../domain.ts"
import { deriveContextMetadata } from "./event-context.ts"
import { type ChatController, runOpenTUIChat } from "./components/opentui-chat.tsx"

type ChatSignal =
  | { readonly _tag: "Input"; readonly text: string }
  | { readonly _tag: "Exit" }

export class ChatUI extends Effect.Service<ChatUI>()("@mini-agent/ChatUI", {
  effect: Effect.gen(function*() {
    const agentService = yield* AgentService

    const runChat = Effect.fn("ChatUI.runChat")(function*(agentNameInput: string) {
      const agentName = agentNameInput as AgentName

      // Get existing events for history display
      const existingEvents = yield* agentService.getEvents({ agentName })

      // Unbounded mailbox - unsafeOffer always succeeds (idiomatic Effect pattern)
      const mailbox = yield* Mailbox.make<ChatSignal>()

      const chat = yield* Effect.promise(() =>
        runOpenTUIChat(agentNameInput, existingEvents, {
          onSubmit: (text) => {
            mailbox.unsafeOffer({ _tag: "Input", text })
          },
          onExit: () => {
            mailbox.unsafeOffer({ _tag: "Exit" })
          }
        })
      )

      // Subscribe to agent events and forward to UI
      const eventStream = yield* agentService.tapEventStream({ agentName })
      const subscriptionFiber = yield* eventStream.pipe(
        Stream.runForEach((event) => Effect.sync(() => chat.addEvent(event))),
        Effect.fork
      )

      yield* runChatLoop(agentName, chat, mailbox, agentService).pipe(
        Effect.catchAllCause(() => Effect.void),
        Effect.ensuring(
          Effect.gen(function*() {
            yield* Fiber.interrupt(subscriptionFiber)
            yield* agentService.endSession({ agentName })
            chat.cleanup()
          })
        )
      )
    })

    return { runChat }
  }),
  dependencies: [AgentService.Default]
}) {}

const runChatLoop = (
  agentName: AgentName,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>,
  agentService: AgentService
): Effect.Effect<void, ReducerError | ContextSaveError> =>
  Effect.fn("ChatUI.runChatLoop")(function*() {
    while (true) {
      const result = yield* runChatTurn(agentName, chat, mailbox, agentService)
      if (result._tag === "exit") {
        return
      }
    }
  })()

type TurnResult =
  | { readonly _tag: "continue" }
  | { readonly _tag: "exit" }

const runChatTurn = (
  agentName: AgentName,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>,
  agentService: AgentService
): Effect.Effect<TurnResult, ReducerError | ContextSaveError> =>
  Effect.fn("ChatUI.runChatTurn")(function*() {
    const signal = yield* mailbox.take.pipe(
      Effect.catchTag("NoSuchElementException", () => Effect.succeed({ _tag: "Exit" } as const))
    )

    if (signal._tag === "Exit") {
      return { _tag: "exit" } as const
    }

    const userMessage = signal.text.trim()

    // Empty message = just interrupt, continue waiting
    if (!userMessage) {
      return { _tag: "continue" } as const
    }

    const events = yield* agentService.getEvents({ agentName })
    const { contextName, nextEventNumber } = deriveContextMetadata(agentName, events)

    // Create user event with triggersAgentTurn=true to start LLM turn
    const userEvent = new UserMessageEvent({
      id: makeEventId(contextName, nextEventNumber),
      timestamp: DateTime.unsafeNow(),
      agentName,
      parentEventId: Option.none(),
      triggersAgentTurn: true,
      content: userMessage
    })

    // Add event to agent - this will broadcast to subscription and trigger LLM turn
    yield* agentService.addEvents({ agentName, events: [userEvent] })

    // Wait for turn to complete or user interrupt
    const result = yield* awaitTurnCompletion(agentName, mailbox, agentService)

    if (result._tag === "exit") {
      return { _tag: "exit" } as const
    }

    if (result._tag === "interrupted") {
      if (result.newMessage) {
        return yield* runChatTurnWithPending(agentName, chat, mailbox, result.newMessage, agentService)
      } else {
        yield* agentService.interruptTurn({ agentName })
      }
    }

    return { _tag: "continue" } as const
  })()

const runChatTurnWithPending = (
  agentName: AgentName,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>,
  pendingMessage: string,
  agentService: AgentService
): Effect.Effect<TurnResult, ReducerError | ContextSaveError> =>
  Effect.gen(function*() {
    const events = yield* agentService.getEvents({ agentName })
    const { contextName, nextEventNumber } = deriveContextMetadata(agentName, events)

    const userEvent = new UserMessageEvent({
      id: makeEventId(contextName, nextEventNumber),
      timestamp: DateTime.unsafeNow(),
      agentName,
      parentEventId: Option.none(),
      triggersAgentTurn: true,
      content: pendingMessage
    })

    yield* agentService.addEvents({ agentName, events: [userEvent] })

    const result = yield* awaitTurnCompletion(agentName, mailbox, agentService)

    if (result._tag === "exit") {
      return { _tag: "exit" } as const
    }

    if (result._tag === "interrupted" && result.newMessage) {
      return yield* runChatTurnWithPending(agentName, chat, mailbox, result.newMessage, agentService)
    }

    return { _tag: "continue" } as const
  })

type TurnCompletionResult =
  | { readonly _tag: "completed" }
  | { readonly _tag: "exit" }
  | { readonly _tag: "interrupted"; readonly newMessage: string | null }

const awaitTurnCompletion = (
  agentName: AgentName,
  mailbox: Mailbox.Mailbox<ChatSignal>,
  agentService: AgentService
): Effect.Effect<TurnCompletionResult> =>
  Effect.fn("ChatUI.awaitTurnCompletion")(function*() {
    // Wait for either: turn completes OR user interrupts
    const waitForIdle = Effect.gen(function*() {
      // Poll for idle state
      while (true) {
        const isIdle = yield* agentService.isIdle({ agentName })
        if (isIdle) {
          return { _tag: "completed" } as TurnCompletionResult
        }
        yield* Effect.sleep("50 millis")
      }
    })

    const waitForInterrupt = Effect.gen(function*() {
      const signal = yield* mailbox.take.pipe(
        Effect.catchTag("NoSuchElementException", () => Effect.succeed({ _tag: "Exit" } as const))
      )
      if (signal._tag === "Exit") {
        return { _tag: "exit" } as TurnCompletionResult
      }
      return { _tag: "interrupted", newMessage: signal.text || null } as TurnCompletionResult
    })

    return yield* Effect.race(waitForIdle, waitForInterrupt)
  })()
