/**
 * Bun Worker Executor
 *
 * Uses Bun Workers for true process isolation.
 *
 * Provides:
 * - Separate V8 isolate (different thread)
 * - Timeout via worker termination
 * - True isolation from parent process
 *
 * Limitations:
 * - Callbacks are async (message passing overhead)
 * - Data is serialized/deserialized (structuredClone)
 */
import { Effect, Layer } from "effect"

import { ExecutionError, TimeoutError } from "../errors.ts"
import { SandboxExecutor } from "../services.ts"
import type { CallbackRecord, ExecutionResult, ParentContext, SandboxConfig } from "../types.ts"

interface WorkerMessage {
  type: "callback" | "success" | "error" | "callback_response"
  name?: string
  args?: Array<unknown>
  callId?: string
  value?: unknown
  result?: unknown
  message?: string
  stack?: string
  error?: string
}

export const BunWorkerExecutorLive = Layer.succeed(
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

        // Worker code that executes user code and proxies callbacks
        const workerCode = `
          // Receive initial data
          self.onmessage = async (event) => {
            if (event.data.type !== 'init') return;

            const { javascript, data, callbackNames } = event.data;

            // Pending callback responses
            const pendingCallbacks = new Map();

            // Handle callback responses from parent
            self.onmessage = (responseEvent) => {
              if (responseEvent.data.type === 'callback_response') {
                const { callId, result, error } = responseEvent.data;
                const pending = pendingCallbacks.get(callId);
                if (pending) {
                  pendingCallbacks.delete(callId);
                  if (error) {
                    pending.reject(new Error(error));
                  } else {
                    pending.resolve(result);
                  }
                }
              }
            };

            // Create callback proxies that postMessage to parent
            const callbacks = {};
            for (const name of callbackNames) {
              callbacks[name] = (...args) => {
                return new Promise((resolve, reject) => {
                  const callId = crypto.randomUUID();
                  pendingCallbacks.set(callId, { resolve, reject });
                  postMessage({ type: 'callback', name, args, callId });
                });
              };
            }

            const ctx = { callbacks, data };

            try {
              // Execute user code
              const module = { exports: {} };
              const exports = module.exports;

              const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
              const fn = new AsyncFunction('ctx', 'module', 'exports', \`
                \${javascript}
                const exported = module.exports.default || module.exports;
                if (typeof exported === 'function') {
                  return await exported(ctx);
                }
                return exported;
              \`);

              const result = await fn(ctx, module, module.exports);
              postMessage({ type: 'success', value: result });
            } catch (e) {
              postMessage({ type: 'error', message: e.message, stack: e.stack });
            }
          };
        `

        // Create blob URL for worker
        const blob = new Blob([workerCode], { type: "application/javascript" })
        const url = URL.createObjectURL(blob)

        // Prepare callback names (functions can't be serialized)
        const callbackNames = Object.keys(parentContext.callbacks)

        // Create worker
        const worker = new Worker(url)

        // Timeout handling
        const timeoutId = setTimeout(() => {
          worker.terminate()
          URL.revokeObjectURL(url)
          resume(Effect.fail(new TimeoutError({ timeoutMs: config.timeoutMs })))
        }, config.timeoutMs)

        // Message handling
        worker.onmessage = async (event: MessageEvent<WorkerMessage>) => {
          const { type, ...payload } = event.data

          switch (type) {
            case "callback": {
              // Proxy callback invocation to parent
              const { args, callId, name } = payload
              if (!name || !callId) return

              try {
                const callback = parentContext.callbacks[name]
                if (!callback) {
                  worker.postMessage({
                    type: "callback_response",
                    callId,
                    error: `Unknown callback: ${name}`
                  })
                  return
                }
                const result = await callback(...(args || []))
                worker.postMessage({ type: "callback_response", callId, result })
              } catch (e) {
                const err = e as Error
                worker.postMessage({
                  type: "callback_response",
                  callId,
                  error: err.message
                })
              }
              break
            }

            case "success": {
              clearTimeout(timeoutId)
              worker.terminate()
              URL.revokeObjectURL(url)
              resume(
                Effect.succeed({
                  value: payload.value as TResult,
                  durationMs: performance.now() - start,
                  metadata: { executor: "bun-worker", isolated: true }
                })
              )
              break
            }

            case "error": {
              clearTimeout(timeoutId)
              worker.terminate()
              URL.revokeObjectURL(url)
              resume(
                Effect.fail(
                  new ExecutionError({
                    message: payload.message || "Unknown error",
                    stack: payload.stack
                  })
                )
              )
              break
            }
          }
        }

        worker.onerror = (error) => {
          clearTimeout(timeoutId)
          worker.terminate()
          URL.revokeObjectURL(url)
          resume(
            Effect.fail(
              new ExecutionError({
                message: error.message || "Worker error",
                stack: undefined
              })
            )
          )
        }

        // Send initial data to worker
        worker.postMessage({
          type: "init",
          javascript,
          data: parentContext.data,
          callbackNames
        })
      })
  })
)
