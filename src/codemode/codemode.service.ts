/**
 * Codemode Service
 *
 * Handles extraction, typechecking, and execution of codemode blocks from LLM responses.
 */
import { Command, CommandExecutor, type Error as PlatformError, FileSystem, Path } from "@effect/platform"
import { Chunk, Context, Effect, Layer, Stream } from "effect"
import ts from "typescript"
import { TypecheckError } from "./codemode.errors.ts"
import { BLOCK_FOOTER, BLOCK_HEADER, TOOLS_TEMPLATE, TSCONFIG_TEMPLATE } from "./tools.ts"

/** Result from executing a single codemode block */
export interface BlockResult {
  /** The original source code (as written by LLM) */
  code: string
  /** Block index (1-indexed) */
  blockNumber: number
  /** Output visible to user (from sendMessage via stderr) */
  userOutput: string
  /** Output visible to agent (from console.log via stdout) - triggers continuation */
  agentOutput: string
  /** Whether this block triggers another agent turn */
  triggerAgentTurn: "after-current-turn" | "never"
}

export class CodemodeService extends Context.Tag("@app/CodemodeService")<
  CodemodeService,
  {
    /** Check if text contains codemode blocks */
    readonly hasCodeBlocks: (text: string) => boolean

    /** Extract all code blocks from response text */
    readonly extractCodeBlocks: (text: string) => ReadonlyArray<string>

    /** Write code to response directory, returns dir path and blocks for later use */
    readonly writeResponse: (
      contextName: string,
      responseNumber: number,
      blocks: ReadonlyArray<string>
    ) => Effect.Effect<{ dir: string; blocks: ReadonlyArray<string> }, PlatformError.PlatformError>

    /** Typecheck all blocks in a response directory */
    readonly typecheck: (responseDir: string) => Effect.Effect<void, TypecheckError>

    /** Execute all blocks, return per-block results */
    readonly execute: (
      responseDir: string,
      blocks: ReadonlyArray<string>
    ) => Effect.Effect<ReadonlyArray<BlockResult>, PlatformError.PlatformError>
  }
