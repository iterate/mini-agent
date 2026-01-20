/**
 * Voice CLI Command
 *
 * CLI interface for real-time voice conversations with Grok.
 */
import { Command, Options } from "@effect/cli"
import { BunCommandExecutor } from "@effect/platform-bun"
import { Config, Console, Effect, Fiber, Layer, Option, Redacted, Stream } from "effect"

import { AudioCapture } from "./audio-capture.ts"
import { AudioPlayback } from "./audio-playback.ts"
import { GrokVoiceClient, type GrokVoiceConnection } from "./client.ts"
import { DEFAULT_INSTRUCTIONS, DEFAULT_SAMPLE_RATE, DEFAULT_VOICE, type VoiceName } from "./domain.ts"

const voiceOption = Options.choice("voice", ["ara", "rex", "sal", "eve", "leo"]).pipe(
  Options.withAlias("v"),
  Options.withDescription("Voice to use (ara, rex, sal, eve, leo)"),
  Options.withDefault(DEFAULT_VOICE)
)

const sampleRateOption = Options.integer("sample-rate").pipe(
  Options.withAlias("r"),
  Options.withDescription("Audio sample rate in Hz"),
  Options.withDefault(DEFAULT_SAMPLE_RATE)
)

const instructionsOption = Options.text("instructions").pipe(
  Options.withAlias("i"),
  Options.withDescription("System instructions for the assistant"),
  Options.optional
)

const textModeOption = Options.boolean("text").pipe(
  Options.withAlias("t"),
  Options.withDescription("Text mode - type messages instead of speaking"),
  Options.withDefault(false)
)

const VoiceLayer = Layer.mergeAll(
  GrokVoiceClient.Default,
  AudioCapture.Default,
  AudioPlayback.Default,
  BunCommandExecutor.layer
)

const runVoiceChat = (options: {
  voice: string
  sampleRate: number
  instructions: Option.Option<string>
  textMode: boolean
}) =>
  Effect.gen(function*() {
    const apiKey = yield* Config.redacted("XAI_API_KEY").pipe(
      Effect.map((r) => Redacted.value(r)),
      Effect.catchAll(() => Effect.fail(new Error("XAI_API_KEY environment variable is required")))
    )

    const capture = yield* AudioCapture
    const playback = yield* AudioPlayback
    const voiceClient = yield* GrokVoiceClient

    const soxAvailable = yield* capture.checkSoxAvailable
    if (!soxAvailable && !options.textMode) {
      yield* Console.error("sox is not installed. Please run: brew install sox")
      yield* Console.error("Or use --text mode to type messages instead.")
      return
    }

    yield* Console.log("╔════════════════════════════════════════════╗")
    yield* Console.log("║       Grok Voice Chat                      ║")
    yield* Console.log("╠════════════════════════════════════════════╣")
    yield* Console.log(`║ Voice: ${options.voice.padEnd(36)}║`)
    yield* Console.log(`║ Sample Rate: ${String(options.sampleRate).padEnd(30)}║`)
    yield* Console.log(`║ Mode: ${(options.textMode ? "Text" : "Voice").padEnd(37)}║`)
    yield* Console.log("╚════════════════════════════════════════════╝")
    yield* Console.log("")

    if (!options.textMode) {
      yield* Console.log("Speak into your microphone. Press Ctrl+C to exit.")
    } else {
      yield* Console.log("Type your message and press Enter. Press Ctrl+C to exit.")
    }
    yield* Console.log("")

    const connection = yield* voiceClient.connect({
      apiKey,
      voice: options.voice as VoiceName,
      sampleRate: options.sampleRate,
      instructions: Option.isSome(options.instructions)
        ? options.instructions.value
        : DEFAULT_INSTRUCTIONS
    })

    yield* connection.waitForReady

    yield* Console.log("Connected! Starting conversation...")
    yield* Console.log("")

    const player = yield* playback.createPlayer({ sampleRate: options.sampleRate })

    const audioPlaybackFiber = yield* connection.audioOutput.pipe(
      Stream.runForEach((buffer) => player.write(buffer)),
      Effect.fork
    )

    const transcriptFiber = yield* connection.transcripts.pipe(
      Stream.runForEach((delta) => Effect.sync(() => process.stdout.write(`\x1b[36m${delta}\x1b[0m`))),
      Effect.fork
    )

    const userTranscriptFiber = yield* connection.userTranscripts.pipe(
      Stream.runForEach((transcript) => Console.log(`\n\x1b[33mYou: ${transcript}\x1b[0m`)),
      Effect.fork
    )

    if (options.textMode) {
      yield* runTextMode(connection)
    } else {
      const micStream = capture.capture({ sampleRate: options.sampleRate })
      yield* micStream.pipe(
        Stream.runForEach((buffer) => connection.send(buffer))
      )
    }

    yield* Fiber.interrupt(audioPlaybackFiber)
    yield* Fiber.interrupt(transcriptFiber)
    yield* Fiber.interrupt(userTranscriptFiber)
    yield* player.close
    yield* connection.close
  }).pipe(
    Effect.provide(VoiceLayer),
    Effect.catchAll((error) => Console.error(`Error: ${error instanceof Error ? error.message : String(error)}`))
  )

const runTextMode = (connection: GrokVoiceConnection) =>
  Effect.gen(function*() {
    const readline = yield* Effect.promise(() => import("node:readline"))

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    })

    yield* Effect.async<void>((resume) => {
      const prompt = () => {
        rl.question("\x1b[33mYou: \x1b[0m", (answer) => {
          if (answer.trim()) {
            Effect.runSync(connection.sendText(answer.trim()))
          }
          prompt()
        })
      }

      prompt()

      rl.on("close", () => {
        resume(Effect.void)
      })

      return Effect.sync(() => {
        rl.close()
      })
    })
  })

export const voiceCommand = Command.make(
  "voice",
  {
    voice: voiceOption,
    sampleRate: sampleRateOption,
    instructions: instructionsOption,
    textMode: textModeOption
  },
  ({ instructions, sampleRate, textMode, voice }) =>
    runVoiceChat({
      instructions,
      sampleRate,
      textMode,
      voice
    })
).pipe(
  Command.withDescription("Real-time voice conversation with Grok AI")
)
