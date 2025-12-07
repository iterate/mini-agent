/**
 * Chat UI Service
 *
 * Interactive chat with interruptible LLM streaming.
 * Return during streaming interrupts (with optional new message); Escape exits.
 */
import type { Error as PlatformError } from "@effect/platform"
import { Cause, Context, Effect, Fiber, Layer, Mailbox, Option, Stream } from "effect"
import { is } from "effect/Schema"
import { AgentRegistry } from "../agent-registry.ts"
import {
  type AgentName,
  type AgentTurnNumber,
  AssistantMessageEvent,
  type ContextEvent,
  type ContextName,
  type ContextSaveError,
  DEFAULT_SYSTEM_PROMPT,
  EventBuilder,
  type ReducerError,
  TextDeltaEvent
} from "../domain.ts"
import { type ChatController, type DisplayEvent, runOpenTUIChat } from "./components/opentui-chat.tsx"

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
      PlatformError.PlatformError | ReducerError | ContextSaveError,
      AgentRegistry
    >
  }
>() {
  static readonly layer = Layer.effect(
    ChatUI,
    Effect.gen(function*() {
      const registry = yield* AgentRegistry

      const runChat = Effect.fn("ChatUI.runChat")(function*(contextName: string) {
        const agentName = contextName as AgentName
        const agent = yield* registry.getOrCreate(agentName)

        // Check if context needs initialization
        const ctx = yield* agent.getReducedContext
        if (ctx.messages.length === 0) {
          const systemEvent = EventBuilder.systemPrompt(
            agentName,
            agent.contextName,
            ctx.nextEventNumber,
            DEFAULT_SYSTEM_PROMPT
          )
          yield* agent.addEvent(systemEvent)
        }

        // Get events for display
        const existingEvents = yield* agent.getEvents

        // Convert domain events to display events for the UI
        const displayEvents: Array<DisplayEvent> = existingEvents
          .map((e): DisplayEvent | null => {
            switch (e._tag) {
              case "UserMessageEvent":
                return { _tag: "UserMessage", content: e.content }
              case "AssistantMessageEvent":
                return { _tag: "AssistantMessage", content: e.content }
              case "SystemPromptEvent":
                return { _tag: "SystemPrompt", content: e.content }
              case "AgentTurnInterruptedEvent":
                return Option.isSome(e.partialResponse)
                  ? { _tag: "LLMRequestInterrupted", partialResponse: e.partialResponse.value, reason: e.reason }
                  : null
              default:
                return null
            }
          })
          .filter((e): e is DisplayEvent => e !== null)

        const mailbox = yield* Mailbox.make<ChatSignal>()

        const chat = yield* Effect.promise(() =>
          runOpenTUIChat(contextName, displayEvents, {
            onSubmit: (text) => {
              mailbox.unsafeOffer({ _tag: "Input", text })
            },
            onExit: () => {
              mailbox.unsafeOffer({ _tag: "Exit" })
            }
          })
        )

        yield* runChatLoop(agentName, agent, chat, mailbox).pipe(
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

interface AgentInterface {
  readonly addEvent: (event: ContextEvent) => Effect.Effect<void, ReducerError | ContextSaveError>
  readonly events: Stream.Stream<ContextEvent, never>
  readonly getReducedContext: Effect.Effect<{ nextEventNumber: number; currentTurnNumber: AgentTurnNumber }, never>
  readonly contextName: ContextName
}

const runChatLoop = (
  agentName: AgentName,
  agent: AgentInterface,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>
): Effect.Effect<void, ReducerError | ContextSaveError> =>
  Effect.fn("ChatUI.runChatLoop")(function*() {
    while (true) {
      const result = yield* runChatTurn(agentName, agent, chat, mailbox, null)
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
  agent: AgentInterface,
  chat: ChatController,
  mailbox: Mailbox.Mailbox<ChatSignal>,
  pendingMessage: string | null
): Effect.Effect<TurnResult, ReducerError | ContextSaveError> =>
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

    const ctx = yield* agent.getReducedContext

    // Create and add user event
    const userEvent = EventBuilder.userMessage(
      agentName,
      agent.contextName,
      ctx.nextEventNumber,
      userMessage
    )
    yield* agent.addEvent(userEvent)

    // Show in UI
    chat.addEvent({ _tag: "UserMessage", content: userMessage })

    let accumulatedText = ""

    const streamFiber = yield* Effect.fork(
      agent.events.pipe(
        Stream.takeUntil((e) => e._tag === "AgentTurnCompletedEvent" || e._tag === "AgentTurnFailedEvent"),
        Stream.tap((event: ContextEvent) =>
          Effect.sync(() => {
            if (is(TextDeltaEvent)(event)) {
              accumulatedText += event.delta
              chat.addEvent({ _tag: "TextDelta", delta: event.delta })
            } else if (is(AssistantMessageEvent)(event)) {
              chat.addEvent({ _tag: "AssistantMessage", content: event.content })
            }
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
        const interruptedCtx = yield* agent.getReducedContext
        const interruptedEvent = EventBuilder.agentTurnInterrupted(
          agentName,
          agent.contextName,
          interruptedCtx.nextEventNumber,
          interruptedCtx.currentTurnNumber,
          "user_cancel",
          accumulatedText
        )
        yield* agent.addEvent(interruptedEvent).pipe(Effect.catchAll(() => Effect.void))
        chat.addEvent({ _tag: "LLMRequestInterrupted", partialResponse: accumulatedText, reason: "user_cancel" })
      }
      return { _tag: "exit" } as const
    }

    // result._tag === "interrupted" - user hit return during streaming
    if (accumulatedText.length > 0) {
      const interruptedCtx = yield* agent.getReducedContext
      const interruptedEvent = EventBuilder.agentTurnInterrupted(
        agentName,
        agent.contextName,
        interruptedCtx.nextEventNumber,
        interruptedCtx.currentTurnNumber,
        result.newMessage ? "user_new_message" : "user_cancel",
        accumulatedText
      )
      yield* agent.addEvent(interruptedEvent).pipe(Effect.catchAll(() => Effect.void))
      chat.addEvent({
        _tag: "LLMRequestInterrupted",
        partialResponse: accumulatedText,
        reason: result.newMessage ? "user_new_message" : "user_cancel"
      })
    }

    if (result.newMessage) {
      return yield* runChatTurn(agentName, agent, chat, mailbox, result.newMessage)
    }

    return { _tag: "continue" } as const
  })()

type StreamResult =
  | { readonly _tag: "completed" }
  | { readonly _tag: "exit" }
  | { readonly _tag: "interrupted"; readonly newMessage: string | null }

const awaitStreamCompletion = (
  fiber: Fiber.RuntimeFiber<void, ReducerError | ContextSaveError>,
  mailbox: Mailbox.Mailbox<ChatSignal>
): Effect.Effect<StreamResult, ReducerError | ContextSaveError> =>
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
