/**
 * Chat UI Service
 *
 * Interactive chat with interruptible LLM streaming.
 * Return during streaming interrupts (with optional new message); Escape exits.
 */
import type { Error as PlatformError } from "@effect/platform"
import { Cause, Context, DateTime, Effect, Fiber, Layer, Mailbox, Option, Stream } from "effect"
import { AgentRegistry } from "../agent-registry.ts"
import {
  type AgentName,
  AgentTurnInterruptedEvent,
  type ContextEvent,
  type ContextName,
  type ContextSaveError,
  EventBuilder,
  type EventId,
  type ReducedContext,
  type ReducerError
} from "../domain.ts"
import { type ChatController, runOpenTUIChat } from "./components/opentui-chat.tsx"

type ChatSignal =
  | { readonly _tag: "Input"; readonly text: string }
  | { readonly _tag: "Exit" }

export class ChatUI extends Context.Tag("@app/ChatUI")<
  ChatUI,
  {
    readonly runChat: (
      agentName: AgentName
    ) => Effect.Effect<void, PlatformError.PlatformError | ReducerError | ContextSaveError, AgentRegistry>
  }
>() {
  static readonly layer = Layer.effect(
    ChatUI,
    Effect.sync(() => {
      const runChat = Effect.fn("ChatUI.runChat")(function*(agentName: AgentName) {
        const registry = yield* AgentRegistry
        const agent = yield* registry.getOrCreate(agentName)

        // Load existing events to display in chat
        const existingEvents = yield* agent.getEvents

        const mailbox = yield* Mailbox.make<ChatSignal>()

        // Map ContextEvent to the format expected by OpenTUI chat
        const tuiEvents = existingEvents.map((e) => {
          switch (e._tag) {
            case "UserMessageEvent":
              return { _tag: "UserMessage" as const, content: e.content }
            case "AssistantMessageEvent":
              return { _tag: "AssistantMessage" as const, content: e.content }
            case "SystemPromptEvent":
              return { _tag: "SystemPrompt" as const, content: e.content }
            case "AgentTurnInterruptedEvent":
              return {
                _tag: "LLMRequestInterrupted" as const,
                requestId: e.id,
                reason: e.reason,
                partialResponse: Option.getOrElse(e.partialResponse, () => "")
              }
            default:
              return null
          }
        }).filter((e): e is NonNullable<typeof e> => e !== null)

        const chat = yield* Effect.promise(() =>
          runOpenTUIChat(agentName, tuiEvents, {
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

interface MiniAgentInterface {
  readonly agentName: AgentName
  readonly contextName: ContextName
  readonly addEvent: (event: ContextEvent) => Effect.Effect<void, ReducerError | ContextSaveError>
  readonly events: Stream.Stream<ContextEvent, never>
  readonly getReducedContext: Effect.Effect<ReducedContext>
}

const runChatLoop = (
  agentName: AgentName,
  agent: MiniAgentInterface,
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
  agent: MiniAgentInterface,
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
    const userEvent = EventBuilder.userMessage(agentName, agent.contextName, ctx.nextEventNumber, userMessage)

    // Add user message to TUI and agent
    chat.addEvent({ _tag: "UserMessage", content: userMessage })

    let accumulatedText = ""

    const streamFiber = yield* Effect.fork(
      agent.events.pipe(
        Stream.takeUntil((e) => e._tag === "AgentTurnCompletedEvent" || e._tag === "AgentTurnFailedEvent"),
        Stream.tap((event) =>
          Effect.sync(() => {
            if (event._tag === "TextDeltaEvent") {
              accumulatedText += event.delta
              chat.addEvent({ _tag: "TextDelta", delta: event.delta })
            } else if (event._tag === "AssistantMessageEvent") {
              chat.addEvent({ _tag: "AssistantMessage", content: event.content })
            }
          })
        ),
        Stream.runDrain
      )
    )

    // Add event to trigger LLM turn
    yield* agent.addEvent(userEvent)

    const result = yield* awaitStreamCompletion(streamFiber, mailbox)

    if (result._tag === "completed") {
      return { _tag: "continue" } as const
    }

    if (result._tag === "exit") {
      if (accumulatedText.length > 0) {
        const updatedCtx = yield* agent.getReducedContext
        const interruptedEvent = new AgentTurnInterruptedEvent({
          id: `${agent.contextName}:${String(updatedCtx.nextEventNumber).padStart(4, "0")}` as EventId,
          timestamp: DateTime.unsafeNow(),
          agentName,
          parentEventId: Option.none(),
          triggersAgentTurn: false,
          turnNumber: updatedCtx.currentTurnNumber,
          reason: "user_cancel",
          partialResponse: Option.some(accumulatedText)
        })
        yield* agent.addEvent(interruptedEvent)
        chat.addEvent({
          _tag: "LLMRequestInterrupted",
          requestId: interruptedEvent.id,
          reason: "user_cancel",
          partialResponse: accumulatedText
        })
      }
      return { _tag: "exit" } as const
    }

    // result._tag === "interrupted" - user hit return during streaming
    if (accumulatedText.length > 0) {
      const updatedCtx = yield* agent.getReducedContext
      const interruptedEvent = new AgentTurnInterruptedEvent({
        id: `${agent.contextName}:${String(updatedCtx.nextEventNumber).padStart(4, "0")}` as EventId,
        timestamp: DateTime.unsafeNow(),
        agentName,
        parentEventId: Option.none(),
        triggersAgentTurn: false,
        turnNumber: updatedCtx.currentTurnNumber,
        reason: result.newMessage ? "user_new_message" : "user_cancel",
        partialResponse: Option.some(accumulatedText)
      })
      yield* agent.addEvent(interruptedEvent)
      chat.addEvent({
        _tag: "LLMRequestInterrupted",
        requestId: interruptedEvent.id,
        reason: result.newMessage ? "user_new_message" : "user_cancel",
        partialResponse: accumulatedText
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
