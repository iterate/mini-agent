/**
 * Codemode Error Types
 */
import { Schema } from "effect"

/** TypeScript typecheck failure */
export class TypecheckError extends Schema.TaggedError<TypecheckError>()(
  "TypecheckError",
  { errors: Schema.String }
) {}
