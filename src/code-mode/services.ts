/**
 * Code Mode Service Interfaces
 */
import type { Effect } from "effect"
import { Context } from "effect"

import type { ExecutionError, SecurityViolation, TimeoutError, TranspilationError, TypeCheckError } from "./errors.ts"
import type {
  CodeModeConfig,
  CompiledModule,
  ExecutionResult,
  TypeCheckConfig,
  TypeCheckResult,
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
 * Type-checks TypeScript code using the compiler API
 */
export class TypeChecker extends Context.Tag("@app/code-mode/TypeChecker")<
  TypeChecker,
  {
    readonly check: (
      typescript: string,
      config: TypeCheckConfig
    ) => Effect.Effect<TypeCheckResult, TypeCheckError>
  }
>() {}

/**
 * Executes validated JavaScript
 */
export class Executor extends Context.Tag("@app/code-mode/Executor")<
  Executor,
  {
    readonly execute: <TCtx extends object, TResult>(
      javascript: string,
      ctx: TCtx,
      config: CodeModeConfig
    ) => Effect.Effect<ExecutionResult<TResult>, ExecutionError | TimeoutError | SecurityViolation>
  }
>() {}

/**
 * Main API: type-check → transpile → validate → execute
 */
export class CodeMode extends Context.Tag("@app/code-mode/CodeMode")<
  CodeMode,
  {
    readonly run: <TCtx extends object, TResult>(
      typescript: string,
      ctx: TCtx,
      config?: Partial<CodeModeConfig>
    ) => Effect.Effect<
      ExecutionResult<TResult>,
      TranspilationError | TypeCheckError | ExecutionError | TimeoutError | SecurityViolation
    >

    readonly compile: <TCtx extends object>(
      typescript: string,
      config?: Partial<CodeModeConfig>
    ) => Effect.Effect<CompiledModule<TCtx>, TranspilationError | TypeCheckError | SecurityViolation>
  }
>() {}
