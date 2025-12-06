/**
 * TypeScript Sandbox Error Types
 *
 * Uses Schema.TaggedError for serializable, type-safe error handling.
 * Includes cause tracking for preserving original error chains.
 */
import { Predicate, Schema } from "effect"

// TypeID for runtime type guards
const SandboxErrorTypeId: unique symbol = Symbol.for("@app/sandbox/SandboxError")
export type SandboxErrorTypeId = typeof SandboxErrorTypeId

export const isSandboxError = (u: unknown): u is SandboxError => Predicate.hasProperty(u, SandboxErrorTypeId)

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
    _message: Schema.String,
    location: Schema.optional(SourceLocation),
    cause: Schema.optional(Schema.Defect)
  }
) {
  readonly [SandboxErrorTypeId]: SandboxErrorTypeId = SandboxErrorTypeId

  override get message(): string {
    let msg = `${this.type}: ${this._message}`
    if (this.location) {
      msg += ` at line ${this.location.line}, column ${this.location.column}`
    }
    return msg
  }
}

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
    _message: Schema.String,
    location: Schema.optional(SourceLocation),
    cause: Schema.optional(Schema.Defect)
  }
) {
  readonly [SandboxErrorTypeId]: SandboxErrorTypeId = SandboxErrorTypeId

  override get message(): string {
    let msg = `${this.source} transpilation error: ${this._message}`
    if (this.location) {
      msg += ` at line ${this.location.line}, column ${this.location.column}`
    }
    return msg
  }
}

export class ExecutionError extends Schema.TaggedError<ExecutionError>()(
  "ExecutionError",
  {
    _message: Schema.String,
    stack: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect)
  }
) {
  readonly [SandboxErrorTypeId]: SandboxErrorTypeId = SandboxErrorTypeId

  override get message(): string {
    return `Execution error: ${this._message}`
  }
}

export class TimeoutError extends Schema.TaggedError<TimeoutError>()(
  "TimeoutError",
  {
    timeoutMs: Schema.Number
  }
) {
  readonly [SandboxErrorTypeId]: SandboxErrorTypeId = SandboxErrorTypeId

  override get message(): string {
    return `Execution timed out after ${this.timeoutMs}ms`
  }
}

const SecurityViolationType = Schema.Literal(
  "validation_failed",
  "runtime_escape",
  "forbidden_access"
)

export class SecurityViolation extends Schema.TaggedError<SecurityViolation>()(
  "SecurityViolation",
  {
    violation: SecurityViolationType,
    details: Schema.String,
    cause: Schema.optional(Schema.Defect)
  }
) {
  readonly [SandboxErrorTypeId]: SandboxErrorTypeId = SandboxErrorTypeId

  override get message(): string {
    return `Security violation (${this.violation}): ${this.details}`
  }
}

export const SandboxError = Schema.Union(
  ValidationError,
  TranspilationError,
  ExecutionError,
  TimeoutError,
  SecurityViolation
)
export type SandboxError = typeof SandboxError.Type
