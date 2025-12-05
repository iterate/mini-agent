/**
 * LLM Module Tests
 */
import { BunContext } from "@effect/platform-bun"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import {
  AssistantMessageEvent,
  LLMRequestInterruptedEvent,
  SystemPromptEvent,
  UserMessageEvent
} from "../src/context.model.ts"
import { eventsToPrompt } from "../src/llm.ts"

const testLayer = BunContext.layer

describe("eventsToPrompt", () => {
  it.effect("converts basic conversation to prompt", () =>
    Effect.gen(function*() {
      const events = [
        new SystemPromptEvent({ content: "You are helpful" }),
        new UserMessageEvent({ content: "Hello" }),
        new AssistantMessageEvent({ content: "Hi there!" }),
        new UserMessageEvent({ content: "How are you?" })
      ]

      const prompt = yield* eventsToPrompt(events)
      const messages = prompt.content

      expect(messages).toHaveLength(4)
      expect(messages[0]?.role).toBe("system")
      expect(messages[1]?.role).toBe("user")
      expect(messages[2]?.role).toBe("assistant")
      expect(messages[3]?.role).toBe("user")
    }).pipe(Effect.provide(testLayer)))

  it.effect("includes interrupted response as assistant message", () =>
    Effect.gen(function*() {
      const events = [
        new SystemPromptEvent({ content: "You are helpful" }),
        new UserMessageEvent({ content: "Tell me a story" }),
        new LLMRequestInterruptedEvent({
          requestId: "test-123",
          reason: "user_cancel",
          partialResponse: "Once upon a time, there was a"
        }),
        new UserMessageEvent({ content: "Continue" })
      ]

      const prompt = yield* eventsToPrompt(events)
      const messages = prompt.content

      // Should have: system, user, assistant (partial), user (interruption notice), user (new message)
      expect(messages).toHaveLength(5)

      expect(messages[0]?.role).toBe("system")
      expect(messages[1]?.role).toBe("user")

      // Interrupted response becomes assistant message
      const assistantMsg = messages[2]
      expect(assistantMsg?.role).toBe("assistant")
      if (assistantMsg?.role === "assistant") {
        const assistantContent = assistantMsg.content
        expect(Array.isArray(assistantContent)).toBe(true)
        const firstPart = assistantContent[0]
        expect(firstPart?.type).toBe("text")
        if (firstPart?.type === "text") {
          expect(firstPart.text).toBe("Once upon a time, there was a")
        }
      }

      // Interruption notice is injected as user message
      const noticeMsg = messages[3]
      expect(noticeMsg?.role).toBe("user")
      if (noticeMsg?.role === "user") {
        const noticeContent = noticeMsg.content
        expect(Array.isArray(noticeContent)).toBe(true)
        const firstPart = noticeContent[0]
        expect(firstPart?.type).toBe("text")
        if (firstPart?.type === "text") {
          expect(firstPart.text).toContain("Your previous response was interrupted")
          expect(firstPart.text).toContain("Once upon a time, there was a")
        }
      }

      // New user message
      expect(messages[4]?.role).toBe("user")
    }).pipe(Effect.provide(testLayer)))

  it.effect("handles user_new_message interruption reason", () =>
    Effect.gen(function*() {
      const events = [
        new UserMessageEvent({ content: "Start" }),
        new LLMRequestInterruptedEvent({
          requestId: "test-456",
          reason: "user_new_message",
          partialResponse: "I was saying"
        }),
        new UserMessageEvent({ content: "New question" })
      ]

      const prompt = yield* eventsToPrompt(events)
      const messages = prompt.content

      // user, assistant (partial), user (notice), user (new)
      expect(messages).toHaveLength(4)
      expect(messages[0]?.role).toBe("user")
      expect(messages[1]?.role).toBe("assistant")
      expect(messages[2]?.role).toBe("user")
      expect(messages[3]?.role).toBe("user")
    }).pipe(Effect.provide(testLayer)))

  it.effect("handles multiple interruptions in sequence", () =>
    Effect.gen(function*() {
      const events = [
        new UserMessageEvent({ content: "First question" }),
        new LLMRequestInterruptedEvent({
          requestId: "test-1",
          reason: "user_cancel",
          partialResponse: "First partial"
        }),
        new UserMessageEvent({ content: "Second question" }),
        new LLMRequestInterruptedEvent({
          requestId: "test-2",
          reason: "user_cancel",
          partialResponse: "Second partial"
        }),
        new UserMessageEvent({ content: "Third question" })
      ]

      const prompt = yield* eventsToPrompt(events)
      const messages = prompt.content

      // user, assistant, user (notice), user, assistant, user (notice), user
      expect(messages).toHaveLength(7)

      let userCount = 0
      let assistantCount = 0
      for (const msg of messages) {
        if (msg.role === "user") userCount++
        if (msg.role === "assistant") assistantCount++
      }

      expect(userCount).toBe(5) // 3 real + 2 interruption notices
      expect(assistantCount).toBe(2) // 2 partial responses
    }).pipe(Effect.provide(testLayer)))

  it.effect("handles empty partial response in interruption", () =>
    Effect.gen(function*() {
      // Edge case: interrupted before any content was generated
      const events = [
        new UserMessageEvent({ content: "Question" }),
        new LLMRequestInterruptedEvent({
          requestId: "test-empty",
          reason: "user_cancel",
          partialResponse: ""
        }),
        new UserMessageEvent({ content: "New question" })
      ]

      const prompt = yield* eventsToPrompt(events)
      const messages = prompt.content

      // Still creates the messages even with empty content
      expect(messages).toHaveLength(4)
    }).pipe(Effect.provide(testLayer)))
})
