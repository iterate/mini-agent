/**
 * Code Mode Service Interfaces
 */
import type { Effect } from "effect"
import { Context } from "effect"

import type { ExecutionError, SecurityViolation, TimeoutError, TranspilationError } from "./errors.ts"
import type {
  CallbackRecord,
  CodeModeConfig,
  CompiledModule,
  ExecutionResult,
  ParentContext,
  ValidationResult
} from "./types.ts"

/**
 * Transpiles TypeScript to JavaScript
 */
export class Transpiler extends Context.Tag("@app/code-mode/Transpiler")<
  Transpiler,
  {
    readonly transpile: (typescript: string) => Effect.Effect<string, TranspilationError>
  }
>() {}

/**
 * Validates JavaScript for security violations
 */
export class Validator extends Context.Tag("@app/code-mode/Validator")<
  Validator,
  {
    readonly validate: (
      code: string,
      config: CodeModeConfig
    ) => Effect.Effect<ValidationResult, never>
  }
>() {}

/**
 * Executes validated JavaScript
 */
export class Executor extends Context.Tag("@app/code-mode/Executor")<
  Executor,
  {
    readonly execute: <TCallbacks extends CallbackRecord, TData, TResult>(
      javascript: string,
      parentContext: ParentContext<TCallbacks, TData>,
      config: CodeModeConfig
    ) => Effect.Effect<ExecutionResult<TResult>, ExecutionError | TimeoutError | SecurityViolation>
  }
>() {}

/**
 * Main API: transpile → validate → execute
 */
export class CodeMode extends Context.Tag("@app/code-mode/CodeMode")<
  CodeMode,
  {
    readonly run: <TCallbacks extends CallbackRecord, TData, TResult>(
      typescript: string,
      parentContext: ParentContext<TCallbacks, TData>,
      config?: Partial<CodeModeConfig>
    ) => Effect.Effect<
      ExecutionResult<TResult>,
      TranspilationError | ExecutionError | TimeoutError | SecurityViolation
    >

    readonly compile: <TCallbacks extends CallbackRecord, TData>(
      typescript: string,
      config?: Partial<CodeModeConfig>
    ) => Effect.Effect<CompiledModule<TCallbacks, TData>, TranspilationError | SecurityViolation>
  }
>() {}
