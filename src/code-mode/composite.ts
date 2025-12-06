/**
 * Code Mode Composite Service
 *
 * Orchestrates: transpile → validate → execute
 */
import { Effect, Layer } from "effect"

import { SecurityViolation } from "./errors.ts"
import { CodeMode, Executor, Transpiler, Validator } from "./services.ts"
import type { CallbackRecord, CodeModeConfig, CompiledModule, ParentContext } from "./types.ts"
import { defaultConfig } from "./types.ts"

function computeHash(str: string): string {
  if (typeof Bun !== "undefined" && Bun.hash) {
    return Bun.hash(str).toString(16)
  }
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(16)
}

export const CodeModeLive = Layer.effect(
  CodeMode,
  Effect.gen(function*() {
    const transpiler = yield* Transpiler
    const validator = yield* Validator
    const executor = yield* Executor

    const compile = Effect.fn("CodeMode.compile")(function*<
      TCallbacks extends CallbackRecord,
      TData
    >(
      typescript: string,
      config?: Partial<CodeModeConfig>
    ) {
      const fullConfig = { ...defaultConfig, ...config }

      const javascript = yield* transpiler.transpile(typescript)

      const validation = yield* validator.validate(javascript, fullConfig)
      if (!validation.valid) {
        return yield* Effect.fail(
          new SecurityViolation({
            details: validation.errors.map((e) => `${e.type}: ${e.message}`).join("; ")
          })
        )
      }

      const hash = computeHash(javascript)

      return {
        javascript,
        hash,
        execute: <TResult>(parentContext: ParentContext<TCallbacks, TData>) =>
          executor.execute<TCallbacks, TData, TResult>(javascript, parentContext, fullConfig)
      } as CompiledModule<TCallbacks, TData>
    })

    const run = Effect.fn("CodeMode.run")(function*<
      TCallbacks extends CallbackRecord,
      TData,
      TResult
    >(
      typescript: string,
      parentContext: ParentContext<TCallbacks, TData>,
      config?: Partial<CodeModeConfig>
    ) {
      const compiled = yield* compile<TCallbacks, TData>(typescript, config)
      return yield* compiled.execute<TResult>(parentContext)
    })

    return CodeMode.of({ run, compile })
  })
)
