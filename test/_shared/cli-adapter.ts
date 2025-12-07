/**
 * CLI Mode Adapter - Tests via CLI with --raw output.
 */
import { Effect, Schema, Stream } from "effect"
import { spawn } from "node:child_process"
import { ContextEvent } from "../../src/domain.ts"
import type { ModeAdapter, ModeAdapterConfig } from "./mode-adapters.ts"

const decodeEvent = Schema.decodeUnknown(ContextEvent)

export const createCliAdapter = (config: ModeAdapterConfig): ModeAdapter => {
  const cwd = config.cwd ?? process.cwd()
  const env = { ...process.env, ...config.env }

  const sendMessage = (contextName: string, content: string) =>
    Effect.async<ReadonlyArray<ContextEvent>, Error>((resume) => {
      const events: Array<ContextEvent> = []
      let buffer = ""

      const proc = spawn("bun", ["run", "mini-agent", "chat", "-n", contextName, "-m", content, "--raw"], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"]
      })

      proc.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          if (line.trim()) {
            try {
              const json = JSON.parse(line) as unknown
              Effect.runSync(
                decodeEvent(json).pipe(
                  Effect.tap((event) => Effect.sync(() => events.push(event))),
                  Effect.catchAll(() => Effect.void)
                )
              )
            } catch {
              // Skip non-JSON lines
            }
          }
        }
      })

      proc.on("close", () => {
        resume(Effect.succeed(events))
      })

      proc.on("error", (err) => {
        resume(Effect.fail(new Error(`CLI process error: ${err.message}`)))
      })
    })

  const streamEvents = (contextName: string, content: string) =>
    Stream.fromEffect(sendMessage(contextName, content)).pipe(Stream.flatMap(Stream.fromIterable))

  const cleanup = Effect.void

  return { sendMessage, streamEvents, cleanup }
}
