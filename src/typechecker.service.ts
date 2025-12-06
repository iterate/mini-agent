/**
 * TypeScript Typechecker Service
 *
 * Wraps the TypeScript compiler API to typecheck generated code files.
 * Returns typed errors with formatted diagnostics for LLM feedback.
 */
import { FileSystem } from "@effect/platform"
import { Context, Effect, Layer, Option } from "effect"
import ts from "typescript"
import { TypecheckError } from "./errors.ts"

/** Interface for the typechecker service - doesn't expose internal deps */
interface TypecheckServiceInterface {
  /**
   * Typecheck files with TypeScript compiler.
   * Returns Option.none on success, Option.some(error) on type errors.
   */
  readonly check: (
    filePaths: ReadonlyArray<string>,
    configPath?: string
  ) => Effect.Effect<Option.Option<TypecheckError>>
}

export class TypecheckService extends Context.Tag("@app/TypecheckService")<
  TypecheckService,
  TypecheckServiceInterface
>() {
  static readonly layer = Layer.effect(
    TypecheckService,
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem

      const check = (
        filePaths: ReadonlyArray<string>,
        configPath?: string
      ): Effect.Effect<Option.Option<TypecheckError>> =>
        Effect.gen(function*() {
          // Load compiler options from tsconfig if provided
          let compilerOptions: ts.CompilerOptions = {
            target: ts.ScriptTarget.ESNext,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            noUncheckedIndexedAccess: true,
            lib: ["lib.esnext.d.ts"]
          }

          if (configPath) {
            const configExists = yield* fs.exists(configPath)
            if (configExists) {
              const configText = yield* fs.readFileString(configPath)
              const configJson = ts.parseConfigFileTextToJson(configPath, configText)
              if (!configJson.error) {
                const parsed = ts.parseJsonConfigFileContent(
                  configJson.config,
                  ts.sys,
                  configPath.slice(0, configPath.lastIndexOf("/"))
                )
                compilerOptions = { ...compilerOptions, ...parsed.options }
              }
            }
          }

          // Create program and get diagnostics
          const program = ts.createProgram(filePaths as Array<string>, compilerOptions)
          const diagnostics = ts.getPreEmitDiagnostics(program)

          if (diagnostics.length === 0) {
            return Option.none()
          }

          // Format diagnostics for readability
          const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
            getCurrentDirectory: () => process.cwd(),
            getCanonicalFileName: (fileName) => fileName,
            getNewLine: () => "\n"
          })

          return Option.some(
            new TypecheckError({
              diagnostics: formatted,
              filePath: filePaths[0] ?? ""
            })
          )
        }).pipe(Effect.orDie) // File read errors become defects - shouldn't happen in normal operation

      return TypecheckService.of({ check })
    })
  )

  static readonly testLayer = Layer.succeed(
    TypecheckService,
    TypecheckService.of({
      check: () => Effect.succeed(Option.none())
    })
  )
}
