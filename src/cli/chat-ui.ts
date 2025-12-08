/**
 * Chat UI Service
 *
 * Interactive chat with interruptible LLM streaming using MiniAgent actor.
 * Return during streaming interrupts (with optional new message); Escape exits.
 */
import { DateTime, Effect, Fiber, Mailbox, Option, Stream } from "effect"
import { AgentRegistry } from "../agent-registry.ts"
import {
  type AgentName,
  type ContextSaveError,
  makeEventId,
  type MiniAgent,
  type ReducerError,
  UserMessageEvent
} from "../domain.ts"
import { type ChatController, runOpenTUIChat } from "./components/opentui-chat.tsx"

type ChatSignal =
  | { readonly _tag: "Input"; readonly text: string }
  | { readonly _tag: "Exit" }

export class ChatUI extends Effect.Service<ChatUI>()("@mini-agent/ChatUI", {
  effect: Effect.gen(function*() {
    const registry = yield* AgentRegistry

    const runChat = Effect.fn("ChatUI.runChat")(function*(agentName: string) {
      // Get or create the agent
      const agent = yield* registry.getOrCreate(agentName as AgentName)

      // Get existing events for history display
      const existingEvents = yield* agent.getEvents

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
      // Wrap in Effect.scoped to provide the Scope required by tapEventStream (PubSub.subscribe)
      // The scope stays open for the entire chat session
      yield* Effect.scoped(
        Effect.gen(function*() {
          const eventStream = yield* agent.tapEventStream
          const subscriptionFiber = yield* eventStream.pipe(
            Stream.runForEach((event) => Effect.sync(() => chat.addEvent(event))),
            Effect.fork
          )

          yield* runChatLoop(agent, chat, mailbox).pipe(
            Effect.catchAllCause(() => Effect.void),
            Effect.ensuring(
              Effect.gen(function*() {
                yield* Fiber.interrupt(subscriptionFiber)
                yield* agent.endSession
                chat.cleanup()
              })
            )
          )
        })
      )
    })

    return { runChat }
  }),
  dependencies: [AgentRegistry.Default]
}) {}

const runChatLoop = (
  agent: MiniAgent,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>
): Effect.Effect<void, ReducerError | ContextSaveError> =>
  Effect.fn("ChatUI.runChatLoop")(function*() {
    while (true) {
      const result = yield* runChatTurn(agent, chat, mailbox)
      if (result._tag === "exit") {
        return
      }
    }
  })()

type TurnResult =
  | { readonly _tag: "continue" }
  | { readonly _tag: "exit" }

const runChatTurn = (
  agent: MiniAgent,
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

    // Get current state to build proper event
    const ctx = yield* agent.getState

    // Create user event with triggersAgentTurn=true to start LLM turn
    const userEvent = new UserMessageEvent({
      id: makeEventId(agent.contextName, ctx.nextEventNumber),
      timestamp: DateTime.unsafeNow(),
      agentName: agent.agentName,
      parentEventId: Option.none(),
      triggersAgentTurn: true,
      content: userMessage
    })

    // Add event to agent - this will broadcast to subscription and trigger LLM turn
    yield* agent.addEvent(userEvent)

    // Wait for turn to complete or user interrupt
    const result = yield* awaitTurnCompletion(agent, mailbox)

    if (result._tag === "exit") {
      return { _tag: "exit" } as const
    }

    if (result._tag === "interrupted") {
      if (result.newMessage) {
        // User sent new message during streaming - this will trigger a new turn
        // The agent's debounce processing will interrupt the current turn automatically
        return yield* runChatTurnWithPending(agent, chat, mailbox, result.newMessage)
      } else {
        // User hit return with no text - just interrupt without starting new turn
        yield* agent.interruptTurn
      }
    }

    return { _tag: "continue" } as const
  })()

const runChatTurnWithPending = (
  agent: MiniAgent,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>,
  pendingMessage: string
): Effect.Effect<TurnResult, ReducerError | ContextSaveError> =>
  Effect.gen(function*() {
    const ctx = yield* agent.getState

    const userEvent = new UserMessageEvent({
      id: makeEventId(agent.contextName, ctx.nextEventNumber),
      timestamp: DateTime.unsafeNow(),
      agentName: agent.agentName,
      parentEventId: Option.none(),
      triggersAgentTurn: true,
      content: pendingMessage
    })

    yield* agent.addEvent(userEvent)

    const result = yield* awaitTurnCompletion(agent, mailbox)

    if (result._tag === "exit") {
      return { _tag: "exit" } as const
    }

    if (result._tag === "interrupted" && result.newMessage) {
      return yield* runChatTurnWithPending(agent, chat, mailbox, result.newMessage)
    }

    return { _tag: "continue" } as const
  })

type TurnCompletionResult =
  | { readonly _tag: "completed" }
  | { readonly _tag: "exit" }
  | { readonly _tag: "interrupted"; readonly newMessage: string | null }

const awaitTurnCompletion = (
  agent: MiniAgent,
  mailbox: Mailbox.Mailbox<ChatSignal>
): Effect.Effect<TurnCompletionResult> =>
  Effect.fn("ChatUI.awaitTurnCompletion")(function*() {
    // Wait for either: turn completes OR user interrupts
    const waitForIdle = Effect.gen(function*() {
      // Poll for idle state
      while (true) {
        const isIdle = yield* agent.isIdle
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
