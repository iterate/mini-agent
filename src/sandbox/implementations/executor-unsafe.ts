/**
 * Unsafe Executor (eval-based, dev only)
 *
 * WARNING: This executor provides NO isolation!
 * Use only for development/testing where speed matters more than security.
 * User code runs in the same V8 context as the host.
 */
import { Effect, Layer } from "effect"

import { ExecutionError, TimeoutError } from "../errors.ts"
import { SandboxExecutor } from "../services.ts"
import type { CallbackRecord, ExecutionResult, ParentContext, SandboxConfig } from "../types.ts"

export const UnsafeExecutorLive = Layer.succeed(
  SandboxExecutor,
  SandboxExecutor.of({
    execute: <
      TCallbacks extends CallbackRecord,
      TData,
      TResult
    >(
      javascript: string,
      parentContext: ParentContext<TCallbacks, TData>,
      config: SandboxConfig
    ) =>
      Effect.async<ExecutionResult<TResult>, ExecutionError | TimeoutError>((resume) => {
        const start = performance.now()

        // Wrap user code to extract and call the default export
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

        let timeoutId: ReturnType<typeof setTimeout> | undefined

        try {
          // Create the function (this is essentially eval)

          const fn = eval(wrappedCode) as (ctx: ParentContext<TCallbacks, TData>) => unknown

          // Set up timeout
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new TimeoutError({ timeoutMs: config.timeoutMs }))
            }, config.timeoutMs)
          })

          // Execute with context
          const resultOrPromise = fn(parentContext)

          // Handle both sync and async results with timeout
          Promise.race([
            Promise.resolve(resultOrPromise),
            timeoutPromise
          ])
            .then((value) => {
              if (timeoutId) clearTimeout(timeoutId)
              resume(
                Effect.succeed({
                  value: value as TResult,
                  durationMs: performance.now() - start,
                  metadata: { executor: "unsafe-eval", isolated: false }
                })
              )
            })
            .catch((err) => {
              if (timeoutId) clearTimeout(timeoutId)
              if (err instanceof TimeoutError) {
                resume(Effect.fail(err))
              } else {
                const e = err as Error
                resume(
                  Effect.fail(
                    new ExecutionError({
                      message: e.message,
                      stack: e.stack
                    })
                  )
                )
              }
            })
        } catch (e) {
          if (timeoutId) clearTimeout(timeoutId)
          const err = e as Error
          resume(
            Effect.fail(
              new ExecutionError({
                message: err.message,
                stack: err.stack
              })
            )
          )
        }
      })
  })
)
