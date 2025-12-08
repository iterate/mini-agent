/**
 * Chat UI Service
 *
 * Interactive chat built entirely on the AgentService event interface.
 */
import { Effect, Fiber, Mailbox, Stream } from "effect"
import { contextNameFromAgent } from "../agent-registry.ts"
import { AgentService, type AgentServiceApi, AgentServiceLive } from "../agent-service.ts"
import { type AgentName, makeBaseEventFields, SessionEndedEvent, UserMessageEvent } from "../domain.ts"
import { runOpenTUIChat } from "./components/opentui-chat.tsx"

type ChatSignal =
  | { readonly _tag: "Input"; readonly text: string }
  | { readonly _tag: "Exit" }

export class ChatUI extends Effect.Service<ChatUI>()("@mini-agent/ChatUI", {
  effect: Effect.gen(function*() {
    const agentService = yield* AgentService

    const runChat = Effect.fn("ChatUI.runChat")(function*(agentNameInput: string) {
      const agentName = agentNameInput as AgentName
      const existingEvents = yield* agentService.getEvents({ agentName })

      // Unbounded mailbox - unsafeOffer always succeeds (idiomatic Effect pattern)
      const mailbox = yield* Mailbox.make<ChatSignal>()

      const chat = yield* Effect.promise(() =>
        runOpenTUIChat(agentNameInput, existingEvents, {
          onSubmit: (text) => mailbox.unsafeOffer({ _tag: "Input", text }),
          onExit: () => mailbox.unsafeOffer({ _tag: "Exit" })
        })
      )

      const subscriptionFiber = yield* Effect.scoped(
        Effect.gen(function*() {
          const stream = yield* agentService.tapEventStream({ agentName })
          return yield* stream.pipe(
            Stream.runForEach((event) => Effect.sync(() => chat.addEvent(event)))
          )
        })
      ).pipe(Effect.fork)

      yield* chatInputLoop(agentName, mailbox, agentService).pipe(
        Effect.catchAllCause(() => Effect.void),
        Effect.ensuring(
          Effect.gen(function*() {
            yield* Fiber.interrupt(subscriptionFiber).pipe(Effect.catchAllCause(() => Effect.void))
            chat.cleanup()
          })
        )
      )

      yield* appendSessionEnd(agentService, agentName)
    })

    return { runChat }
  }),
  dependencies: [AgentServiceLive]
}) {}

const chatInputLoop = (
  agentName: AgentName,
  mailbox: Mailbox.Mailbox<ChatSignal>,
  agentService: AgentServiceApi
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
      if (userMessage === "") {
        continue
      }

      const events = yield* agentService.getEvents({ agentName })
      const nextEventNumber = events.length
      const contextName = contextNameFromAgent(agentName)

      const userEvent = new UserMessageEvent({
        ...makeBaseEventFields(agentName, contextName, nextEventNumber, true),
        content: userMessage
      })

      yield* agentService.addEvents({ agentName, events: [userEvent] })
    }
  })

const appendSessionEnd = (agentService: AgentServiceApi, agentName: AgentName) =>
  Effect.gen(function*() {
    const events = yield* agentService.getEvents({ agentName })
    const contextName = contextNameFromAgent(agentName)
    const sessionEnd = new SessionEndedEvent({
      ...makeBaseEventFields(agentName, contextName, events.length, false)
    })
    yield* agentService.addEvents({ agentName, events: [sessionEnd] })
  })
