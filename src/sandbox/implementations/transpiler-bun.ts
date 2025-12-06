/**
 * Bun Native Transpiler
 *
 * Uses Bun's built-in transpiler which is extremely fast.
 * Only works in Bun runtime!
 */
import { Effect, Layer } from "effect"

import { TranspilationError } from "../errors.ts"
import { Transpiler } from "../services.ts"

export const BunTranspilerLive = Layer.succeed(
  Transpiler,
  Transpiler.of({
    transpile: (typescript, _options) =>
      Effect.try({
        try: () => {
          // Bun.Transpiler is synchronous and extremely fast
          const transpiler = new Bun.Transpiler({
            loader: "ts",
            target: "browser", // Use browser target for clean output
            trimUnusedImports: true
          })
          return transpiler.transformSync(typescript)
        },
        catch: (e) => {
          const err = e as Error
          return new TranspilationError({
            source: "bun",
            message: err.message,
            location: undefined,
            cause: err
          })
        }
      })
  })
)
