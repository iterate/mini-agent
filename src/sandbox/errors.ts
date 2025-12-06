/**
 * TypeScript Sandbox Error Types
 *
 * Uses Schema.TaggedError for serializable, type-safe error handling.
 */
import { Schema } from "effect"

const SourceLocation = Schema.Struct({
  line: Schema.Number,
  column: Schema.Number
})

const ValidationErrorType = Schema.Literal(
  "import",
  "global",
  "syntax",
  "forbidden_construct"
)

export class ValidationError extends Schema.TaggedError<ValidationError>()(
  "ValidationError",
  {
    type: ValidationErrorType,
    message: Schema.String,
    location: Schema.optional(SourceLocation)
  }
) {}

const ValidationWarningType = Schema.String

export class ValidationWarning extends Schema.TaggedClass<ValidationWarning>()(
  "ValidationWarning",
  {
    type: ValidationWarningType,
    message: Schema.String,
    location: Schema.optional(SourceLocation)
  }
) {}

const TranspilerSource = Schema.Literal("sucrase", "esbuild", "bun", "typescript")

export class TranspilationError extends Schema.TaggedError<TranspilationError>()(
  "TranspilationError",
  {
    source: TranspilerSource,
    message: Schema.String,
    location: Schema.optional(SourceLocation)
  }
) {}

export class ExecutionError extends Schema.TaggedError<ExecutionError>()(
  "ExecutionError",
  {
    message: Schema.String,
    stack: Schema.optional(Schema.String)
  }
) {}

export class TimeoutError extends Schema.TaggedError<TimeoutError>()(
  "TimeoutError",
  {
    timeoutMs: Schema.Number
  }
) {}

const SecurityViolationType = Schema.Literal(
  "validation_failed",
  "runtime_escape",
  "forbidden_access"
)

export class SecurityViolation extends Schema.TaggedError<SecurityViolation>()(
  "SecurityViolation",
  {
    violation: SecurityViolationType,
    details: Schema.String
  }
) {}

export const SandboxError = Schema.Union(
  ValidationError,
  TranspilationError,
  ExecutionError,
  TimeoutError,
  SecurityViolation
)
export type SandboxError = typeof SandboxError.Type
