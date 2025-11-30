import { Rpc, RpcGroup } from "@effect/rpc"
import { Schema } from "effect"

// =============================================================================
// Domain Types
// =============================================================================

const TaskId = Schema.Number.pipe(Schema.brand("TaskId"))
type TaskId = typeof TaskId.Type

export class Task extends Schema.Class<Task>("Task")({
  id: TaskId,
  text: Schema.NonEmptyString,
  done: Schema.Boolean
}) {}

export class TaskList extends Schema.Class<TaskList>("TaskList")({
  tasks: Schema.Array(Task)
}) {}

// =============================================================================
// Typed Errors
// =============================================================================

export class TaskNotFoundError extends Schema.TaggedError<TaskNotFoundError>()(
  "TaskNotFoundError",
  { id: Schema.Number.annotations({ description: "The task ID that was not found" }) }
) {}

export class TaskValidationError extends Schema.TaggedError<TaskValidationError>()(
  "TaskValidationError",
  { reason: Schema.String.annotations({ description: "Validation failure reason" }) }
) {}

export class LlmError extends Schema.TaggedError<LlmError>()(
  "LlmError",
  { message: Schema.String.annotations({ description: "LLM error message" }) }
) {}

// =============================================================================
// Task RPC Group
// =============================================================================

export class TaskRpcs extends RpcGroup.make(
  Rpc.make("list", {
    success: Schema.Array(Task),
    payload: {
      all: Schema.optionalWith(Schema.Boolean, { default: () => false })
        .annotations({ description: "Show all tasks including completed" })
    }
  }),

  Rpc.make("add", {
    success: Task,
    error: TaskValidationError,
    payload: {
      text: Schema.NonEmptyString
        .annotations({ description: "The task description" })
    }
  }),

  Rpc.make("toggle", {
    success: Task,
    error: TaskNotFoundError,
    payload: {
      id: Schema.Number
        .annotations({ description: "Task ID to toggle" })
    }
  }),

  Rpc.make("clear", {
    success: Schema.Struct({ cleared: Schema.Number }),
    payload: {}
  })
) {}

// =============================================================================
// LLM RPC Group
// =============================================================================

export class LlmRpcs extends RpcGroup.make(
  // Streaming text generation
  Rpc.make("generateStream", {
    success: Schema.String,
    error: LlmError,
    stream: true,
    payload: {
      prompt: Schema.String
        .annotations({ description: "The prompt to send to the LLM" })
    }
  }),

  // Non-streaming text generation (returns complete response)
  Rpc.make("generate", {
    success: Schema.String,
    error: LlmError,
    payload: {
      prompt: Schema.String
        .annotations({ description: "The prompt to send to the LLM" })
    }
  })
) {}

// =============================================================================
// Combined RPC Group (for server)
// =============================================================================

export const AllRpcs = TaskRpcs.merge(LlmRpcs)

// =============================================================================
// Registry - Export individual groups for CLI
// =============================================================================

export const RpcRegistry = {
  tasks: TaskRpcs,
  llm: LlmRpcs
} as const

export type RpcRegistry = typeof RpcRegistry

// Re-export TaskId for use in handlers
export { TaskId }
