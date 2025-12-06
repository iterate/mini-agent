/**
 * TypeScript Sandbox Layer Compositions
 *
 * Pre-composed layers for different runtime environments and use cases.
 * Uses Layer.mergeAll to combine independent implementation layers,
 * then Layer.provide to satisfy TypeScriptSandboxLive's dependencies.
 */
import { Layer } from "effect"

import { TypeScriptSandboxLive } from "./composite.ts"
import { BunWorkerExecutorLive } from "./implementations/executor-bun-worker.ts"
import { UnsafeExecutorLive } from "./implementations/executor-unsafe.ts"
import { BunTranspilerLive } from "./implementations/transpiler-bun.ts"
import { SucraseTranspilerLive } from "./implementations/transpiler-sucrase.ts"
import { AcornValidatorLive } from "./implementations/validator-acorn.ts"

/**
 * Development - Maximum Speed
 * - Sucrase (fastest JS transpiler)
 * - Acorn validator
 * - Unsafe eval executor (no isolation!)
 *
 * Use for: Unit tests, rapid iteration
 * DO NOT use for: Production, untrusted code
 */
export const DevFastLayer = TypeScriptSandboxLive.pipe(
  Layer.provide(Layer.mergeAll(
    SucraseTranspilerLive,
    AcornValidatorLive,
    UnsafeExecutorLive
  ))
)

/**
 * Development - With Isolation (Bun)
 * - Sucrase transpiler
 * - Acorn validator
 * - Bun Worker executor (V8 isolate separation)
 *
 * Use for: Integration tests, staging with some isolation
 */
export const DevSafeLayer = TypeScriptSandboxLive.pipe(
  Layer.provide(Layer.mergeAll(
    SucraseTranspilerLive,
    AcornValidatorLive,
    BunWorkerExecutorLive
  ))
)

/**
 * Production Bun - Native
 * - Bun native transpiler (fastest, Bun-only)
 * - Acorn validator
 * - Bun Worker executor (true process isolation)
 *
 * Use for: Production Bun servers
 */
export const BunProductionLayer = TypeScriptSandboxLive.pipe(
  Layer.provide(Layer.mergeAll(
    BunTranspilerLive,
    AcornValidatorLive,
    BunWorkerExecutorLive
  ))
)

/**
 * Production Bun - Fast (no isolation)
 * - Bun native transpiler
 * - Acorn validator
 * - Unsafe executor (fast but no isolation)
 *
 * Use for: Trusted code execution where speed matters
 * DO NOT use for: Untrusted user code
 */
export const BunFastLayer = TypeScriptSandboxLive.pipe(
  Layer.provide(Layer.mergeAll(
    BunTranspilerLive,
    AcornValidatorLive,
    UnsafeExecutorLive
  ))
)
