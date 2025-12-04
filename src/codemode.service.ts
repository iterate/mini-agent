/**
 * Codemode Service
 *
 * Orchestrates the codemode workflow:
 * 1. Detects code blocks in assistant responses
 * 2. Stores code to filesystem
 * 3. Typechecks with TypeScript compiler
 * 4. Executes via bun subprocess
 * 5. Streams events back for real-time feedback
 */
import type { Error as PlatformError } from "@effect/platform"
import type { Scope } from "effect"
import { Context, Effect, Layer, Option, pipe, Stream } from "effect"
import { CodeExecutor, type ExecutionEvent } from "./code-executor.service.ts"
import {
  CodeBlockEvent,
  type CodemodeEvent,
  generateResponseId,
  hasCodeBlock,
  parseCodeBlock,
  type ResponseId,
  TypecheckFailEvent,
  TypecheckPassEvent,
  TypecheckStartEvent
} from "./codemode.model.ts"
import { CodemodeRepository } from "./codemode.repository.ts"
import type { CodeStorageError } from "./errors.ts"
import { TypecheckService } from "./typechecker.service.ts"

/** All events that flow through codemode processing */
export type CodemodeStreamEvent = CodemodeEvent | ExecutionEvent

/** Interface for codemode service */
interface CodemodeServiceInterface {
  /**
   * Process assistant response text for code blocks.
   * If code block found, store/typecheck/execute and stream events.
   * Returns Option.none if no code block, Option.some(stream) if code found.
   */
  readonly processResponse: (
    content: string
  ) => Effect.Effect<
    Option.Option<Stream.Stream<CodemodeStreamEvent, PlatformError.PlatformError | CodeStorageError, Scope.Scope>>,
    never,
    never
  >

  /**
   * Check if content contains a code block.
   */
  readonly hasCodeBlock: (content: string) => boolean
}

export class CodemodeService extends Context.Tag("@app/CodemodeService")<
  CodemodeService,
  CodemodeServiceInterface
>() {
  static readonly layer = Layer.effect(
    CodemodeService,
    Effect.gen(function*() {
      const repo = yield* CodemodeRepository
      const typechecker = yield* TypecheckService
      const executor = yield* CodeExecutor

      const processResponse = (
        content: string
      ): Effect.Effect<
        Option.Option<Stream.Stream<CodemodeStreamEvent, PlatformError.PlatformError | CodeStorageError, Scope.Scope>>,
        never,
        never
      > =>
        Effect.gen(function*() {
          const codeOpt = yield* parseCodeBlock(content)

          if (Option.isNone(codeOpt)) {
            return Option.none()
          }

          const code = codeOpt.value
          const responseId = yield* generateResponseId()

          // Build the processing stream
          const stream: Stream.Stream<
            CodemodeStreamEvent,
            PlatformError.PlatformError | CodeStorageError,
            Scope.Scope
          > = pipe(
            // Step 1: Create response directory
            Stream.fromEffect(repo.createResponseDir(responseId)),
            Stream.flatMap(() =>
              // Step 2: Write code
              Stream.fromEffect(repo.writeCode(responseId, code, 1))
            ),
            Stream.flatMap((codePath) =>
              pipe(
                // Emit CodeBlockEvent
                Stream.make(new CodeBlockEvent({ code, responseId, attempt: 1 })),
                Stream.concat(
                  // Step 3: Typecheck
                  Stream.fromEffect(
                    Effect.gen(function*() {
                      yield* Effect.logDebug("Starting typecheck", { responseId, codePath })
                      return new TypecheckStartEvent({ responseId, attempt: 1 })
                    })
                  )
                ),
                Stream.concat(
                  Stream.fromEffect(
                    Effect.gen(function*() {
                      const result = yield* typechecker.check([codePath])

                      if (Option.isSome(result)) {
                        yield* Effect.logWarning("Typecheck failed", {
                          responseId,
                          diagnostics: result.value.diagnostics
                        })
                        return new TypecheckFailEvent({
                          responseId,
                          attempt: 1,
                          errors: result.value.diagnostics
                        })
                      }

                      yield* Effect.logDebug("Typecheck passed", { responseId })
                      return new TypecheckPassEvent({ responseId, attempt: 1 })
                    })
                  )
                ),
                // Step 4: Execute if typecheck passed
                Stream.flatMap((event) => {
                  if (event._tag === "TypecheckFail") {
                    // Don't execute on typecheck failure
                    return Stream.make(event)
                  }
                  // Emit typecheck pass then execute
                  return pipe(
                    Stream.make(event as CodemodeStreamEvent),
                    Stream.concat(executor.execute(codePath, responseId))
                  )
                })
              )
            )
          )

          return Option.some(stream)
        })

      return CodemodeService.of({
        processResponse,
        hasCodeBlock
      })
    })
  )

  static readonly testLayer = Layer.succeed(
    CodemodeService,
    CodemodeService.of({
      processResponse: (content) =>
        Effect.sync(() => {
          if (!hasCodeBlock(content)) {
            return Option.none<
              Stream.Stream<CodemodeStreamEvent, PlatformError.PlatformError | CodeStorageError, Scope.Scope>
            >()
          }

          const responseId = "test-response-id" as ResponseId
          const code = content // Simplified for test

          const stream: Stream.Stream<
            CodemodeStreamEvent,
            PlatformError.PlatformError | CodeStorageError,
            Scope.Scope
          > = Stream.make(
            new CodeBlockEvent({ code, responseId, attempt: 1 }),
            new TypecheckStartEvent({ responseId, attempt: 1 }),
            new TypecheckPassEvent({ responseId, attempt: 1 })
          )

          return Option.some(stream)
        }),
      hasCodeBlock
    })
  )
}
