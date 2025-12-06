/**
 * TypeScript Sandbox Composite Service
 *
 * Orchestrates validation, transpilation, and execution into a single API.
 * Uses Effect.fn for automatic tracing and span creation.
 */
import { Effect, Layer } from "effect"

import { SecurityViolation } from "./errors.ts"
import { CodeValidator, SandboxExecutor, Transpiler, TypeScriptSandbox } from "./services.ts"
import type { CallbackRecord, CompiledModule, ParentContext, SandboxConfig } from "./types.ts"
import { defaultSandboxConfig } from "./types.ts"

function computeHash(str: string): string {
  // Simple hash for caching - uses Bun.hash if available, falls back to basic
  if (typeof Bun !== "undefined" && Bun.hash) {
    return Bun.hash(str).toString(16)
  }
  // Fallback: simple string hash
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16)
}

export const TypeScriptSandboxLive = Layer.effect(
  TypeScriptSandbox,
  Effect.gen(function*() {
    const transpiler = yield* Transpiler
    const validator = yield* CodeValidator
    const executor = yield* SandboxExecutor

    // Wrapped with Effect.fn for automatic tracing spans
    const compile = Effect.fn("TypeScriptSandbox.compile")(function*<
      TCallbacks extends CallbackRecord,
      TData
    >(
      typescript: string,
      config?: Partial<SandboxConfig>
    ) {
      const fullConfig = { ...defaultSandboxConfig, ...config }

      // Transpile TypeScript to JavaScript first
      // (Acorn validator can only parse JavaScript, not TypeScript)
      const javascript = yield* transpiler.transpile(typescript)

      // Validate transpiled JavaScript for security
      const validation = yield* validator.validate(javascript, fullConfig)
      if (!validation.valid) {
        return yield* Effect.fail(
          new SecurityViolation({
            violation: "validation_failed",
            details: validation.errors.map((e) => `${e.type}: ${e.message}`).join("; ")
          })
        )
      }

      // Compute hash for caching
      const hash = computeHash(javascript)

      return {
        javascript,
        hash,
        execute: <TResult>(parentContext: ParentContext<TCallbacks, TData>) =>
          executor.execute<TCallbacks, TData, TResult>(
            javascript,
            parentContext,
            fullConfig
          )
      } as CompiledModule<TCallbacks, TData>
    })

    // Wrapped with Effect.fn for automatic tracing spans
    const run = Effect.fn("TypeScriptSandbox.run")(function*<
      TCallbacks extends CallbackRecord,
      TData,
      TResult
    >(
      typescript: string,
      parentContext: ParentContext<TCallbacks, TData>,
      config?: Partial<SandboxConfig>
    ) {
      const compiled = yield* compile<TCallbacks, TData>(typescript, config)
      return yield* compiled.execute<TResult>(parentContext)
    })

    return TypeScriptSandbox.of({ run, compile })
  })
)
