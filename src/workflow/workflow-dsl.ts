/**
 * Workflow DSL Schema
 *
 * Defines the structure of workflows that the LLM can emit.
 * Uses a declarative JSON format that's easy for LLMs to generate
 * and safe to parse/validate.
 */
import { Schema } from "effect"

// =============================================================================
// Step Types - The building blocks of workflows
// =============================================================================

/** Fetch data from a URL */
export const FetchStep = Schema.Struct({
  _tag: Schema.Literal("Fetch"),
  id: Schema.String,
  url: Schema.String,
  method: Schema.optional(Schema.Literal("GET", "POST", "PUT", "DELETE")),
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  body: Schema.optional(Schema.String),
  /** Extract specific fields from response using JSONPath-like expressions */
  extract: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String }))
})
export type FetchStep = typeof FetchStep.Type

/** Run a shell command */
export const ShellStep = Schema.Struct({
  _tag: Schema.Literal("Shell"),
  id: Schema.String,
  command: Schema.String,
  /** Working directory */
  cwd: Schema.optional(Schema.String),
  /** Timeout in milliseconds */
  timeout: Schema.optional(Schema.Number)
})
export type ShellStep = typeof ShellStep.Type

/** Read a file */
export const ReadFileStep = Schema.Struct({
  _tag: Schema.Literal("ReadFile"),
  id: Schema.String,
  path: Schema.String
})
export type ReadFileStep = typeof ReadFileStep.Type

/** Write a file */
export const WriteFileStep = Schema.Struct({
  _tag: Schema.Literal("WriteFile"),
  id: Schema.String,
  path: Schema.String,
  /** Content can reference previous step outputs: {{stepId.field}} */
  content: Schema.String
})
export type WriteFileStep = typeof WriteFileStep.Type

/** Transform data using a simple expression */
export const TransformStep = Schema.Struct({
  _tag: Schema.Literal("Transform"),
  id: Schema.String,
  /** Input reference: {{stepId}} or {{stepId.field}} */
  input: Schema.String,
  /** JavaScript expression to transform (sandboxed) */
  expression: Schema.String
})
export type TransformStep = typeof TransformStep.Type

/** Wait/sleep */
export const WaitStep = Schema.Struct({
  _tag: Schema.Literal("Wait"),
  id: Schema.String,
  /** Duration in milliseconds or human string "5s", "1m" */
  duration: Schema.Union(Schema.Number, Schema.String)
})
export type WaitStep = typeof WaitStep.Type

/** Call another workflow */
export const CallWorkflowStep = Schema.Struct({
  _tag: Schema.Literal("CallWorkflow"),
  id: Schema.String,
  workflowName: Schema.String,
  payload: Schema.optional(Schema.Unknown)
})
export type CallWorkflowStep = typeof CallWorkflowStep.Type

/** Human approval checkpoint - suspends until approved */
export const ApprovalStep = Schema.Struct({
  _tag: Schema.Literal("Approval"),
  id: Schema.String,
  message: Schema.String,
  /** Data to show for approval decision */
  context: Schema.optional(Schema.Unknown)
})
export type ApprovalStep = typeof ApprovalStep.Type

// =============================================================================
// Simple steps (non-recursive)
// =============================================================================

export const SimpleStep = Schema.Union(
  FetchStep,
  ShellStep,
  ReadFileStep,
  WriteFileStep,
  TransformStep,
  WaitStep,
  CallWorkflowStep,
  ApprovalStep
)
export type SimpleStep = typeof SimpleStep.Type

// =============================================================================
// Recursive steps - use Schema.suspend for recursive references
// =============================================================================

/** Conditional branching */
export interface ConditionalStep {
  readonly _tag: "Conditional"
  readonly id: string
  /** Condition expression referencing previous outputs */
  readonly condition: string
  /** Steps to run if true */
  readonly then: ReadonlyArray<WorkflowStep>
  /** Steps to run if false (optional) */
  readonly else: ReadonlyArray<WorkflowStep> | undefined
}

const ConditionalStepSchema = Schema.Struct({
  _tag: Schema.Literal("Conditional"),
  id: Schema.String,
  condition: Schema.String,
  then: Schema.suspend((): Schema.Schema<ReadonlyArray<WorkflowStep>> => Schema.Array(WorkflowStep)),
  else: Schema.optional(Schema.suspend((): Schema.Schema<ReadonlyArray<WorkflowStep>> => Schema.Array(WorkflowStep)))
})

export const ConditionalStep: Schema.Schema<ConditionalStep> = ConditionalStepSchema as unknown as Schema.Schema<
  ConditionalStep
>

/** Loop over items */
export interface LoopStep {
  readonly _tag: "Loop"
  readonly id: string
  /** Array to iterate: {{stepId}} or literal */
  readonly items: string
  /** Variable name for current item */
  readonly as: string
  /** Steps to run for each item */
  readonly do: ReadonlyArray<WorkflowStep>
}

export const LoopStep: Schema.Schema<LoopStep> = Schema.Struct({
  _tag: Schema.Literal("Loop"),
  id: Schema.String,
  items: Schema.String,
  as: Schema.String,
  do: Schema.suspend((): Schema.Schema<ReadonlyArray<WorkflowStep>> => Schema.Array(WorkflowStep))
})

// =============================================================================
// Workflow Step Union
// =============================================================================

export type WorkflowStep = SimpleStep | ConditionalStep | LoopStep

export const WorkflowStep: Schema.Schema<WorkflowStep> = Schema.Union(
  SimpleStep,
  ConditionalStep,
  LoopStep
)

// =============================================================================
// Workflow Definition
// =============================================================================

export const WorkflowDefinition = Schema.Struct({
  /** Unique name for this workflow */
  name: Schema.String,
  /** Human-readable description */
  description: Schema.optional(Schema.String),
  /** Input parameters schema (simplified) */
  inputs: Schema.optional(Schema.Record({
    key: Schema.String,
    value: Schema.Struct({
      type: Schema.Literal("string", "number", "boolean", "array", "object"),
      description: Schema.optional(Schema.String),
      required: Schema.optional(Schema.Boolean)
    })
  })),
  /** The steps to execute */
  steps: Schema.Array(WorkflowStep),
  /** What to return from the workflow */
  output: Schema.optional(Schema.String)
})
export type WorkflowDefinition = typeof WorkflowDefinition.Type

// =============================================================================
// Decoders
// =============================================================================

export const decodeWorkflow = Schema.decodeUnknownSync(WorkflowDefinition)
export const decodeWorkflowEffect = Schema.decodeUnknown(WorkflowDefinition)
