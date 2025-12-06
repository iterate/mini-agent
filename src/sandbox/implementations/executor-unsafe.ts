/**
 * Unsafe Executor (eval-based, dev only)
 *
 * WARNING: This executor provides NO isolation!
 * Use only for development/testing where speed matters more than security.
 * User code runs in the same V8 context as the host.
 */
import { Duration, Effect, Layer } from "effect"

import { ExecutionError, TimeoutError } from "../errors.ts"
import { SandboxExecutor } from "../services.ts"
import type { CallbackRecord, ExecutionResult, ParentContext, SandboxConfig } from "../types.ts"

export const UnsafeExecutorLive = Layer.succeed(
  SandboxExecutor,
  SandboxExecutor.of({
    execute: <TCallbacks extends CallbackRecord, TData, TResult>(
      javascript: string,
      parentContext: ParentContext<TCallbacks, TData>,
      config: SandboxConfig
    ): Effect.Effect<ExecutionResult<TResult>, ExecutionError | TimeoutError> =>
      Effect.gen(function*() {
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

        // Create the function (may throw on syntax error)
        const fn = yield* Effect.try({
          try: () => eval(wrappedCode) as (ctx: ParentContext<TCallbacks, TData>) => unknown,
          catch: (e) =>
            new ExecutionError({
              message: (e as Error).message,
              stack: (e as Error).stack,
              cause: e as Error
            })
        })

        // Execute with timeout (handles both sync and async results)
        const value = yield* Effect.tryPromise({
          try: () => Promise.resolve(fn(parentContext)),
          catch: (e) =>
            new ExecutionError({
              message: (e as Error).message,
              stack: (e as Error).stack,
              cause: e as Error
            })
        }).pipe(
          Effect.timeoutFail({
            duration: Duration.millis(config.timeoutMs),
            onTimeout: () => new TimeoutError({ timeoutMs: config.timeoutMs })
          })
        )

        return {
          value: value as TResult,
          durationMs: performance.now() - start,
          metadata: { executor: "unsafe-eval", isolated: false }
        }
      })
  })
)
