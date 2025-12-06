/**
 * Code Mode
 *
 * Executes untrusted TypeScript with controlled access to parent capabilities.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { CodeMode, CodeModeLive } from "./code-mode"
 *
 * const program = Effect.gen(function*() {
 *   const codeMode = yield* CodeMode
 *   return yield* codeMode.run(
 *     `export default async (ctx) => {
 *       const data = await ctx.callbacks.fetchData("key")
 *       return { value: ctx.data.multiplier * 2, fetched: data }
 *     }`,
 *     {
 *       callbacks: { fetchData: async (key) => `data for ${key}` },
 *       data: { multiplier: 21 }
 *     }
 *   )
 * })
 *
 * const result = await Effect.runPromise(program.pipe(Effect.provide(CodeModeLive)))
 * ```
 */
import { Layer } from "effect"

import { CodeModeLive as CodeModeComposite } from "./composite.ts"
import { ExecutorLive } from "./implementations/executor.ts"
import { TranspilerLive } from "./implementations/transpiler.ts"
import { ValidatorLive } from "./implementations/validator.ts"

// Types
export type {
  CallbackRecord,
  CodeModeConfig,
  CompiledModule,
  ExecutionResult,
  ParentContext,
  ValidationResult
} from "./types.ts"
export { defaultConfig } from "./types.ts"

// Errors
export {
  CodeModeError,
  ExecutionError,
  SecurityViolation,
  TimeoutError,
  TranspilationError,
  ValidationError,
  ValidationWarning
} from "./errors.ts"

// Services
export { CodeMode, Executor, Transpiler, Validator } from "./services.ts"

// Implementations (for custom composition)
export { ExecutorLive } from "./implementations/executor.ts"
export { TranspilerLive } from "./implementations/transpiler.ts"
export { ValidatorLive } from "./implementations/validator.ts"

// Default layer
export const CodeModeLive = CodeModeComposite.pipe(
  Layer.provide(Layer.mergeAll(
    TranspilerLive,
    ValidatorLive,
    ExecutorLive
  ))
)
