#!/usr/bin/env bun
/**
 * Unified Session Demo CLI
 *
 * Demonstrates the unified LLM abstraction working with both:
 * - HTTP transport (OpenAI-compatible chat completions)
 * - WebSocket transport (Grok voice API)
 *
 * Logs all events to YAML file on exit (Ctrl+C).
 *
 * Usage:
 *   doppler run -- bun run src/unified/demo.ts --mode=http --provider=xai
 *   doppler run -- bun run src/unified/demo.ts --mode=voice
 */
import * as fs from "fs"
import * as path from "path"

import { FetchHttpClient } from "@effect/platform"
import { BunCommandExecutor, BunFileSystem } from "@effect/platform-bun"
import { Console, Effect, Layer, Redacted, Stream } from "effect"
import * as readline from "readline"
import * as yaml from "yaml"

import { OpenAiChatClient } from "../openai-chat-completions-client.ts"
import { AudioCapture } from "../voice/audio-capture.ts"
import { AudioPlayback } from "../voice/audio-playback.ts"
import { GrokVoiceClient } from "../voice/client.ts"
import { type ConversationEvent, makeUnifiedSession } from "./domain.ts"
import { HttpTransportLive } from "./http-transport.ts"
import { WsTransportLive } from "./ws-transport.ts"

// Event log for YAML dump on exit
interface LoggedEvent {
  timestamp: string
  event: string
  data: Record<string, unknown>
}
const eventLog: Array<LoggedEvent> = []

/**
 * Log an event for later YAML dump
 */
const logEvent = (event: ConversationEvent): void => {
  const timestamp = new Date().toISOString()
  const base: LoggedEvent = {
    timestamp,
    event: event._tag,
    data: {}
  }

  switch (event._tag) {
    case "TextDelta":
      base.data = { delta: event.delta }
      break
    case "TextComplete":
      base.data = { content: event.content }
      break
    case "AudioDelta":
      // Truncate audio to first 32 bytes, show length
      base.data = {
        chunkSize: Buffer.isBuffer(event.chunk) ? event.chunk.length : 0,
        preview: Buffer.isBuffer(event.chunk) ? event.chunk.subarray(0, 32).toString("base64") : ""
      }
      break
    case "AudioComplete":
      break
    case "ToolCall":
      base.data = { id: event.id, name: event.name, params: event.params }
      break
    case "ToolResult":
      base.data = { id: event.id, result: event.result }
      break
    case "TurnComplete":
      base.data = { inputTokens: event.inputTokens, outputTokens: event.outputTokens }
      break
    case "UserTranscript":
      base.data = { transcript: event.transcript }
      break
    case "ConversationError":
      base.data = { message: event.message, code: event.code._tag === "Some" ? event.code.value : null }
      break
    case "SessionReady":
    case "SpeechStarted":
    case "SpeechStopped":
    case "ResponseStarted":
      // Lifecycle events - no extra data needed
      break
    case "RawEvent":
      base.data = { type: event.type, rawData: event.data }
      break
  }

  eventLog.push(base)
}

/**
 * Write event log to YAML file
 */
const writeEventLog = (): void => {
  if (eventLog.length === 0) return

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const filename = `unified-demo-${mode}-${timestamp}.yaml`
  const filepath = path.join(process.cwd(), filename)

  const logData = {
    meta: {
      mode,
      provider: providerName,
      model,
      startTime: eventLog[0]?.timestamp,
      endTime: eventLog[eventLog.length - 1]?.timestamp,
      eventCount: eventLog.length
    },
    events: eventLog
  }

  fs.writeFileSync(filepath, yaml.stringify(logData))
  // eslint-disable-next-line no-console
  console.log(`\nEvent log written to: ${filepath}`)
}

