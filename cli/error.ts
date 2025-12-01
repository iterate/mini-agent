/**
 * CLI Error Handling
 * 
 * Centralized error rendering for CLI commands.
 * Handles Effect tagged errors, standard Errors, and unknown values.
 */

import { Console, Effect } from "effect"

// =============================================================================
// Error Rendering
// =============================================================================

/**
 * Render an error to stderr in a consistent format.
 * Handles:
 * - Effect tagged errors (with _tag property)
 * - Standard Error instances
 * - Unknown values
 */
export const renderError = (error: unknown): Effect.Effect<void> => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = (error as { _tag: string })._tag
    // For tagged errors, show the tag and relevant fields
    const { _tag, ...rest } = error as Record<string, unknown>
    const details = Object.keys(rest).length > 0 ? `: ${JSON.stringify(rest)}` : ""
    return Console.error(`Error [${tag}]${details}`)
  }

  if (error instanceof Error) {
    return Console.error(`Error: ${error.message}`)
  }

  return Console.error(`Error: ${String(error)}`)
}

/**
 * Error handler that can be used with Effect.catchAll
 */
export const handleError = <E>(error: E): Effect.Effect<void> => renderError(error)

/**
 * Wrap an effect with standard error handling
 */
export const withErrorHandler = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A | void, never, R> =>
  effect.pipe(Effect.catchAll(handleError))

