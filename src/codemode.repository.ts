/**
 * Codemode Repository
 *
 * Manages storage of generated code files in context-scoped directories.
 * Structure: .mini-agent/contexts/<context-name>/<request-id>/<codeblock-id>/
 *
 * Each codeblock directory contains:
 * - index.ts: The generated code
 * - types.ts: Type definitions for available tools
 * - tsconfig.json: TypeScript compiler config
 * - response.md: LLM conversation log
 */
import { FileSystem, Path } from "@effect/platform"
import { Context, Effect, Layer, Option } from "effect"
import type { CodeblockId, RequestId } from "./codemode.model.ts"
import { AppConfig } from "./config.ts"
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
 * Tools available to generated code.
 * The default function receives this interface and returns Promise<void>.
 *
 * Output channels:
 * - t.sendMessage(): writes to stderr -> user sees, agent does NOT
 * - console.log(): writes to stdout -> agent sees, may trigger continuation
 */
export interface Tools {
  /** Send a message to the USER. They see this. Does NOT trigger another turn. */
  readonly sendMessage: (message: string) => Promise<void>

  /** Read a file from the filesystem */
  readonly readFile: (path: string) => Promise<string>

  /** Write a file to the filesystem */
  readonly writeFile: (path: string, content: string) => Promise<void>

  /** Execute a shell command */
  readonly exec: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>

  /** Fetch a URL and return its content */
  readonly fetch: (url: string) => Promise<string>

  /** Get a secret value. The implementation is hidden from the LLM. */
  readonly getSecret: (name: string) => Promise<string | undefined>

  /** Evaluate a mathematical expression */
  readonly calculate: (expression: string) => Promise<{ result: number; steps: Array<string> }>

  /** Get current timestamp as ISO string */
  readonly now: () => Promise<string>

  /** Sleep for specified milliseconds */
  readonly sleep: (ms: number) => Promise<void>
}
`

/** Location of a codeblock within the context structure */
export interface CodeblockLocation {
  readonly contextName: string
  readonly requestId: RequestId
  readonly codeblockId: CodeblockId
}

/** CodemodeRepository interface */
interface CodemodeRepositoryService {
  /** Get the codeblock directory path */
  readonly getCodeblockDir: (loc: CodeblockLocation) => Effect.Effect<string>

  /** Create the codeblock directory with all necessary files */
  readonly createCodeblockDir: (loc: CodeblockLocation) => Effect.Effect<string, CodeStorageError>

  /** Write the generated code to index.ts */
  readonly writeCode: (
    loc: CodeblockLocation,
    code: string,
    attempt: number
  ) => Effect.Effect<string, CodeStorageError>

  /** Append to response.md log */
  readonly appendLog: (loc: CodeblockLocation, content: string) => Effect.Effect<void, CodeStorageError>

  /** Get the index.ts path for a codeblock */
  readonly getCodePath: (loc: CodeblockLocation) => Effect.Effect<string>
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
      const config = yield* AppConfig
      const cwd = Option.getOrElse(config.cwd, () => process.cwd())
      const contextsDir = pathService.join(cwd, config.dataStorageDir, "contexts")

      /** Build path to codeblock directory */
      const buildCodeblockPath = (loc: CodeblockLocation) =>
        pathService.join(contextsDir, loc.contextName, loc.requestId, loc.codeblockId)

      const getCodeblockDir = (loc: CodeblockLocation) => Effect.succeed(buildCodeblockPath(loc))

      const createCodeblockDir = (loc: CodeblockLocation) =>
        Effect.gen(function*() {
          const dir = buildCodeblockPath(loc)

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

      const writeCode = (loc: CodeblockLocation, code: string, attempt: number) =>
        Effect.gen(function*() {
          const dir = buildCodeblockPath(loc)

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

      const appendLog = (loc: CodeblockLocation, content: string) =>
        Effect.gen(function*() {
          const dir = buildCodeblockPath(loc)
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

      const getCodePath = (loc: CodeblockLocation) =>
        Effect.succeed(pathService.join(buildCodeblockPath(loc), "index.ts"))

      return CodemodeRepository.of({
        getCodeblockDir,
        createCodeblockDir,
        writeCode,
        appendLog,
        getCodePath
      })
    })
  )

  static readonly testLayer = Layer.sync(CodemodeRepository, () => {
    const store = new Map<string, Map<string, string>>()

    const getKey = (loc: CodeblockLocation) => `${loc.contextName}/${loc.requestId}/${loc.codeblockId}`

    const getOrCreateDir = (loc: CodeblockLocation) => {
      const key = getKey(loc)
      if (!store.has(key)) {
        store.set(key, new Map())
      }
      return store.get(key)!
    }

    return CodemodeRepository.of({
      getCodeblockDir: (loc) => Effect.succeed(`/tmp/.mini-agent/contexts/${getKey(loc)}`),
      createCodeblockDir: (loc) => {
        getOrCreateDir(loc)
        return Effect.succeed(`/tmp/.mini-agent/contexts/${getKey(loc)}`)
      },
      writeCode: (loc, code, _attempt) => {
        const dir = getOrCreateDir(loc)
        dir.set("index.ts", code)
        return Effect.succeed(`/tmp/.mini-agent/contexts/${getKey(loc)}/index.ts`)
      },
      appendLog: (loc, content) => {
        const dir = getOrCreateDir(loc)
        const existing = dir.get("response.md") ?? ""
        dir.set("response.md", existing + content)
        return Effect.succeed(undefined)
      },
      getCodePath: (loc) => Effect.succeed(`/tmp/.mini-agent/contexts/${getKey(loc)}/index.ts`)
    })
  })
}
