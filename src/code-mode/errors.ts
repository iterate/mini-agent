/**
 * Code Mode Error Types
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
    location: Schema.optional(SourceLocation),
    cause: Schema.optional(Schema.Defect)
  }
) {}

export class ValidationWarning extends Schema.TaggedClass<ValidationWarning>()(
  "ValidationWarning",
  {
    type: Schema.String,
    message: Schema.String,
    location: Schema.optional(SourceLocation)
  }
) {}

export class TranspilationError extends Schema.TaggedError<TranspilationError>()(
  "TranspilationError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect)
  }
) {}

const TypeCheckDiagnostic = Schema.Struct({
  message: Schema.String,
  line: Schema.optional(Schema.Number),
  column: Schema.optional(Schema.Number),
  code: Schema.optional(Schema.Number)
})
export type TypeCheckDiagnostic = typeof TypeCheckDiagnostic.Type

export class TypeCheckError extends Schema.TaggedError<TypeCheckError>()(
  "TypeCheckError",
  {
    diagnostics: Schema.Array(TypeCheckDiagnostic)
  }
) {}

export class ExecutionError extends Schema.TaggedError<ExecutionError>()(
  "ExecutionError",
  {
    message: Schema.String,
    stack: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect)
  }
) {}

export class TimeoutError extends Schema.TaggedError<TimeoutError>()(
  "TimeoutError",
  {
    timeoutMs: Schema.Number
  }
) {}

export class SecurityViolation extends Schema.TaggedError<SecurityViolation>()(
  "SecurityViolation",
  {
    details: Schema.String,
    cause: Schema.optional(Schema.Defect)
  }
) {}

export const CodeModeError = Schema.Union(
  ValidationError,
  TranspilationError,
  TypeCheckError,
  ExecutionError,
  TimeoutError,
  SecurityViolation
)
export type CodeModeError = typeof CodeModeError.Type
