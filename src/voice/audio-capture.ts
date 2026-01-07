/**
 * Audio Capture Service
 *
 * Captures microphone audio using the sox CLI tool.
 * Requires sox to be installed: brew install sox
 */
import type { CommandExecutor } from "@effect/platform"
import { Command } from "@effect/platform"
import { Chunk, Effect, Stream } from "effect"

import { DEFAULT_SAMPLE_RATE } from "./domain.ts"

export interface AudioCaptureConfig {
  readonly sampleRate?: number
  readonly chunkSize?: number
}

export class AudioCapture extends Effect.Service<AudioCapture>()("@lome/AudioCapture", {
  effect: Effect.succeed({
    /**
     * Start capturing audio from the default microphone.
     * Returns a stream of PCM 16-bit mono audio buffers.
     *
     * Uses sox CLI:
     * sox -d -t raw -r 24000 -e signed -b 16 -c 1 -
     *   -d: default audio device (microphone)
     *   -t raw: output raw PCM
     *   -r 24000: sample rate
     *   -e signed: signed integer encoding
     *   -b 16: 16-bit
     *   -c 1: mono
     *   -: output to stdout
     */
    capture: (config?: AudioCaptureConfig): Stream.Stream<Buffer, Error, CommandExecutor.CommandExecutor> => {
      const sampleRate = config?.sampleRate ?? DEFAULT_SAMPLE_RATE
      const chunkSize = config?.chunkSize ?? 4096

      const command = Command.make(
        "sox",
        "-d",
        "-t",
        "raw",
        "-r",
        String(sampleRate),
        "-e",
        "signed",
        "-b",
        "16",
        "-c",
        "1",
        "-"
      )

      return Command.stream(command).pipe(
        Stream.mapChunks((chunks) => {
          const buffers: Array<Buffer> = []
          let accumulated = Buffer.alloc(0)

          for (const chunk of chunks) {
            accumulated = Buffer.concat([accumulated, Buffer.from(chunk)])
            while (accumulated.length >= chunkSize) {
              buffers.push(accumulated.subarray(0, chunkSize))
              accumulated = accumulated.subarray(chunkSize)
            }
          }

          if (accumulated.length > 0) {
            buffers.push(accumulated)
          }

          return Chunk.fromIterable(buffers)
        }),
        Stream.catchAll((error) =>
          Stream.fail(
            new Error(`Audio capture failed. Is sox installed? (brew install sox)\n${error}`)
          )
        )
      )
    },

    /**
     * Check if sox is available
     */
    checkSoxAvailable: Effect.gen(function*() {
      const command = Command.make("which", "sox")
      const result = yield* Command.string(command).pipe(
        Effect.catchAll(() => Effect.succeed(""))
      )
      return result.trim().length > 0
    })
  })
}) {}
