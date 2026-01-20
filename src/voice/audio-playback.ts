/**
 * Audio Playback Service
 *
 * Plays audio through speakers using the sox CLI tool.
 * Requires sox to be installed: brew install sox
 */
import { Effect, type Fiber, Queue, Stream } from "effect"
import { type ChildProcess, spawn } from "node:child_process"

import { DEFAULT_SAMPLE_RATE } from "./domain.ts"

export interface AudioPlaybackConfig {
  readonly sampleRate?: number
}

export interface AudioPlayer {
  readonly write: (audio: Buffer) => Effect.Effect<void>
  readonly clear: Effect.Effect<void>
  readonly close: Effect.Effect<void>
  readonly writerFiber: Fiber.RuntimeFiber<void, never>
}

export class AudioPlayback extends Effect.Service<AudioPlayback>()("@lome/AudioPlayback", {
  effect: Effect.succeed({
    /**
     * Create a playback sink that accepts audio buffers.
     * Returns a function to write audio and a cleanup effect.
     *
     * Uses sox CLI:
     * sox -t raw -r 24000 -e signed -b 16 -c 1 - -d
     *   -t raw: input raw PCM
     *   -r 24000: sample rate
     *   -e signed: signed integer encoding
     *   -b 16: 16-bit
     *   -c 1: mono
     *   -: input from stdin
     *   -d: output to default audio device (speakers)
     */
    createPlayer: (config?: AudioPlaybackConfig): Effect.Effect<AudioPlayer> =>
      Effect.gen(function*() {
        const sampleRate = config?.sampleRate ?? DEFAULT_SAMPLE_RATE

        const audioQueue = yield* Queue.unbounded<Buffer>()
        let soxProcess: ChildProcess | null = null
        let isRunning = true

        soxProcess = spawn("sox", [
          "-q", // quiet - suppress status output
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
          "-",
          "-d"
        ], {
          stdio: ["pipe", "ignore", "ignore"]
        })

        soxProcess.on("error", (error) => {
          Effect.runSync(Effect.logError(`Sox playback error: ${error.message}`))
        })

        soxProcess.on("close", () => {
          isRunning = false
        })

        const writerFiber = yield* Effect.fork(
          Stream.fromQueue(audioQueue).pipe(
            Stream.runForEach((buffer) =>
              Effect.sync(() => {
                if (soxProcess?.stdin && !soxProcess.stdin.destroyed && isRunning) {
                  soxProcess.stdin.write(buffer)
                }
              })
            )
          )
        )

        const write = (audio: Buffer): Effect.Effect<void> => Queue.offer(audioQueue, audio).pipe(Effect.asVoid)

        // Clear queue and restart sox to enable barge-in
        const clear: Effect.Effect<void> = Effect.gen(function*() {
          // Drain queue (take all pending items and discard)
          let cleared = 0
          while (true) {
            const item = yield* Queue.poll(audioQueue)
            if (item._tag === "None") break
            cleared++
          }

          // Kill old sox (don't wait for close event)
          const oldProcess = soxProcess
          if (oldProcess) {
            oldProcess.removeAllListeners("close")
            oldProcess.stdin?.end()
            oldProcess.kill("SIGKILL")
          }

          // Start new sox process
          soxProcess = spawn("sox", [
            "-q", // quiet - suppress status output
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
            "-",
            "-d"
          ], {
            stdio: ["pipe", "ignore", "ignore"]
          })

          isRunning = true

          soxProcess.on("error", (error) => {
            Effect.runSync(Effect.logError(`Sox playback error: ${error.message}`))
          })

          soxProcess.on("close", () => {
            isRunning = false
          })

          if (cleared > 0) {
            yield* Effect.logDebug(`Barge-in: cleared ${cleared} audio chunks`)
          }
        })

        const close: Effect.Effect<void> = Effect.gen(function*() {
          isRunning = false
          yield* Queue.shutdown(audioQueue)
          if (soxProcess?.stdin) {
            soxProcess.stdin.end()
          }
          if (soxProcess) {
            soxProcess.kill()
          }
        })

        return {
          write,
          clear,
          close,
          writerFiber
        }
      }),

    /**
     * Stream audio to speakers.
     * Convenience method that handles player lifecycle.
     */
    play: (audioStream: Stream.Stream<Buffer, Error>, config?: AudioPlaybackConfig) =>
      Effect.gen(function*() {
        const playback = yield* AudioPlayback
        const player = yield* playback.createPlayer(config)
        yield* audioStream.pipe(
          Stream.runForEach((buffer) => player.write(buffer))
        ).pipe(
          Effect.ensuring(player.close)
        )
      })
  })
}) {}