// Provider configurations for OpenAI-compatible APIs
// Note: Anthropic uses a different API format and needs a separate transport
const PROVIDERS: Record<string, { apiUrl: string; apiKeyEnv: string; defaultModel: string }> = {
  xai: { apiUrl: "https://api.x.ai/v1", apiKeyEnv: "XAI_API_KEY", defaultModel: "grok-2-latest" },
  openai: { apiUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY", defaultModel: "gpt-4o-mini" },
  groq: {
    apiUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    defaultModel: "llama-3.3-70b-versatile"
  },
  cerebras: { apiUrl: "https://api.cerebras.ai/v1", apiKeyEnv: "CEREBRAS_API_KEY", defaultModel: "llama-3.3-70b" },
  openrouter: {
    apiUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultModel: "anthropic/claude-sonnet-4"
  }
}

// Parse CLI args
const args = process.argv.slice(2)
const modeArg = args.find((a) => a.startsWith("--mode="))
const mode = modeArg?.split("=")[1] ?? "http"
const providerArg = args.find((a) => a.startsWith("--provider="))
const providerName = providerArg?.split("=")[1] ?? "openrouter"
const modelArg = args.find((a) => a.startsWith("--model="))

const provider = PROVIDERS[providerName]
if (!provider) {
  // eslint-disable-next-line no-console
  console.error(`Unknown provider: ${providerName}. Available: ${Object.keys(PROVIDERS).join(", ")}`)
  process.exit(1)
}
const model = modelArg?.split("=")[1] ?? provider.defaultModel
const apiKey = process.env[provider.apiKeyEnv] ?? ""

if (mode !== "http" && mode !== "voice") {
  // eslint-disable-next-line no-console
  console.error(
    "Usage: bun run src/unified/demo.ts --mode=http|voice [--provider=xai|openai|groq|cerebras] [--model=MODEL]"
  )
  process.exit(1)
}

// Register exit handler to dump event log
// exit fires on all exit paths (including SIGINT, uncaughtException)
process.on("exit", () => {
  writeEventLog()
})

process.on("SIGINT", () => {
  process.exit(0)
})

/* eslint-disable no-console */
/**
 * Handle conversation events - renders text, plays audio, handles tool calls
 */
const handleEvent = (event: ConversationEvent): Effect.Effect<void> =>
  Effect.sync(() => {
    // Log event for YAML dump
    logEvent(event)

    switch (event._tag) {
      case "TextDelta":
        process.stdout.write(event.delta)
        break
      case "TextComplete":
        console.log(`\n[Complete] ${event.content}`)
        break
      case "AudioDelta":
        // Audio is handled separately via stream in voice mode
        break
      case "AudioComplete":
        console.log("[Audio complete]")
        break
      case "ToolCall":
        console.log(`\n[Tool Call] ${event.name}(${JSON.stringify(event.params)})`)
        break
      case "TurnComplete":
        console.log("\n[Turn complete]")
        if (event.inputTokens || event.outputTokens) {
          console.log(
            `  Tokens: ${event.inputTokens ?? "?"} in / ${event.outputTokens ?? "?"} out`
          )
        }
        break
      case "UserTranscript":
        console.log(`\n[You said] ${event.transcript}`)
        break
      case "ConversationError":
        console.error(`[Error] ${event.message}`)
        break
      case "ToolResult":
        console.log(`[Tool Result] ${event.id}`)
        break
      case "SessionReady":
        console.log("[Session ready]")
        break
      case "SpeechStarted":
        console.log("[Speech started]")
        break
      case "SpeechStopped":
        console.log("[Speech stopped]")
        break
      case "ResponseStarted":
        console.log("[Response started]")
        break
      case "RawEvent":
        // Don't display raw events to console, but they're logged to YAML
        break
    }
  })
/* eslint-enable no-console */

/**
 * Simple readline prompt
 */
const prompt = (rl: readline.Interface): Effect.Effect<string> =>
  Effect.async((resume) => {
    rl.question("\nYou: ", (answer) => {
      resume(Effect.succeed(answer))
    })
  })

/**
 * HTTP mode: simple text REPL
 */
const httpDemo = Effect.gen(function*() {
  yield* Console.log("=== Unified Session Demo (HTTP Mode) ===")
  yield* Console.log(`Provider: ${providerName} | Model: ${model}`)
  yield* Console.log("Type a message and press Enter. Type 'quit' to exit.\n")

  const session = yield* makeUnifiedSession({
    systemPrompt: "You are a helpful assistant. Keep responses concise."
  })

  // Fork event handler
  yield* session.events.pipe(
    Stream.runForEach(handleEvent),
    Effect.forkDaemon
  )

  // Simple readline loop
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  let running = true
  while (running) {
    const input = yield* prompt(rl)
    if (input.toLowerCase() === "quit") {
      rl.close()
      running = false
      continue
    }

    yield* session.sendText(input)

    // Wait a bit for response to stream
    yield* Effect.sleep("100 millis")
  }

  writeEventLog()
  yield* Console.log("\nGoodbye!")
})

/**
 * Voice mode: audio streaming with voice input/output
 */
const voiceDemo = Effect.gen(function*() {
  yield* Console.log("=== Unified Session Demo (Voice Mode) ===")
  yield* Console.log("Speak into your microphone. Press Ctrl+C to exit.\n")

  const session = yield* makeUnifiedSession({
    systemPrompt: "You are a helpful voice assistant. Keep responses brief and conversational."
  })

  // Set up audio playback
  const audioPlayback = yield* AudioPlayback
  const player = yield* audioPlayback.createPlayer()

  // Fork event handler - route audio to playback
  yield* session.events.pipe(
    Stream.tap((event) => {
      if (event._tag === "AudioDelta" && Buffer.isBuffer(event.chunk)) {
        return player.write(event.chunk)
      }
      return handleEvent(event)
    }),
    Stream.runDrain,
    Effect.forkDaemon
  )

  // Start audio capture and forward to session
  const audioCapture = yield* AudioCapture
  const audioStream = audioCapture.capture()

  yield* Console.log("Listening... (speak now)")

  yield* audioStream.pipe(
    Stream.tap((chunk) => session.sendAudio(chunk)),
    Stream.runDrain
  )
})

// Build layers based on mode
const httpLayers = Layer.mergeAll(
  HttpTransportLive({ model }).pipe(
    Layer.provide(
      OpenAiChatClient.layer({
        apiKey: Redacted.make(apiKey),
        apiUrl: provider.apiUrl
      })
    ),
    Layer.provide(FetchHttpClient.layer)
  )
)

const voiceLayers = Layer.mergeAll(
  WsTransportLive({
    apiKey: process.env.XAI_API_KEY ?? "",
    voice: "ara"
  }).pipe(Layer.provide(GrokVoiceClient.Default)),
  AudioCapture.Default,
  AudioPlayback.Default,
  BunCommandExecutor.layer.pipe(Layer.provide(BunFileSystem.layer))
)

// Run the appropriate demo
const runHttp = httpDemo.pipe(
  Effect.provide(httpLayers),
  Effect.catchAll((error) => Console.error(`Fatal error: ${error}`))
)

const runVoice = voiceDemo.pipe(
  Effect.provide(voiceLayers),
  Effect.catchAll((error) => Console.error(`Fatal error: ${error}`))
)

const runnable = mode === "http" ? runHttp : runVoice

// eslint-disable-next-line no-console
Effect.runPromise(runnable).catch(console.error)
