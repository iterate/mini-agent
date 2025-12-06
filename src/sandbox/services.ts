/**
 * TypeScript Sandbox Service Interfaces
 *
 * Defines the contracts for transpiler, validator, executor, and composite sandbox.
 */
import type { Effect } from "effect"
import { Context } from "effect"

import type { ExecutionError, SecurityViolation, TimeoutError, TranspilationError } from "./errors.ts"
import type {
  CallbackRecord,
  CompiledModule,
  ExecutionResult,
  ParentContext,
  SandboxConfig,
  ValidationResult
} from "./types.ts"

/**
 * Transpiler service - converts TypeScript to JavaScript
 */
export class Transpiler extends Context.Tag("@app/sandbox/Transpiler")<
  Transpiler,
  {
    readonly transpile: (
      typescript: string,
      options?: { sourceMaps?: boolean }
    ) => Effect.Effect<string, TranspilationError>
  }
>() {}

/**
 * Code validator - static analysis for security
 */
export class CodeValidator extends Context.Tag("@app/sandbox/CodeValidator")<
  CodeValidator,
  {
    readonly validate: (
      code: string,
      config: SandboxConfig
    ) => Effect.Effect<ValidationResult, never>
  }
>() {}

/**
 * Sandbox executor - runs validated JS with parent context
 */
export class SandboxExecutor extends Context.Tag("@app/sandbox/SandboxExecutor")<
  SandboxExecutor,
  {
    readonly execute: <
      TCallbacks extends CallbackRecord,
      TData,
      TResult
    >(
      javascript: string,
      parentContext: ParentContext<TCallbacks, TData>,
      config: SandboxConfig
    ) => Effect.Effect<
      ExecutionResult<TResult>,
      ExecutionError | TimeoutError | SecurityViolation
    >
  }
>() {}

/**
 * Main API - composite service
 */
export class TypeScriptSandbox extends Context.Tag("@app/sandbox/TypeScriptSandbox")<
  TypeScriptSandbox,
  {
    /**
     * Full pipeline: validate -> transpile -> execute
     */
    readonly run: <
      TCallbacks extends CallbackRecord,
      TData,
      TResult
    >(
      typescript: string,
      parentContext: ParentContext<TCallbacks, TData>,
      config?: Partial<SandboxConfig>
    ) => Effect.Effect<
      ExecutionResult<TResult>,
      TranspilationError | ExecutionError | TimeoutError | SecurityViolation
    >

    /**
     * Compile once, get reusable executor (for hot paths)
     */
    readonly compile: <
      TCallbacks extends CallbackRecord,
      TData
    >(
      typescript: string,
      config?: Partial<SandboxConfig>
    ) => Effect.Effect<
      CompiledModule<TCallbacks, TData>,
      TranspilationError | SecurityViolation
    >
  }
>() {}
