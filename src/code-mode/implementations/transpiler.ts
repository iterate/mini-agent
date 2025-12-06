/**
 * TypeScript Transpiler
 *
 * Uses Bun.Transpiler when available, falls back to sucrase for Node/vitest.
 */
import { Effect, Layer } from "effect"
import { transform } from "sucrase"

import { TranspilationError } from "../errors.ts"
import { Transpiler } from "../services.ts"

const isBunAvailable = typeof globalThis.Bun !== "undefined"

export const TranspilerLive = Layer.succeed(
  Transpiler,
  Transpiler.of({
    transpile: (typescript) =>
      Effect.try({
        try: () => {
          if (isBunAvailable) {
            const transpiler = new Bun.Transpiler({
              loader: "ts",
              target: "browser",
              trimUnusedImports: true
            })
            return transpiler.transformSync(typescript)
          }
          // Fallback to sucrase for Node/vitest
          // Must include "imports" to convert ESM to CommonJS for eval()
          const result = transform(typescript, {
            transforms: ["typescript", "imports"]
          })
          return result.code
        },
        catch: (e) => {
          const err = e as Error
          return new TranspilationError({
            message: err.message
          })
        }
      })
  })
)
