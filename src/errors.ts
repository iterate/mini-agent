/**
 * Domain Error Types
 *
 * Uses Schema.TaggedError for serializable, type-safe error handling.
 * See: https://www.effect.solutions/error-handling
 */
import { Schema } from "effect"
import { ContextName } from "./context.model.ts"

// =============================================================================
// Context Errors
// =============================================================================

/** Error when a context is not found */
export class ContextNotFound extends Schema.TaggedError<ContextNotFound>()(
  "ContextNotFound",
  { name: ContextName }
) {}

/** Error when loading a context fails */
export class ContextLoadError extends Schema.TaggedError<ContextLoadError>()(
  "ContextLoadError",
  {
    name: ContextName,
    cause: Schema.Defect
  }
) {}

/** Error when saving a context fails */
export class ContextSaveError extends Schema.TaggedError<ContextSaveError>()(
  "ContextSaveError",
  {
    name: ContextName,
    cause: Schema.Defect
  }
) {}

/** Union of all context-related errors */
export const ContextError = Schema.Union(
  ContextNotFound,
  ContextLoadError,
  ContextSaveError
)
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

// =============================================================================
// Codemode Errors
// =============================================================================

/** Error when TypeScript typechecking fails */
export class TypecheckError extends Schema.TaggedError<TypecheckError>()(
  "TypecheckError",
  {
    diagnostics: Schema.String,
    filePath: Schema.String
  }
) {}

/** Error when code execution fails */
export class CodeExecutionError extends Schema.TaggedError<CodeExecutionError>()(
  "CodeExecutionError",
  {
    exitCode: Schema.Number,
    stderr: Schema.String
  }
) {}

/** Error when code storage fails */
export class CodeStorageError extends Schema.TaggedError<CodeStorageError>()(
  "CodeStorageError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect)
  }
) {}

/** Union of codemode errors */
export const CodemodeError = Schema.Union(
  TypecheckError,
  CodeExecutionError,
  CodeStorageError
)
export type CodemodeError = typeof CodemodeError.Type
