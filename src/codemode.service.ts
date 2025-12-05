/**
 * Codemode Service
 *
 * Orchestrates the codemode workflow:
 * 1. Detects code blocks in assistant responses
 * 2. Stores code to filesystem
 * 3. Typechecks with TypeScript compiler
 * 4. Executes via bun subprocess
 * 5. Streams events back for real-time feedback
 *
 * Supports multiple codeblocks per assistant message.
 */
import type { Error as PlatformError } from "@effect/platform"
import type { Scope } from "effect"
import { Context, Effect, Layer, Option, pipe, Stream } from "effect"
import { CodeExecutor, type ExecutionEvent } from "./code-executor.service.ts"
import {
  CodeBlockEvent,
  type CodemodeEvent,
  generateRequestId,
  hasCodeBlock,
  parseCodeBlocks,
  type ParsedCodeBlock,
  type RequestId,
  TypecheckFailEvent,
  TypecheckPassEvent,
  TypecheckStartEvent
} from "./codemode.model.ts"
import { type CodeblockLocation, CodemodeRepository } from "./codemode.repository.ts"
import type { CodeStorageError } from "./errors.ts"
import { TypecheckService } from "./typechecker.service.ts"

/** All events that flow through codemode processing */
export type CodemodeStreamEvent = CodemodeEvent | ExecutionEvent

/** Interface for codemode service */
interface CodemodeServiceInterface {
  /**
   * Process assistant response text for code blocks.
   * If code blocks found, store/typecheck/execute each and stream events.
   * Returns Option.none if no code blocks, Option.some(stream) if code found.
   */
  readonly processResponse: (
    contextName: string,
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

      /** Process a single codeblock and return its event stream */
      const processBlock = (
        loc: CodeblockLocation,
        block: ParsedCodeBlock,
        requestId: RequestId
      ): Stream.Stream<CodemodeStreamEvent, PlatformError.PlatformError | CodeStorageError, Scope.Scope> =>
        Stream.unwrap(
          Effect.gen(function*() {
            const { code, codeblockId } = block

            // Step 1: Create codeblock directory
            yield* repo.createCodeblockDir(loc)

            // Step 2: Write code
            const codePath = yield* repo.writeCode(loc, code, 1)

            // Step 3: Typecheck
            const typecheckResult = yield* typechecker.check([codePath])

            if (Option.isSome(typecheckResult)) {
              // Typecheck failed - emit events and stop
              yield* Effect.logWarning("Typecheck failed", {
                contextName: loc.contextName,
                requestId,
                codeblockId,
                diagnostics: typecheckResult.value.diagnostics
              })

              return Stream.make(
                new CodeBlockEvent({ code, requestId, codeblockId, attempt: 1 }) as CodemodeStreamEvent,
                new TypecheckStartEvent({ requestId, codeblockId, attempt: 1 }) as CodemodeStreamEvent,
                new TypecheckFailEvent({
                  requestId,
                  codeblockId,
                  attempt: 1,
                  errors: typecheckResult.value.diagnostics
                }) as CodemodeStreamEvent
              )
            }

            // Typecheck passed - emit events and execute
            yield* Effect.logDebug("Typecheck passed", { contextName: loc.contextName, requestId, codeblockId })

            return pipe(
              Stream.make(
                new CodeBlockEvent({ code, requestId, codeblockId, attempt: 1 }) as CodemodeStreamEvent,
                new TypecheckStartEvent({ requestId, codeblockId, attempt: 1 }) as CodemodeStreamEvent,
                new TypecheckPassEvent({ requestId, codeblockId, attempt: 1 }) as CodemodeStreamEvent
              ),
              Stream.concat(executor.execute(codePath, requestId, codeblockId))
            )
          })
        )

      const processResponse = (
        contextName: string,
        content: string
      ): Effect.Effect<
        Option.Option<Stream.Stream<CodemodeStreamEvent, PlatformError.PlatformError | CodeStorageError, Scope.Scope>>,
        never,
        never
      > =>
        Effect.gen(function*() {
          const blocks = yield* parseCodeBlocks(content)

          if (blocks.length === 0) {
            return Option.none()
          }

          const requestId = yield* generateRequestId()

          // Process all blocks sequentially, concatenating their event streams
          const stream: Stream.Stream<
            CodemodeStreamEvent,
            PlatformError.PlatformError | CodeStorageError,
            Scope.Scope
          > = Stream.fromIterable(blocks).pipe(
            Stream.flatMap((block) => {
              const loc: CodeblockLocation = {
                contextName,
                requestId,
                codeblockId: block.codeblockId
              }
              return processBlock(loc, block, requestId)
            })
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
      processResponse: (_contextName, content) =>
        Effect.gen(function*() {
          const blocks = yield* parseCodeBlocks(content)

          if (blocks.length === 0) {
            return Option.none<
              Stream.Stream<CodemodeStreamEvent, PlatformError.PlatformError | CodeStorageError, Scope.Scope>
            >()
          }

          const requestId = "test-response-id" as RequestId

          // Create events for each block
          const allEvents: Array<CodemodeStreamEvent> = []
          for (const block of blocks) {
            allEvents.push(
              new CodeBlockEvent({ code: block.code, requestId, codeblockId: block.codeblockId, attempt: 1 }),
              new TypecheckStartEvent({ requestId, codeblockId: block.codeblockId, attempt: 1 }),
              new TypecheckPassEvent({ requestId, codeblockId: block.codeblockId, attempt: 1 })
            )
          }

          const stream: Stream.Stream<
            CodemodeStreamEvent,
            PlatformError.PlatformError | CodeStorageError,
            Scope.Scope
          > = Stream.fromIterable(allEvents)

          return Option.some(stream)
        }),
      hasCodeBlock
    })
  )
}
