/**
 * Chat UI Service
 *
 * Interactive chat with interruptible LLM streaming using AgentService.
 * Return during streaming interrupts (with optional new message); Escape exits.
 */
import { Effect, Fiber, Mailbox, Stream } from "effect"
import { AgentService, type AgentServiceError, type AgentServiceShape } from "../agent-service.ts"
import { type AgentName, makeBaseEventFields, UserMessageEvent } from "../domain.ts"
import { type ChatController, runOpenTUIChat } from "./components/opentui-chat.tsx"

type ChatSignal =
  | { readonly _tag: "Input"; readonly text: string }
  | { readonly _tag: "Exit" }

export class ChatUI extends Effect.Service<ChatUI>()("@mini-agent/ChatUI", {
  effect: Effect.gen(function*() {
    const service = yield* AgentService

    const runChat = Effect.fn("ChatUI.runChat")(function*(agentName: string) {
      const name = agentName as AgentName
      const contextName = `${agentName}-v1`

      // Get existing events for history display
      const existingEvents = yield* service.getEvents({ agentName: name })

      // Unbounded mailbox - unsafeOffer always succeeds (idiomatic Effect pattern)
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
      const eventStream = yield* service.tapEventStream({ agentName: name })
      const subscriptionFiber = yield* eventStream.pipe(
        Stream.runForEach((event) => Effect.sync(() => chat.addEvent(event))),
        Effect.fork
      )

      yield* runChatLoop(service, name, contextName, chat, mailbox).pipe(
        Effect.catchAllCause(() => Effect.void),
        Effect.ensuring(
          Effect.gen(function*() {
            yield* Fiber.interrupt(subscriptionFiber)
            yield* service.endSession({ agentName: name }).pipe(Effect.catchAll(() => Effect.void))
            chat.cleanup()
          })
        )
      )
    })

    return { runChat }
  })
}) {}

const runChatLoop = (
  service: AgentServiceShape,
  agentName: AgentName,
  contextName: string,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>
): Effect.Effect<void, AgentServiceError> =>
  Effect.fn("ChatUI.runChatLoop")(function*() {
    while (true) {
      const result = yield* runChatTurn(service, agentName, contextName, chat, mailbox)
      if (result._tag === "exit") {
        return
      }
    }
  })()

type TurnResult =
  | { readonly _tag: "continue" }
  | { readonly _tag: "exit" }

const runChatTurn = (
  service: AgentServiceShape,
  agentName: AgentName,
  contextName: string,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>
): Effect.Effect<TurnResult, AgentServiceError> =>
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
    const state = yield* service.getState({ agentName })

    // Create user event with triggersAgentTurn=true to start LLM turn
    const userEvent = new UserMessageEvent({
      ...makeBaseEventFields(agentName, contextName as any, state.nextEventNumber, true),
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
        return yield* runChatTurnWithPending(service, agentName, contextName, chat, mailbox, result.newMessage)
      } else {
        // User hit return with no text - just interrupt without starting new turn
        yield* service.interruptTurn({ agentName })
      }
    }

    return { _tag: "continue" } as const
  })()

const runChatTurnWithPending = (
  service: AgentServiceShape,
  agentName: AgentName,
  contextName: string,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>,
  pendingMessage: string
): Effect.Effect<TurnResult, AgentServiceError> =>
  Effect.gen(function*() {
    const state = yield* service.getState({ agentName })

    const userEvent = new UserMessageEvent({
      ...makeBaseEventFields(agentName, contextName as any, state.nextEventNumber, true),
      content: pendingMessage
    })

    yield* service.addEvents({ agentName, events: [userEvent] })

    const result = yield* awaitTurnCompletion(service, agentName, mailbox)

    if (result._tag === "exit") {
      return { _tag: "exit" } as const
    }

    if (result._tag === "interrupted" && result.newMessage) {
      return yield* runChatTurnWithPending(service, agentName, contextName, chat, mailbox, result.newMessage)
    }

    return { _tag: "continue" } as const
  })

type TurnCompletionResult =
  | { readonly _tag: "completed" }
  | { readonly _tag: "exit" }
  | { readonly _tag: "interrupted"; readonly newMessage: string | null }

const awaitTurnCompletion = (
  service: AgentServiceShape,
  agentName: AgentName,
  mailbox: Mailbox.Mailbox<ChatSignal>
): Effect.Effect<TurnCompletionResult, AgentServiceError> =>
  Effect.fn("ChatUI.awaitTurnCompletion")(function*() {
    // Wait for either: turn completes OR user interrupts
    const waitForIdle = Effect.gen(function*() {
      // Poll for idle state
      while (true) {
        const isIdle = yield* service.isIdle({ agentName })
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
