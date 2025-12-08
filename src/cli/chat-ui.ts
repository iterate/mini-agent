/**
 * Chat UI Service
 *
 * Interactive chat with interruptible LLM streaming using MiniAgent actor.
 * Return during streaming interrupts (with optional new message); Escape exits.
 */
import { DateTime, Effect, Fiber, Mailbox, Option, Stream, type Scope } from "effect"
import { AgentService } from "../agent-service.ts"
import {
  type AgentName,
  type ContextName,
  type ContextSaveError,
  makeEventId,
  type ReducerError,
  UserMessageEvent
} from "../domain.ts"
import { type ChatController, runOpenTUIChat } from "./components/opentui-chat.tsx"

type ChatSignal =
  | { readonly _tag: "Input"; readonly text: string }
  | { readonly _tag: "Exit" }

export class ChatUI extends Effect.Service<ChatUI>()("@mini-agent/ChatUI", {
  effect: Effect.gen(function*() {
    const service = yield* AgentService

    const runChat = Effect.fn("ChatUI.runChat")(function*(contextName: string) {
      // Get existing events for history display
      const existingEvents = yield* service.getEvents({ agentName: contextName as AgentName })

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

      // Subscribe to agent events and forward to UI
      const eventStream = yield* service.tapEventStream({ agentName: contextName as AgentName })
      const subscriptionFiber = yield* eventStream.pipe(
        Stream.runForEach((event) => Effect.sync(() => chat.addEvent(event))),
        Effect.fork
      )

      yield* runChatLoop(service, contextName, chat, mailbox).pipe(
        Effect.catchAllCause(() => Effect.void),
        Effect.ensuring(
          Effect.gen(function*() {
            yield* Fiber.interrupt(subscriptionFiber)
            chat.cleanup()
          })
        )
      )
    })

    return { runChat }
  }),
  dependencies: []
}) {}

const runChatLoop = (
  service: AgentService,
  contextName: string,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>
): Effect.Effect<void, ReducerError | ContextSaveError> =>
  Effect.fn("ChatUI.runChatLoop")(function*() {
    while (true) {
      const result = yield* runChatTurn(service, contextName, chat, mailbox)
      if (result._tag === "exit") {
        return
      }
    }
  })()

type TurnResult =
  | { readonly _tag: "continue" }
  | { readonly _tag: "exit" }

const runChatTurn = (
  service: AgentService,
  contextName: string,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>
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

    // Get current context to build proper event
    const ctx = yield* service.getReducedContext({ agentName: contextName as AgentName })

    // Create user event with triggersAgentTurn=true to start LLM turn
    const userEvent = new UserMessageEvent({
      id: makeEventId(`${contextName}-v1` as ContextName, ctx.nextEventNumber),
      timestamp: DateTime.unsafeNow(),
      agentName: contextName as AgentName,
      parentEventId: Option.none(),
      triggersAgentTurn: true,
      content: userMessage
    })

    // Add event to agent - this will broadcast to subscription and trigger LLM turn
    yield* service.addEvents({ agentName: contextName as AgentName, events: [userEvent] })

    // Wait for turn to complete or user interrupt
    const result = yield* awaitTurnCompletion(service, contextName, mailbox)

    if (result._tag === "exit") {
      return { _tag: "exit" } as const
    }

    if (result._tag === "interrupted") {
      if (result.newMessage) {
        // User sent new message during streaming - this will trigger a new turn
        // The agent's debounce processing will interrupt the current turn automatically
        return yield* runChatTurnWithPending(service, contextName, chat, mailbox, result.newMessage)
      }
      // User hit return with no text - just continue (agent will handle interruption)
    }

    return { _tag: "continue" } as const
  })()

const runChatTurnWithPending = (
  service: AgentService,
  contextName: string,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>,
  pendingMessage: string
): Effect.Effect<TurnResult, ReducerError | ContextSaveError> =>
  Effect.gen(function*() {
    const ctx = yield* service.getReducedContext({ agentName: contextName as AgentName })

    const userEvent = new UserMessageEvent({
      id: makeEventId(`${contextName}-v1` as ContextName, ctx.nextEventNumber),
      timestamp: DateTime.unsafeNow(),
      agentName: contextName as AgentName,
      parentEventId: Option.none(),
      triggersAgentTurn: true,
      content: pendingMessage
    })

    yield* service.addEvents({ agentName: contextName as AgentName, events: [userEvent] })

    const result = yield* awaitTurnCompletion(service, contextName, mailbox)

    if (result._tag === "exit") {
      return { _tag: "exit" } as const
    }

    if (result._tag === "interrupted" && result.newMessage) {
      return yield* runChatTurnWithPending(service, contextName, chat, mailbox, result.newMessage)
    }

    return { _tag: "continue" } as const
  })

type TurnCompletionResult =
  | { readonly _tag: "completed" }
  | { readonly _tag: "exit" }
  | { readonly _tag: "interrupted"; readonly newMessage: string | null }

const awaitTurnCompletion = (
  service: AgentService,
  contextName: string,
  mailbox: Mailbox.Mailbox<ChatSignal>
): Effect.Effect<TurnCompletionResult, never, Scope.Scope> =>
  Effect.gen(function*() {
    // Wait for either: turn completes OR user interrupts
    const eventStream = yield* service.tapEventStream({ agentName: contextName as AgentName })

    const waitForCompletion = eventStream.pipe(
      Stream.takeUntil((e) =>
        e._tag === "AgentTurnCompletedEvent" ||
        e._tag === "AgentTurnFailedEvent" ||
        e._tag === "AgentTurnInterruptedEvent"
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.as({ _tag: "completed" } as TurnCompletionResult)
    )

    const waitForInterrupt = Effect.gen(function*() {
      const signal = yield* mailbox.take.pipe(
        Effect.catchTag("NoSuchElementException", () => Effect.succeed({ _tag: "Exit" } as const))
      )
      if (signal._tag === "Exit") {
        return { _tag: "exit" } as TurnCompletionResult
      }
      return { _tag: "interrupted", newMessage: signal.text || null } as TurnCompletionResult
    })

    return yield* Effect.race(waitForCompletion, waitForInterrupt)
  })
