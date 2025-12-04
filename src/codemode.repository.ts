/**
 * Codemode Repository
 *
 * Manages storage of generated code files in timestamped directories.
 * Each response gets its own directory with:
 * - index.ts: The generated code
 * - types.ts: Type definitions for available tools
 * - tsconfig.json: TypeScript compiler config
 * - response.md: LLM conversation log
 */
import { FileSystem, Path } from "@effect/platform"
import { Context, Effect, Layer } from "effect"
import type { ResponseId } from "./codemode.model.ts"
import { CodeStorageError } from "./errors.ts"

/** Default tsconfig for generated code */
const DEFAULT_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ESNext",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      noUncheckedIndexedAccess: true,
      lib: ["ESNext"]
    }
  },
  null,
  2
)

/** Default types.ts defining available tools */
const DEFAULT_TYPES = `/**
 * Result type that signals whether to continue the agent loop.
 */
export interface CodemodeResult {
  /** If true, the agent loop ends. If false, the LLM is called again with this result. */
  endTurn: boolean
  /** Optional data to pass back to the LLM */
  data?: unknown
}

/**
 * Tools available to generated code.
 * The default function receives this interface and must return CodemodeResult.
 */
export interface Tools {
  /** Log a message to the console */
  readonly log: (message: string) => Promise<void>

  /** Read a file from the filesystem */
  readonly readFile: (path: string) => Promise<string>

  /** Write a file to the filesystem */
  readonly writeFile: (path: string, content: string) => Promise<void>

  /** Execute a shell command */
  readonly exec: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>

  /** Get a secret value. The implementation is hidden from the LLM. */
  readonly getSecret: (name: string) => Promise<string | undefined>
}
`

/** CodemodeRepository interface - service methods don't expose internal deps */
interface CodemodeRepositoryService {
  /** Get the base directory for codemode responses */
  readonly getBaseDir: () => Effect.Effect<string>

  /** Get the response directory for a given responseId */
  readonly getResponseDir: (responseId: ResponseId) => Effect.Effect<string>

  /** Create the response directory with all necessary files */
  readonly createResponseDir: (responseId: ResponseId) => Effect.Effect<string, CodeStorageError>

  /** Write the generated code to index.ts */
  readonly writeCode: (
    responseId: ResponseId,
    code: string,
    attempt: number
  ) => Effect.Effect<string, CodeStorageError>

  /** Append to response.md log */
  readonly appendLog: (responseId: ResponseId, content: string) => Effect.Effect<void, CodeStorageError>

  /** Get the index.ts path for a responseId */
  readonly getCodePath: (responseId: ResponseId) => Effect.Effect<string>
}

export class CodemodeRepository extends Context.Tag("@app/CodemodeRepository")<
  CodemodeRepository,
  CodemodeRepositoryService
>() {
  static readonly layer = Layer.effect(
    CodemodeRepository,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const pathService = yield* Path.Path
      const cwd = process.cwd()
      const baseDir = pathService.join(cwd, ".mini-agent", "codemode")

      const getBaseDir = () => Effect.succeed(baseDir)

      const getResponseDir = (responseId: ResponseId) => Effect.succeed(pathService.join(baseDir, responseId))

      const createResponseDir = (responseId: ResponseId) =>
        Effect.gen(function*() {
          const dir = pathService.join(baseDir, responseId)

          yield* fs.makeDirectory(dir, { recursive: true }).pipe(
            Effect.mapError(
              (e) =>
                new CodeStorageError({
                  message: `Failed to create directory: ${dir}`,
                  cause: e
                })
            )
          )

          // Write tsconfig.json
          yield* fs.writeFileString(pathService.join(dir, "tsconfig.json"), DEFAULT_TSCONFIG).pipe(
            Effect.mapError(
              (e) =>
                new CodeStorageError({
                  message: "Failed to write tsconfig.json",
                  cause: e
                })
            )
          )

          // Write types.ts
          yield* fs.writeFileString(pathService.join(dir, "types.ts"), DEFAULT_TYPES).pipe(
            Effect.mapError(
              (e) =>
                new CodeStorageError({
                  message: "Failed to write types.ts",
                  cause: e
                })
            )
          )

          // Create empty response.md
          yield* fs.writeFileString(pathService.join(dir, "response.md"), "# LLM Response Log\n\n").pipe(
            Effect.mapError(
              (e) =>
                new CodeStorageError({
                  message: "Failed to write response.md",
                  cause: e
                })
            )
          )

          return dir
        })

      const writeCode = (responseId: ResponseId, code: string, attempt: number) =>
        Effect.gen(function*() {
          const dir = pathService.join(baseDir, responseId)

          // Prepend import statement
          const fullCode = `import type { Tools } from "./types.ts"\n\n${code}`

          // For attempt > 1, save previous attempts
          const filename = attempt > 1 ? `index.attempt-${attempt}.ts` : "index.ts"
          const filePath = pathService.join(dir, filename)

          yield* fs.writeFileString(filePath, fullCode).pipe(
            Effect.mapError(
              (e) =>
                new CodeStorageError({
                  message: `Failed to write code to ${filename}`,
                  cause: e
                })
            )
          )

          // Always update index.ts with latest attempt
          if (attempt > 1) {
            yield* fs.writeFileString(pathService.join(dir, "index.ts"), fullCode).pipe(
              Effect.mapError(
                (e) =>
                  new CodeStorageError({
                    message: "Failed to write index.ts",
                    cause: e
                  })
              )
            )
          }

          return filePath
        })

      const appendLog = (responseId: ResponseId, content: string) =>
        Effect.gen(function*() {
          const dir = pathService.join(baseDir, responseId)
          const logPath = pathService.join(dir, "response.md")

          const existing = yield* fs.readFileString(logPath).pipe(Effect.orElse(() => Effect.succeed("")))
          yield* fs.writeFileString(logPath, existing + content).pipe(
            Effect.mapError(
              (e) =>
                new CodeStorageError({
                  message: "Failed to append to response.md",
                  cause: e
                })
            )
          )
        })

      const getCodePath = (responseId: ResponseId) =>
        Effect.succeed(pathService.join(pathService.join(baseDir, responseId), "index.ts"))

      return CodemodeRepository.of({
        getBaseDir,
        getResponseDir,
        createResponseDir,
        writeCode,
        appendLog,
        getCodePath
      })
    })
  )

  static readonly testLayer = Layer.sync(CodemodeRepository, () => {
    const store = new Map<string, Map<string, string>>()

    const getOrCreateDir = (responseId: string) => {
      if (!store.has(responseId)) {
        store.set(responseId, new Map())
      }
      return store.get(responseId)!
    }

    return CodemodeRepository.of({
      getBaseDir: () => Effect.succeed("/tmp/.mini-agent/codemode"),
      getResponseDir: (responseId) => Effect.succeed(`/tmp/.mini-agent/codemode/${responseId}`),
      createResponseDir: (responseId) => {
        getOrCreateDir(responseId)
        return Effect.succeed(`/tmp/.mini-agent/codemode/${responseId}`)
      },
      writeCode: (responseId, code, _attempt) => {
        const dir = getOrCreateDir(responseId)
        dir.set("index.ts", code)
        return Effect.succeed(`/tmp/.mini-agent/codemode/${responseId}/index.ts`)
      },
      appendLog: (responseId, content) => {
        const dir = getOrCreateDir(responseId)
        const existing = dir.get("response.md") ?? ""
        dir.set("response.md", existing + content)
        return Effect.succeed(undefined)
      },
      getCodePath: (responseId) => Effect.succeed(`/tmp/.mini-agent/codemode/${responseId}/index.ts`)
    })
  })
}
