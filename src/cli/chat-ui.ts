/**
 * Chat UI Service
 *
 * Interactive chat with interruptible LLM streaming using MiniAgent actor.
 * Return during streaming interrupts (with optional new message); Escape exits.
 */
import { Effect, Fiber, Mailbox, Ref, Stream } from "effect"
import { AgentEventCommands, AgentEvents } from "../agent-events.ts"
import { type AgentName, type ContextEvent } from "../domain.ts"
import { runOpenTUIChat } from "./components/opentui-chat.tsx"

type ChatSignal =
  | { readonly _tag: "Input"; readonly text: string }
  | { readonly _tag: "Exit" }

export class ChatUI extends Effect.Service<ChatUI>()("@mini-agent/ChatUI", {
  effect: Effect.gen(function*() {
    const agentEvents = yield* AgentEvents

    const runChat = Effect.fn("ChatUI.runChat")(function*(agentName: string) {
      const resolvedName = agentName as AgentName
      const existingEvents = yield* agentEvents.getEvents({ agentName: resolvedName })

      // Unbounded mailbox - unsafeOffer always succeeds (idiomatic Effect pattern)
      const mailbox = yield* Mailbox.make<ChatSignal>()

      const chat = yield* Effect.tryPromise({
        try: () =>
        runOpenTUIChat(resolvedName, existingEvents, {
          onSubmit: (text) => mailbox.unsafeOffer({ _tag: "Input", text }),
          onExit: () => mailbox.unsafeOffer({ _tag: "Exit" })
        }),
        catch: (error) => new Error(`Failed to start chat UI: ${String(error)}`)
      })

      const streamingRef = yield* Ref.make(false)

      yield* Effect.scoped(
        Effect.gen(function*() {
          const stream = yield* agentEvents.tapEventStream({ agentName: resolvedName })
          const subscriptionFiber = yield* stream.pipe(
            Stream.runForEach((event: ContextEvent) =>
              Effect.gen(function*() {
                yield* updateStreamingState(streamingRef, event)
                yield* Effect.sync(() => chat.addEvent(event))
              })
            ),
            Effect.fork
          )

          yield* runChatLoop(resolvedName, agentEvents, mailbox, streamingRef).pipe(
            Effect.catchAllCause(() => Effect.void),
            Effect.ensuring(
              Effect.gen(function*() {
                yield* agentEvents.addEvents({
                  agentName: resolvedName,
                  events: [AgentEventCommands.endSession]
                }).pipe(Effect.catchAllCause(() => Effect.void))
                yield* Fiber.interrupt(subscriptionFiber)
                chat.cleanup()
              })
            )
          )
        })
      )
    })

    return { runChat }
  })
}) {}

const runChatLoop = (
  agentName: AgentName,
  service: AgentEvents,
  mailbox: Mailbox.Mailbox<ChatSignal>,
  streamingRef: Ref.Ref<boolean>
): Effect.Effect<void> =>
  Effect.gen(function*() {
    while (true) {
      const signal = yield* mailbox.take.pipe(
        Effect.catchTag("NoSuchElementException", () => Effect.succeed({ _tag: "Exit" } as const))
      )

      if (signal._tag === "Exit") {
        return
      }

      const userMessage = signal.text.trim()

      if (!userMessage) {
        const streaming = yield* Ref.get(streamingRef)
        if (streaming) {
          yield* service.addEvents({ agentName, events: [AgentEventCommands.interruptTurn] })
        }
        continue
      }

      yield* service.addEvents({
        agentName,
        events: [AgentEventCommands.userMessage({ content: userMessage })]
      })
    }
  })

const updateStreamingState = (ref: Ref.Ref<boolean>, event: ContextEvent) => {
  switch (event._tag) {
    case "AgentTurnStartedEvent":
      return Ref.set(ref, true)
    case "AgentTurnCompletedEvent":
    case "AgentTurnFailedEvent":
    case "AgentTurnInterruptedEvent":
    case "SessionEndedEvent":
      return Ref.set(ref, false)
    default:
      return Effect.void
  }
}
