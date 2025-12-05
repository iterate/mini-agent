/**
 * Domain Errors
 *
 * Typed errors for each layer of the architecture:
 * - AgentError: LLM request failures (Layer 1)
 * - ReducerError: Event reduction failures (Layer 2)
 * - SessionError: Session lifecycle failures (Layer 3)
 * - HookError: Hook execution failures
 * - ContextError: Context loading/persistence failures
 */
import { Option, Schema } from "effect"
import { ContextEvent, ContextName } from "./context.model.ts"

/** Agent layer error - LLM request failures */
export class AgentError extends Schema.TaggedError<AgentError>()(
  "AgentError",
  {
    message: Schema.String,
    provider: Schema.String,
    cause: Schema.optionalWith(Schema.Unknown, { as: "Option" })
  }
) {}

/** Helper to create AgentError */
export const makeAgentError = (message: string, provider: string, cause?: unknown): AgentError =>
  new AgentError({
    message,
    provider,
    cause: cause ? Option.some(cause) : Option.none()
  })

/** Reducer layer error - event reduction failures */
export class ReducerError extends Schema.TaggedError<ReducerError>()(
  "ReducerError",
  {
    message: Schema.String,
    event: Schema.optionalWith(ContextEvent, { as: "Option" })
  }
) {}

/** Helper to create ReducerError */
export const makeReducerError = (message: string, event?: ContextEvent): ReducerError =>
  new ReducerError({
    message,
    event: event ? Option.some(event) : Option.none()
  })

/** Context not found error */
export class ContextNotFoundError extends Schema.TaggedError<ContextNotFoundError>()(
  "ContextNotFoundError",
  {
    contextName: ContextName
  }
) {}

/** Context load/save error */
export class ContextLoadError extends Schema.TaggedError<ContextLoadError>()(
  "ContextLoadError",
  {
    contextName: ContextName,
    message: Schema.String,
    cause: Schema.optionalWith(Schema.Unknown, { as: "Option" })
  }
) {}

/** Helper to create ContextLoadError */
export const makeContextLoadError = (
  contextName: ContextName,
  message: string,
  cause?: unknown
): ContextLoadError =>
  new ContextLoadError({
    contextName,
    message,
    cause: cause ? Option.some(cause) : Option.none()
  })

/** Context save error */
export class ContextSaveError extends Schema.TaggedError<ContextSaveError>()(
  "ContextSaveError",
  {
    contextName: ContextName,
    message: Schema.String,
    cause: Schema.optionalWith(Schema.Unknown, { as: "Option" })
  }
) {}

/** Helper to create ContextSaveError */
export const makeContextSaveError = (
  contextName: ContextName,
  message: string,
  cause?: unknown
): ContextSaveError =>
  new ContextSaveError({
    contextName,
    message,
    cause: cause ? Option.some(cause) : Option.none()
  })

/** Hook execution error */
export class HookError extends Schema.TaggedError<HookError>()(
  "HookError",
  {
    hook: Schema.Literal("beforeTurn", "afterTurn", "onEvent"),
    message: Schema.String,
    cause: Schema.optionalWith(Schema.Unknown, { as: "Option" })
  }
) {}

/** Helper to create HookError */
export const makeHookError = (
  hook: "beforeTurn" | "afterTurn" | "onEvent",
  message: string,
  cause?: unknown
): HookError =>
  new HookError({
    hook,
    message,
    cause: cause ? Option.some(cause) : Option.none()
  })

/** Context-related errors (load/save/not found) */
export const ContextError = Schema.Union(ContextNotFoundError, ContextLoadError, ContextSaveError)
export type ContextError = typeof ContextError.Type

/** Session-related errors (includes all errors that can occur during a session) */
export const SessionError = Schema.Union(
  ContextNotFoundError,
  ContextLoadError,
  ContextSaveError,
  ReducerError,
  HookError,
  AgentError
)
export type SessionError = typeof SessionError.Type

/** Configuration error */
export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
  "ConfigurationError",
  {
    key: Schema.String,
    message: Schema.String
  }
) {}