>() {
  static readonly layer = Layer.effect(
    CodemodeService,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const executor = yield* CommandExecutor.CommandExecutor

      const hasCodeBlocks = (text: string): boolean => /<codemode>[\s\S]*?<\/codemode>/.test(text)

      const extractCodeBlocks = (text: string): ReadonlyArray<string> => {
        const regex = /<codemode>([\s\S]*?)<\/codemode>/g
        const blocks: Array<string> = []
        let match
        while ((match = regex.exec(text)) !== null) {
          let code = match[1]!.trim()
          // Strip markdown fences if present
          const fenceMatch = code.match(/^```(?:typescript|ts)?\n?([\s\S]*?)\n?```$/)
          if (fenceMatch?.[1]) code = fenceMatch[1].trim()
          blocks.push(code)
        }
        return blocks
      }

      const writeResponse = Effect.fn("CodemodeService.writeResponse")(
        function*(contextName: string, responseNumber: number, blocks: ReadonlyArray<string>) {
          const baseDir = ".mini-agent/contexts"
          const codemodeDir = path.join(
            baseDir,
            contextName,
            `response-${String(responseNumber).padStart(3, "0")}`,
            "codemode"
          )

          yield* fs.makeDirectory(codemodeDir, { recursive: true })

          // Write types.ts
          yield* fs.writeFileString(path.join(codemodeDir, "types.ts"), TOOLS_TEMPLATE)

          // Write tsconfig.json
          yield* fs.writeFileString(path.join(codemodeDir, "tsconfig.json"), TSCONFIG_TEMPLATE)

          // Write each block with header + footer (makes it directly executable)
          for (let i = 0; i < blocks.length; i++) {
            const blockName = `block-${String(i + 1).padStart(3, "0")}.ts`
            const blockContent = `${BLOCK_HEADER}${blocks[i]}${BLOCK_FOOTER}`
            yield* fs.writeFileString(path.join(codemodeDir, blockName), blockContent)
          }

          return { dir: codemodeDir, blocks }
        }
      )

      const typecheck = Effect.fn("CodemodeService.typecheck")(
        function*(responseDir: string) {
          // Find all block files
          const files = yield* Effect.try({
            try: () => {
              const typesPath = path.join(responseDir, "types.ts")
              const blockFiles: Array<string> = []

              // Get block files by checking what exists
              for (let i = 1; i <= 100; i++) {
                const blockPath = path.join(responseDir, `block-${String(i).padStart(3, "0")}.ts`)
                if (ts.sys.fileExists(blockPath)) {
                  blockFiles.push(blockPath)
                } else {
                  break
                }
              }

              return [typesPath, ...blockFiles]
            },
            catch: (e) => new TypecheckError({ errors: String(e) })
          })

          // Read tsconfig
          const tsconfigPath = path.join(responseDir, "tsconfig.json")
          const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile)
          if (configFile.error) {
            return yield* new TypecheckError({
              errors: ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")
            })
          }

          const parsedConfig = ts.parseJsonConfigFileContent(
            configFile.config,
            ts.sys,
            responseDir
          )

          // Create program and get diagnostics
          const program = ts.createProgram(files, parsedConfig.options)
          const diagnostics = ts.getPreEmitDiagnostics(program)

          if (diagnostics.length > 0) {
            const errors = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
              getCanonicalFileName: (f) => f,
              getCurrentDirectory: () => responseDir,
              getNewLine: () => "\n"
            })
            return yield* new TypecheckError({ errors })
          }
        }
      )

      const RESULT_MARKER = "__CODEMODE_RESULT__"

      const execute = Effect.fn("CodemodeService.execute")(
        function*(codemodeDir: string, blocks: ReadonlyArray<string>) {
          const results: Array<BlockResult> = []
          const decoder = new TextDecoder()

          for (let i = 0; i < blocks.length; i++) {
            const blockNumber = i + 1
            const blockName = `block-${String(blockNumber).padStart(3, "0")}.ts`

            // Execute block and capture stdout + stderr separately
            // Use Effect.scoped to handle the Scope requirement from Command.start
            const { rawStderr, rawStdout } = yield* Effect.scoped(
              Effect.gen(function*() {
                const process = yield* Command.make("bun", "run", blockName).pipe(
                  Command.workingDirectory(codemodeDir),
                  Command.stdout("pipe"),
                  Command.stderr("pipe"),
                  Command.start,
                  Effect.provideService(CommandExecutor.CommandExecutor, executor)
                )

                // Collect stdout and stderr
                const stdoutChunks = yield* Stream.runCollect(process.stdout)
                const stderrChunks = yield* Stream.runCollect(process.stderr)

                return {
                  rawStdout: decoder.decode(
                    new Uint8Array(Chunk.toReadonlyArray(stdoutChunks).flatMap((c) => Array.from(c)))
                  ),
                  rawStderr: decoder.decode(
                    new Uint8Array(Chunk.toReadonlyArray(stderrChunks).flatMap((c) => Array.from(c)))
                  )
                }
              })
            )

            // stderr = user output (from sendMessage)
            const userOutput = rawStderr.trimEnd()

            // Parse stdout: strip the result marker, remaining is agent output
            const markerIndex = rawStdout.lastIndexOf(RESULT_MARKER)
            const agentOutput = markerIndex >= 0
              ? rawStdout.slice(0, markerIndex).trimEnd()
              : rawStdout.trimEnd()

            // Determine triggerAgentTurn based on whether there's non-whitespace agent output
            const triggerAgentTurn = agentOutput.trim() !== ""
              ? "after-current-turn" as const
              : "never" as const

            // Store outputs in files for debugging
            const userOutputFileName = `block-${String(blockNumber).padStart(3, "0")}.user-output.txt`
            const agentOutputFileName = `block-${String(blockNumber).padStart(3, "0")}.agent-output.txt`
            yield* fs.writeFileString(path.join(codemodeDir, userOutputFileName), userOutput)
            yield* fs.writeFileString(path.join(codemodeDir, agentOutputFileName), agentOutput)

            results.push({
              code: blocks[i]!,
              blockNumber,
              userOutput,
              agentOutput,
              triggerAgentTurn
            })
          }

          return results
        }
      )

      return CodemodeService.of({
        hasCodeBlocks,
        extractCodeBlocks,
        writeResponse,
        typecheck,
        execute
      })
    })
  )

  static readonly testLayer = Layer.sync(CodemodeService, () => {
    const hasCodeBlocks = (text: string): boolean => /<codemode>[\s\S]*?<\/codemode>/.test(text)

    const extractCodeBlocks = (text: string): ReadonlyArray<string> => {
      const regex = /<codemode>([\s\S]*?)<\/codemode>/g
      const blocks: Array<string> = []
      let match
      while ((match = regex.exec(text)) !== null) {
        blocks.push(match[1]!.trim())
      }
      return blocks
    }

    return CodemodeService.of({
      hasCodeBlocks,
      extractCodeBlocks,
      writeResponse: (_ctx, _num, blocks) => Effect.succeed({ dir: "/test/response-001", blocks }),
      typecheck: () => Effect.void,
      execute: (_dir, blocks) =>
        Effect.succeed(
          blocks.map((code, i) => ({
            code,
            blockNumber: i + 1,
            userOutput: "mock user output",
            agentOutput: "",
            triggerAgentTurn: "never" as const
          }))
        )
    })
  })
}
