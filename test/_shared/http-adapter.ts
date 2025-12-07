/**
 * HTTP Mode Adapter - Tests via HTTP server endpoints.
 */
import { Effect, Schema, Stream } from "effect"
import { ContextEvent } from "../../src/domain.ts"
import type { ModeAdapter, ModeAdapterConfig } from "./mode-adapters.ts"

const decodeEvent = Schema.decodeUnknown(ContextEvent)

export const createHttpAdapter = (config: ModeAdapterConfig): ModeAdapter => {
  const baseUrl = config.baseUrl ?? "http://localhost:3000"

  const sendMessage = (contextName: string, content: string) =>
    Effect.gen(function*() {
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(`${baseUrl}/agent/${contextName}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ _tag: "UserMessageEvent", content })
          }),
        catch: (e) => new Error(`HTTP request failed: ${e}`)
      })

      const text = yield* Effect.tryPromise({
        try: () => response.text(),
        catch: (e) => new Error(`Failed to read response: ${e}`)
      })

      // Parse SSE events
      const events: Array<ContextEvent> = []
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) {
          const json = JSON.parse(line.slice(6)) as unknown
          const event = yield* decodeEvent(json).pipe(
            Effect.mapError((e) => new Error(`Failed to decode event: ${e}`))
          )
          events.push(event)
        }
      }

      return events
    })

  const streamEvents = (contextName: string, content: string) =>
    Stream.fromEffect(sendMessage(contextName, content)).pipe(Stream.flatMap(Stream.fromIterable))

  const cleanup = Effect.void

  return { sendMessage, streamEvents, cleanup }
}
