/**
 * TypeScript Sandbox
 *
 * Executes untrusted TypeScript in isolation with parent-provided callbacks and data.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { TypeScriptSandbox, DevFastLayer } from "./sandbox/index.ts"
 *
 * const userCode = `
 *   export default async (ctx) => {
 *     const result = await ctx.callbacks.fetchData("key")
 *     return { value: ctx.data.multiplier * 2, fetched: result }
 *   }
 * `
 *
 * const program = Effect.gen(function*() {
 *   const sandbox = yield* TypeScriptSandbox
 *   return yield* sandbox.run(userCode, {
 *     callbacks: {
 *       fetchData: async (key) => `data for ${key}`
 *     },
 *     data: { multiplier: 21 }
 *   })
 * })
 *
 * const result = await Effect.runPromise(program.pipe(Effect.provide(DevFastLayer)))
 * // result.value = { value: 42, fetched: "data for key" }
 * ```
 */

// Types
export type {
  CallbackRecord,
  CompiledModule,
  ExecutionResult,
  ParentContext,
  SandboxConfig,
  ValidationResult
} from "./types.ts"
export { defaultSandboxConfig } from "./types.ts"

// Errors
export {
  ExecutionError,
  SandboxError,
  SecurityViolation,
  TimeoutError,
  TranspilationError,
  ValidationError,
  ValidationWarning
} from "./errors.ts"

// Services
export { CodeValidator, SandboxExecutor, Transpiler, TypeScriptSandbox } from "./services.ts"

// Implementations (for custom layer composition)
export { TypeScriptSandboxLive } from "./composite.ts"
export { BunWorkerExecutorLive } from "./implementations/executor-bun-worker.ts"
export { UnsafeExecutorLive } from "./implementations/executor-unsafe.ts"
export { BunTranspilerLive } from "./implementations/transpiler-bun.ts"
export { SucraseTranspilerLive } from "./implementations/transpiler-sucrase.ts"
export { AcornValidatorLive } from "./implementations/validator-acorn.ts"

// Pre-composed layers
export { BunFastLayer, BunProductionLayer, DevFastLayer, DevSafeLayer } from "./layers.ts"
