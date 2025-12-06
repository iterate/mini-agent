/**
 * Sucrase Transpiler
 *
 * Fast TypeScript-to-JavaScript transpiler using Sucrase.
 * Ideal for development due to its speed (10-20x faster than tsc).
 */
import { Effect, Layer } from "effect"
import { transform } from "sucrase"

import { TranspilationError } from "../errors.ts"
import { Transpiler } from "../services.ts"

interface SucraseError extends Error {
  loc?: { line: number; column: number }
}

export const SucraseTranspilerLive = Layer.succeed(
  Transpiler,
  Transpiler.of({
    transpile: (typescript, options) =>
      Effect.try({
        try: () => {
          const result = transform(typescript, {
            // Transform TypeScript and convert imports/exports to CommonJS
            transforms: ["typescript", "imports"],
            disableESTransforms: false,
            production: true,
            preserveDynamicImport: false,
            ...(options?.sourceMaps && {
              sourceMapOptions: { compiledFilename: "user-code.js" },
              filePath: "user-code.ts"
            })
          })
          return result.code
        },
        catch: (e) => {
          const err = e as SucraseError
          return new TranspilationError({
            source: "sucrase",
            message: err.message,
            location: err.loc
          })
        }
      })
  })
)
