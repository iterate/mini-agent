/**
 * Chat UI Service
 *
 * Interactive chat with interruptible LLM streaming using MiniAgent actor.
 * Return during streaming interrupts (with optional new message); Escape exits.
 */
import { Deferred, Effect, Fiber, Mailbox, Ref, Stream } from "effect"
import { AgentEventInput, AgentService } from "../agent-service.ts"
import { type AgentName, type ContextEvent } from "../domain.ts"
import { type ChatController, runOpenTUIChat } from "./components/opentui-chat.tsx"

type ChatSignal =
  | { readonly _tag: "Input"; readonly text: string }
  | { readonly _tag: "Exit" }

const turnTerminalTags = new Set([
  "AgentTurnCompletedEvent",
  "AgentTurnFailedEvent",
  "AgentTurnInterruptedEvent"
])

const isTurnTerminal = (event: ContextEvent): boolean => turnTerminalTags.has(event._tag)

export class ChatUI extends Effect.Service<ChatUI>()("@mini-agent/ChatUI", {
  effect: Effect.gen(function*() {
    const service = yield* AgentService

    const runChat = Effect.fn("ChatUI.runChat")(function*(agentName: AgentName) {
      const snapshot = yield* service.getEvents({ agentName })
      // Unbounded mailbox - unsafeOffer always succeeds (idiomatic Effect pattern)
      const mailbox = yield* Mailbox.make<ChatSignal>()

      const chat = yield* Effect.promise(() =>
        runOpenTUIChat(agentName, snapshot.events, {
          onSubmit: (text) => {
            mailbox.unsafeOffer({ _tag: "Input", text })
          },
          onExit: () => {
            mailbox.unsafeOffer({ _tag: "Exit" })
          }
        })
      )

      const turnCompletionRef = yield* Ref.make<ReadonlyArray<Deferred.Deferred<void>>>([])

      const subscriptionFiber = yield* Stream.unwrapScoped(service.tapEventStream({ agentName })).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function*() {
            if (isTurnTerminal(event)) {
              const next = yield* Ref.modify(turnCompletionRef, (queue) => {
                if (queue.length === 0) {
                  return [undefined, queue] as const
                }
                const [first, ...rest] = queue
                return [first, rest] as const
              })
              if (next) {
                yield* Deferred.succeed(next, void 0).pipe(Effect.catchAll(() => Effect.void))
              }
            }
            yield* Effect.sync(() => chat.addEvent(event))
          })
        ),
        Effect.fork
      )

      yield* runChatLoop(agentName, service, chat, mailbox, turnCompletionRef).pipe(
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
  })
}) {}

const runChatLoop = (
  agentName: AgentName,
  service: AgentService,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>,
  turnCompletionRef: Ref.Ref<ReadonlyArray<Deferred.Deferred<void>>>
) =>
  Effect.gen(function*() {
    while (true) {
      const result = yield* runChatTurn(agentName, service, chat, mailbox, turnCompletionRef)
      if (result._tag === "exit") {
        return
      }
    }
  })

type TurnResult =
  | { readonly _tag: "continue" }
  | { readonly _tag: "exit" }

const runChatTurn = (
  agentName: AgentName,
  service: AgentService,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>,
  turnCompletionRef: Ref.Ref<ReadonlyArray<Deferred.Deferred<void>>>
) =>
  Effect.gen(function*() {
    const signal = yield* mailbox.take.pipe(
      Effect.catchTag("NoSuchElementException", () => Effect.succeed({ _tag: "Exit" } as const))
    )

    if (signal._tag === "Exit") {
      return { _tag: "exit" } as const
    }

    const userMessage = signal.text.trim()

    if (!userMessage) {
      return { _tag: "continue" } as const
    }

    const deferred = yield* registerTurnDeferred(turnCompletionRef)

    const userEvent: AgentEventInput = {
      _tag: "UserMessageEvent",
      content: userMessage,
      triggersAgentTurn: true
    }

    yield* service.addEvents({ agentName, events: [userEvent] })

    const result = yield* awaitTurnCompletion(agentName, service, mailbox, deferred)

    if (result._tag === "exit") {
      return { _tag: "exit" } as const
    }

    if (result._tag === "interrupted") {
      if (result.newMessage) {
        return yield* runChatTurnWithPending(
          agentName,
          service,
          chat,
          mailbox,
          turnCompletionRef,
          result.newMessage
        )
      }
      return { _tag: "continue" } as const
    }

    return { _tag: "continue" } as const
  })

const runChatTurnWithPending = (
  agentName: AgentName,
  service: AgentService,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>,
  turnCompletionRef: Ref.Ref<ReadonlyArray<Deferred.Deferred<void>>>,
  pendingMessage: string
) =>
  Effect.gen(function*() {
    const deferred = yield* registerTurnDeferred(turnCompletionRef)

    const userEvent: AgentEventInput = {
      _tag: "UserMessageEvent",
      content: pendingMessage,
      triggersAgentTurn: true
    }

    yield* service.addEvents({ agentName, events: [userEvent] })

    const result = yield* awaitTurnCompletion(agentName, service, mailbox, deferred)

    if (result._tag === "exit") {
      return { _tag: "exit" } as const
    }

    if (result._tag === "interrupted" && result.newMessage) {
      return yield* runChatTurnWithPending(
        agentName,
        service,
        chat,
        mailbox,
        turnCompletionRef,
        result.newMessage
      )
    }

    return { _tag: "continue" } as const
  })

const registerTurnDeferred = (
  ref: Ref.Ref<ReadonlyArray<Deferred.Deferred<void>>>
): Effect.Effect<Deferred.Deferred<void>> =>
  Effect.gen(function*() {
    const deferred = yield* Deferred.make<void>()
    yield* Ref.update(ref, (queue) => [...queue, deferred])
    return deferred
  })

type TurnCompletionResult =
  | { readonly _tag: "completed" }
  | { readonly _tag: "exit" }
  | { readonly _tag: "interrupted"; readonly newMessage: string | null }

const awaitTurnCompletion = (
  agentName: AgentName,
  service: AgentService,
  mailbox: Mailbox.Mailbox<ChatSignal>,
  turnDeferred: Deferred.Deferred<void>
) =>
  Effect.gen(function*() {
    const waitForIdle = Deferred.await(turnDeferred).pipe(Effect.as({ _tag: "completed" } as TurnCompletionResult))

    const waitForInterrupt = Effect.gen(function*() {
      const signal = yield* mailbox.take.pipe(
        Effect.catchTag("NoSuchElementException", () => Effect.succeed({ _tag: "Exit" } as const))
      )
      if (signal._tag === "Exit") {
        return { _tag: "exit" } as TurnCompletionResult
      }

      const trimmed = signal.text.trim()
      if (trimmed === "") {
        yield* service.addEvents({ agentName, events: [{ _tag: "InterruptTurn" as const }] })
        return { _tag: "interrupted", newMessage: null } as TurnCompletionResult
      }

      return { _tag: "interrupted", newMessage: signal.text } as TurnCompletionResult
    })

    return yield* Effect.race(waitForIdle, waitForInterrupt)
  })
