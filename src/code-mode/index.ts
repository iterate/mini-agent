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
 *       const data = await ctx.fetchData("key")
 *       return { value: ctx.multiplier * 2, fetched: data }
 *     }`,
 *     {
 *       fetchData: async (key) => `data for ${key}`,
 *       multiplier: 21
 *     }
 *   )
 * })
 *
 * const result = await Effect.runPromise(program.pipe(Effect.provide(CodeModeLive)))
 * ```
 *
 * @example Type checking with preamble
 * ```ts
 * const result = yield* codeMode.run(
 *   `export default (ctx: Ctx) => ctx.value * 2`,
 *   { value: 21 },
 *   {
 *     typeCheck: {
 *       enabled: true,
 *       preamble: `interface Ctx { value: number }`,
 *       compilerOptions: { strict: true }
 *     }
 *   }
 * )
 * ```
 */
import { Layer } from "effect"

import { CodeModeLive as CodeModeComposite } from "./composite.ts"
import { ExecutorLive } from "./implementations/executor.ts"
import { TranspilerLive } from "./implementations/transpiler.ts"
import { TypeCheckerLive } from "./implementations/type-checker.ts"
import { ValidatorLive } from "./implementations/validator.ts"

// Types
export type {
  CodeModeConfig,
  CompiledModule,
  ExecutionResult,
  TypeCheckConfig,
  TypeCheckResult,
  ValidationResult
} from "./types.ts"
export { defaultConfig, defaultTypeCheckConfig } from "./types.ts"

// Errors
export {
  CodeModeError,
  ExecutionError,
  SecurityViolation,
  TimeoutError,
  TranspilationError,
  TypeCheckError,
  ValidationError,
  ValidationWarning
} from "./errors.ts"
export type { TypeCheckDiagnostic } from "./errors.ts"

// Services
export { CodeMode, Executor, Transpiler, TypeChecker, Validator } from "./services.ts"

// Implementations (for custom composition)
export { ExecutorLive } from "./implementations/executor.ts"
export { TranspilerLive } from "./implementations/transpiler.ts"
export { TypeCheckerLive } from "./implementations/type-checker.ts"
export { ValidatorLive } from "./implementations/validator.ts"

// Default layer
export const CodeModeLive = CodeModeComposite.pipe(
  Layer.provide(Layer.mergeAll(
    TypeCheckerLive,
    TranspilerLive,
    ValidatorLive,
    ExecutorLive
  ))
)
