/**
 * Code Executor
 *
 * Runs validated JavaScript with injected context.
 * Uses eval() - security comes from validation, not isolation.
 */
import { Effect, Layer } from "effect"

import { ExecutionError, TimeoutError } from "../errors.ts"
import { Executor } from "../services.ts"
import type { CallbackRecord, CodeModeConfig, ExecutionResult, ParentContext } from "../types.ts"

export const ExecutorLive = Layer.succeed(
  Executor,
  Executor.of({
    execute: <TCallbacks extends CallbackRecord, TData, TResult>(
      javascript: string,
      parentContext: ParentContext<TCallbacks, TData>,
      config: CodeModeConfig
    ): Effect.Effect<ExecutionResult<TResult>, ExecutionError | TimeoutError> =>
      Effect.async<ExecutionResult<TResult>, ExecutionError | TimeoutError>((resume) => {
        const start = performance.now()
        let completed = false
        let timeoutId: ReturnType<typeof setTimeout> | undefined

        const safeResume = (effect: Effect.Effect<ExecutionResult<TResult>, ExecutionError | TimeoutError>) => {
          if (completed) return
          completed = true
          if (timeoutId) clearTimeout(timeoutId)
          resume(effect)
        }

        // Wrap code to extract and call default export
        const wrappedCode = `
          (function(ctx) {
            const module = { exports: {} };
            const exports = module.exports;
            ${javascript}
            const exported = module.exports.default || module.exports;
            if (typeof exported === 'function') {
              return exported(ctx);
            }
            return exported;
          })
        `

        try {
          const fn = eval(wrappedCode) as (ctx: ParentContext<TCallbacks, TData>) => unknown

          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new TimeoutError({ timeoutMs: config.timeoutMs }))
            }, config.timeoutMs)
          })

          Promise.race([Promise.resolve(fn(parentContext)), timeoutPromise])
            .then((value) => {
              safeResume(
                Effect.succeed({
                  value: value as TResult,
                  durationMs: performance.now() - start
                })
              )
            })
            .catch((err) => {
              if (err instanceof TimeoutError) {
                safeResume(Effect.fail(err))
              } else {
                const e = err as Error
                safeResume(
                  Effect.fail(
                    new ExecutionError({
                      message: e.message,
                      stack: e.stack,
                      cause: e
                    })
                  )
                )
              }
            })
        } catch (e) {
          const err = e as Error
          safeResume(
            Effect.fail(
              new ExecutionError({
                message: err.message,
                stack: err.stack,
                cause: err
              })
            )
          )
        }

        return Effect.sync(() => {
          completed = true
          if (timeoutId) clearTimeout(timeoutId)
        })
      })
  })
)
