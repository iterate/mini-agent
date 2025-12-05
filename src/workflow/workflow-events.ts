/**
 * Workflow Events
 *
 * Context events that represent workflow execution state.
 * These get persisted alongside conversation events.
 */
import { Schema } from "effect"

// =============================================================================
// Workflow Event Types
// =============================================================================

/** Workflow execution started */
export class WorkflowStartedEvent extends Schema.TaggedClass<WorkflowStartedEvent>()(
  "WorkflowStarted",
  {
    executionId: Schema.String,
    workflowName: Schema.String,
    inputs: Schema.optional(Schema.Unknown),
    timestamp: Schema.Number
  }
) {}

/** A step completed successfully */
export class WorkflowStepCompletedEvent extends Schema.TaggedClass<WorkflowStepCompletedEvent>()(
  "WorkflowStepCompleted",
  {
    executionId: Schema.String,
    stepId: Schema.String,
    stepType: Schema.String,
    output: Schema.Unknown,
    durationMs: Schema.Number,
    timestamp: Schema.Number
  }
) {}

/** A step failed */
export class WorkflowStepFailedEvent extends Schema.TaggedClass<WorkflowStepFailedEvent>()(
  "WorkflowStepFailed",
  {
    executionId: Schema.String,
    stepId: Schema.String,
    stepType: Schema.String,
    error: Schema.String,
    timestamp: Schema.Number
  }
) {}

/** Workflow suspended waiting for approval */
export class WorkflowSuspendedEvent extends Schema.TaggedClass<WorkflowSuspendedEvent>()(
  "WorkflowSuspended",
  {
    executionId: Schema.String,
    stepId: Schema.String,
    reason: Schema.Literal("approval", "external", "error"),
    message: Schema.String,
    context: Schema.optional(Schema.Unknown),
    timestamp: Schema.Number
  }
) {}

/** Workflow resumed (approval granted or external signal) */
export class WorkflowResumedEvent extends Schema.TaggedClass<WorkflowResumedEvent>()(
  "WorkflowResumed",
  {
    executionId: Schema.String,
    stepId: Schema.String,
    approvedBy: Schema.optional(Schema.String),
    timestamp: Schema.Number
  }
) {}

/** Workflow completed successfully */
export class WorkflowCompletedEvent extends Schema.TaggedClass<WorkflowCompletedEvent>()(
  "WorkflowCompleted",
  {
    executionId: Schema.String,
    output: Schema.Unknown,
    totalDurationMs: Schema.Number,
    timestamp: Schema.Number
  }
) {}

/** Workflow failed */
export class WorkflowFailedEvent extends Schema.TaggedClass<WorkflowFailedEvent>()(
  "WorkflowFailed",
  {
    executionId: Schema.String,
    error: Schema.String,
    failedStepId: Schema.optional(Schema.String),
    timestamp: Schema.Number
  }
) {}

// =============================================================================
// Union of all workflow events
// =============================================================================

export const WorkflowEvent = Schema.Union(
  WorkflowStartedEvent,
  WorkflowStepCompletedEvent,
  WorkflowStepFailedEvent,
  WorkflowSuspendedEvent,
  WorkflowResumedEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent
)
export type WorkflowEvent = typeof WorkflowEvent.Type

// =============================================================================
// Type guards
// =============================================================================

export const isWorkflowEvent = Schema.is(WorkflowEvent)
export const isWorkflowSuspended = Schema.is(WorkflowSuspendedEvent)
export const isWorkflowCompleted = Schema.is(WorkflowCompletedEvent)
