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

    const runChat = (agentName: string) =>
      Effect.gen(function*() {
      // Get existing events for history display
      const existingEvents = yield* service.getEvents({ agentName: agentName as AgentName })

      const mailbox = yield* Mailbox.make<ChatSignal>()

      const chat = yield* Effect.promise(() =>
        runOpenTUIChat(agentName, existingEvents, {
          onSubmit: (text) => {
            mailbox.unsafeOffer({ _tag: "Input", text })
          },
          onExit: () => {
            mailbox.unsafeOffer({ _tag: "Exit" })
          }
        })
      )

      // Subscribe to agent events and forward to UI
      const liveEventsStream = yield* service.tapEventStream({ agentName: agentName as AgentName })
      const subscriptionFiber = yield* liveEventsStream.pipe(
        Stream.runForEach((event) => Effect.sync(() => chat.addEvent(event))),
        Effect.fork
      )

      yield* runChatLoop(service, agentName as AgentName, chat, mailbox).pipe(
        Effect.catchAllCause(() => Effect.void),
        Effect.ensuring(
          Effect.gen(function*() {
            yield* Fiber.interrupt(subscriptionFiber)
            // Note: endSession not available in AgentService - sessions end naturally
            chat.cleanup()
          })
        )
      )
      })

    return { runChat }
  }),
  dependencies: [AgentService]
}) {}

const runChatLoop = (
  service: AgentService,
  agentName: AgentName,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>
): Effect.Effect<void, ReducerError | ContextSaveError> =>
  Effect.gen(function*() {
    while (true) {
      const result = yield* runChatTurn(service, agentName, chat, mailbox)
      if (result._tag === "exit") {
        return
      }
    }
  })

type TurnResult =
  | { readonly _tag: "continue" }
  | { readonly _tag: "exit" }

const runChatTurn = (
  service: AgentService,
  agentName: AgentName,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>
): Effect.Effect<TurnResult, ReducerError | ContextSaveError> =>
  Effect.gen(function*() {
    const signal = yield* mailbox.take.pipe(
      Effect.catchTag("NoSuchElementException", () => Effect.succeed({ _tag: "Exit" } as const))
    )

    if (signal._tag === "Exit") {
      return { _tag: "exit" } as const
    }

    const userMessage = signal.text.trim()

    // Empty message = just continue waiting (can't interrupt in remote mode)
    if (!userMessage) {
      return { _tag: "continue" } as const
    }

    // Get current state to build proper event
    const ctx = yield* service.getState({ agentName })

    // Create user event with triggersAgentTurn=true to start LLM turn
    const contextName = `${agentName}-v1` as ContextName
    const userEvent = new UserMessageEvent({
      id: makeEventId(contextName, ctx.nextEventNumber),
      timestamp: DateTime.unsafeNow(),
      agentName,
      parentEventId: Option.none(),
      triggersAgentTurn: true,
      content: userMessage
    })

    // Add event to agent - this will broadcast to subscription and trigger LLM turn
    yield* service.addEvents({ agentName, events: [userEvent] })

    // Wait for turn to complete or user interrupt
    const result = yield* awaitTurnCompletion(service, agentName, mailbox)

    if (result._tag === "exit") {
      return { _tag: "exit" } as const
    }

    if (result._tag === "interrupted") {
      if (result.newMessage) {
        // User sent new message during streaming - this will trigger a new turn
        // The agent's debounce processing will interrupt the current turn automatically
        return yield* runChatTurnWithPending(service, agentName, chat, mailbox, result.newMessage)
      }
      // Note: Can't interrupt turn in remote mode - just continue
    }

    return { _tag: "continue" } as const
  })

const runChatTurnWithPending = (
  service: AgentService,
  agentName: AgentName,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>,
  pendingMessage: string
): Effect.Effect<TurnResult, ReducerError | ContextSaveError> =>
  Effect.gen(function*() {
    const ctx = yield* service.getState({ agentName })
    const contextName = `${agentName}-v1` as ContextName

    const userEvent = new UserMessageEvent({
      id: makeEventId(contextName, ctx.nextEventNumber),
      timestamp: DateTime.unsafeNow(),
      agentName,
      parentEventId: Option.none(),
      triggersAgentTurn: true,
      content: pendingMessage
    })

    yield* service.addEvents({ agentName, events: [userEvent] })

    const result = yield* awaitTurnCompletion(service, agentName, mailbox)

    if (result._tag === "exit") {
      return { _tag: "exit" } as const
    }

    if (result._tag === "interrupted" && result.newMessage) {
      return yield* runChatTurnWithPending(service, agentName, chat, mailbox, result.newMessage)
    }

    return { _tag: "continue" } as const
  })

type TurnCompletionResult =
  | { readonly _tag: "completed" }
  | { readonly _tag: "exit" }
  | { readonly _tag: "interrupted"; readonly newMessage: string | null }

const awaitTurnCompletion = (
  service: AgentService,
  agentName: AgentName,
  mailbox: Mailbox.Mailbox<ChatSignal>
): Effect.Effect<TurnCompletionResult> =>
  Effect.gen(function*() {
    // Wait for either: turn completes OR user interrupts
    // For remote mode, we can't check isIdle, so we use a timeout-based approach
    const waitForIdle = Effect.gen(function*() {
      // Poll state to check if turn is in progress
      // Simplified: wait a bit then assume completed (remote mode limitation)
      let lastEventCount = 0
      let stableCount = 0
      while (true) {
        const ctx = yield* service.getState({ agentName })
        const isInProgress = ctx.agentTurnStartedAtEventId._tag === "Some"
        
        if (!isInProgress) {
          // Not in progress - check if we've been stable for a bit
          const events = yield* service.getEvents({ agentName })
          if (events.length === lastEventCount) {
            stableCount++
            if (stableCount > 4) { // 200ms of stability
              return { _tag: "completed" } as TurnCompletionResult
            }
          } else {
            stableCount = 0
            lastEventCount = events.length
          }
        } else {
          stableCount = 0
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
  })
