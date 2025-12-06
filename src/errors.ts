/**
 * Domain Error Types
 *
 * Re-exports error types from domain.ts for backward compatibility.
 */
import { Schema } from "effect"
import { ContextName } from "./domain.ts"

// Re-export errors from domain
export { AgentError, AgentNotFoundError, ContextLoadError, ContextSaveError, ReducerError } from "./domain.ts"

// =============================================================================
// Legacy Error Types (for backward compatibility)
// =============================================================================

/** Error when a context is not found */
export class ContextNotFound extends Schema.TaggedError<ContextNotFound>()(
  "ContextNotFound",
  { name: ContextName }
) {}

/** Union of all context-related errors */
export const ContextError = Schema.Union(ContextNotFound)
export type ContextError = typeof ContextError.Type

// =============================================================================
// Configuration Errors
// =============================================================================

/** Error when configuration is invalid or missing */
export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
  "ConfigurationError",
  {
    key: Schema.String,
    message: Schema.String
  }
) {}

// =============================================================================
// LLM Errors
// =============================================================================

/** Error when LLM request fails */
export class LLMError extends Schema.TaggedError<LLMError>()(
  "LLMError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect)
  }
) {}
