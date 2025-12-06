/**
 * Code Mode Composite Service
 *
 * Orchestrates: type-check → transpile → validate → execute
 */
import { Effect, Layer } from "effect"

import { SecurityViolation } from "./errors.ts"
import { CodeMode, Executor, Transpiler, TypeChecker, Validator } from "./services.ts"
import type { CodeModeConfig, CompiledModule } from "./types.ts"
import { defaultConfig, defaultTypeCheckConfig } from "./types.ts"

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
    const typeChecker = yield* TypeChecker
    const transpiler = yield* Transpiler
    const validator = yield* Validator
    const executor = yield* Executor

    const compile = Effect.fn("CodeMode.compile")(function*<TCtx extends object>(
      typescript: string,
      config?: Partial<CodeModeConfig>
    ) {
      const fullConfig = {
        ...defaultConfig,
        ...config,
        typeCheck: { ...defaultTypeCheckConfig, ...config?.typeCheck }
      }

      // Type check first (if enabled)
      yield* typeChecker.check(typescript, fullConfig.typeCheck)

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
        execute: <TResult>(ctx: TCtx) => executor.execute<TCtx, TResult>(javascript, ctx, fullConfig)
      } as CompiledModule<TCtx>
    })

    const run = Effect.fn("CodeMode.run")(function*<TCtx extends object, TResult>(
      typescript: string,
      ctx: TCtx,
      config?: Partial<CodeModeConfig>
    ) {
      const compiled = yield* compile<TCtx>(typescript, config)
      return yield* compiled.execute<TResult>(ctx)
    })

    return CodeMode.of({ run, compile })
  })
)
