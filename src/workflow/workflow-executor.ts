/**
 * Workflow Executor
 *
 * Executes workflow definitions step-by-step, journaling each operation
 * as context events. Supports suspend/resume for approval gates.
 */
import { Context, Effect, Layer, Schema, Stream } from "effect"
import type {
  ApprovalStep,
  CallWorkflowStep,
  ConditionalStep,
  FetchStep,
  LoopStep,
  ReadFileStep,
  ShellStep,
  TransformStep,
  WaitStep,
  WorkflowDefinition,
  WorkflowStep
} from "./workflow-dsl.ts"
import {
  WorkflowCompletedEvent,
  type WorkflowEvent,
  WorkflowFailedEvent,
  WorkflowResumedEvent,
  WorkflowStartedEvent,
  WorkflowStepCompletedEvent,
  WorkflowStepFailedEvent,
  WorkflowSuspendedEvent
} from "./workflow-events.ts"

// =============================================================================
// Execution State
// =============================================================================

/** Runtime state for a workflow execution */
interface ExecutionState {
  readonly executionId: string
  readonly workflowName: string
  readonly inputs: Record<string, unknown>
  /** Outputs from each completed step, keyed by step ID */
  readonly outputs: Map<string, unknown>
  /** Current step index (for resume) */
  currentStepIndex: number
  /** Whether execution is suspended */
  suspended: boolean
  /** Step ID waiting for approval */
  pendingApprovalStepId: string | null
  /** Start time for duration tracking */
  startTime: number
}

// =============================================================================
// Executor Error
// =============================================================================

export class WorkflowExecutionError extends Schema.TaggedError<WorkflowExecutionError>()(
  "WorkflowExecutionError",
  {
    executionId: Schema.String,
    stepId: Schema.optional(Schema.String),
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown)
  }
) {}

// =============================================================================
// Template Resolution
// =============================================================================

/** Resolve {{stepId.field}} references in a string */
const resolveTemplate = (
  template: string,
  state: ExecutionState
): string => {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, expr: string) => {
    const parts = expr.trim().split(".")
    const stepId = parts[0]

    // Handle inputs.xxx
    if (stepId === "inputs") {
      const value = parts.slice(1).reduce<unknown>(
        (obj, key) => (obj as Record<string, unknown>)?.[key],
        state.inputs
      )
      return typeof value === "string" ? value : JSON.stringify(value)
    }

    // Handle step outputs
    let value = stepId ? state.outputs.get(stepId) : undefined
    for (const key of parts.slice(1)) {
      value = (value as Record<string, unknown>)?.[key]
    }
    return typeof value === "string" ? value : JSON.stringify(value ?? null)
  })
}

/** Resolve template for any value (string, object, etc.) */
const resolveValue = <T>(value: T, state: ExecutionState): T => {
  if (typeof value === "string") {
    return resolveTemplate(value, state) as T
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, state)) as T
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveValue(v, state)])
    ) as T
  }
  return value
}

// =============================================================================
// Step Executors
// =============================================================================

type StepResult = { output: unknown } | { suspended: true; message: string; context?: unknown }

const executeFetch = (
  s: FetchStep,
  state: ExecutionState
): Effect.Effect<StepResult, WorkflowExecutionError> =>
  Effect.gen(function*() {
    const url = resolveTemplate(s.url, state)
    const method = s.method ?? "GET"

    // In real impl, use @effect/platform HttpClient
    yield* Effect.logInfo(`Fetch: ${method} ${url}`)

    // Simulated response for example
    const response = { status: "ok", data: { url, method } }

    // Extract fields if specified
    let output: unknown = response
    if (s.extract) {
      output = {}
      for (const [key, path] of Object.entries(s.extract)) {
        // Simple extraction - real impl would use JSONPath
        const parts = String(path).replace("$.", "").split(".")
        let val: unknown = response
        for (const p of parts) {
          val = (val as Record<string, unknown>)?.[p]
        }
        ;(output as Record<string, unknown>)[key] = val
      }
    }

    return { output }
  })

const executeShell = (
  s: ShellStep,
  state: ExecutionState
): Effect.Effect<StepResult, WorkflowExecutionError> =>
  Effect.gen(function*() {
    const command = resolveTemplate(s.command, state)
    const cwd = s.cwd ? resolveTemplate(s.cwd, state) : undefined

    yield* Effect.logInfo(`Shell: ${command}`, { cwd })

    // In real impl, use @effect/platform Command
    const output = {
      stdout: `[simulated output of: ${command}]`,
      stderr: "",
      exitCode: 0
    }

    return { output }
  })

const executeReadFile = (
  s: ReadFileStep,
  state: ExecutionState
): Effect.Effect<StepResult, WorkflowExecutionError> =>
  Effect.gen(function*() {
    const path = resolveTemplate(s.path, state)
    yield* Effect.logInfo(`ReadFile: ${path}`)

    // In real impl, use FileSystem service
    const output = { path, content: `[simulated content of ${path}]` }
    return { output }
  })

const executeWriteFile = (
  s: { id: string; path: string; content: string },
  state: ExecutionState
): Effect.Effect<StepResult, WorkflowExecutionError> =>
  Effect.gen(function*() {
    const path = resolveTemplate(s.path, state)
    const content = resolveTemplate(s.content, state)
    yield* Effect.logInfo(`WriteFile: ${path}`, { contentLength: content.length })

    // In real impl, use FileSystem service
    return { output: { path, bytesWritten: content.length } }
  })

const executeTransform = (
  s: TransformStep,
  state: ExecutionState
): Effect.Effect<StepResult, WorkflowExecutionError> =>
  Effect.gen(function*() {
    const input = resolveTemplate(s.input, state)
    yield* Effect.logInfo(`Transform: ${s.expression}`)

    // SECURITY: In real impl, use a sandboxed evaluator
    return { output: input }
  })

const executeWait = (
  s: WaitStep,
  _state: ExecutionState
): Effect.Effect<StepResult, WorkflowExecutionError> =>
  Effect.gen(function*() {
    const duration = typeof s.duration === "string"
      ? parseDuration(s.duration)
      : s.duration

    yield* Effect.logInfo(`Wait: ${duration}ms`)
    yield* Effect.sleep(duration)
    return { output: { waited: duration } }
  })

const executeApproval = (
  s: ApprovalStep,
  state: ExecutionState
): Effect.Effect<StepResult, WorkflowExecutionError> =>
  Effect.gen(function*() {
    const message = resolveTemplate(s.message, state)
    const context = s.context ? resolveValue(s.context, state) : undefined

    yield* Effect.logInfo(`Approval required: ${message}`)

    // Suspend execution - will be resumed when approved
    return { suspended: true, message, context }
  })

const executeConditional = (
  s: ConditionalStep,
  state: ExecutionState
): Effect.Effect<StepResult, WorkflowExecutionError> =>
  Effect.gen(function*() {
    const condition = resolveTemplate(s.condition, state)
    yield* Effect.logInfo(`Conditional: ${condition}`)

    // SECURITY: In real impl, use safe evaluator
    const result = condition.includes("true") || condition.includes("healthy")

    const steps = result ? s.then : (s.else ?? [])
    yield* Effect.logInfo(`Conditional branch: ${result ? "then" : "else"}`)

    // Execute nested steps
    for (const nestedStep of steps) {
      const nestedResult = yield* executeStep(nestedStep, state)
      if ("suspended" in nestedResult) {
        return nestedResult
      }
      state.outputs.set(nestedStep.id, nestedResult.output)
    }

    return { output: { condition, branch: result ? "then" : "else" } }
  })

const executeLoop = (
  s: LoopStep,
  state: ExecutionState
): Effect.Effect<StepResult, WorkflowExecutionError> =>
  Effect.gen(function*() {
    const itemsStr = resolveTemplate(s.items, state)
    const items = JSON.parse(itemsStr) as Array<unknown>

    yield* Effect.logInfo(`Loop: ${items.length} items as ${s.as}`)

    const outputs: Array<unknown> = []
    for (const item of items) {
      // Inject loop variable
      state.outputs.set(s.as, item)

      for (const nestedStep of s.do) {
        const nestedResult = yield* executeStep(nestedStep, state)
        if ("suspended" in nestedResult) {
          return nestedResult
        }
        state.outputs.set(nestedStep.id, nestedResult.output)
      }
      const lastStep = s.do[s.do.length - 1]
      if (lastStep) {
        outputs.push(state.outputs.get(lastStep.id))
      }
    }

    return { output: outputs }
  })

const executeCallWorkflow = (
  s: CallWorkflowStep,
  _state: ExecutionState
): Effect.Effect<StepResult, WorkflowExecutionError> =>
  Effect.gen(function*() {
    yield* Effect.logInfo(`CallWorkflow: ${s.workflowName}`)
    // In real impl, recursively execute the referenced workflow
    return { output: { called: s.workflowName, payload: s.payload } }
  })

/** Execute a single step based on its type */
const executeStep = (
  step: WorkflowStep,
  state: ExecutionState
): Effect.Effect<StepResult, WorkflowExecutionError> => {
  switch (step._tag) {
    case "Fetch":
      return executeFetch(step, state)
    case "Shell":
      return executeShell(step, state)
    case "ReadFile":
      return executeReadFile(step, state)
    case "WriteFile":
      return executeWriteFile(step, state)
    case "Transform":
      return executeTransform(step, state)
    case "Wait":
      return executeWait(step, state)
    case "Approval":
      return executeApproval(step, state)
    case "Conditional":
      return executeConditional(step, state)
    case "Loop":
      return executeLoop(step, state)
    case "CallWorkflow":
      return executeCallWorkflow(step, state)
  }
}

/** Parse duration string like "5s", "1m", "2h" */
const parseDuration = (s: string): number => {
  const match = s.match(/^(\d+)(ms|s|m|h)$/)
  if (!match) return parseInt(s, 10)
  const [, num, unit] = match
  const n = parseInt(num ?? "0", 10)
  switch (unit) {
    case "ms":
      return n
    case "s":
      return n * 1000
    case "m":
      return n * 60 * 1000
    case "h":
      return n * 60 * 60 * 1000
    default:
      return n
  }
}

// =============================================================================
// Workflow Executor Service
// =============================================================================

export class WorkflowExecutor extends Context.Tag("@app/WorkflowExecutor")<
  WorkflowExecutor,
  {
    /**
     * Execute a workflow, streaming events as they occur.
     * Returns stream of workflow events that should be persisted.
     */
    readonly execute: (
      workflow: WorkflowDefinition,
      inputs?: Record<string, unknown>
    ) => Stream.Stream<WorkflowEvent, WorkflowExecutionError>

    /**
     * Resume a suspended workflow (e.g., after approval).
     * Takes the executionId and optionally who approved.
     */
    readonly resume: (
      executionId: string,
      approvedBy?: string
    ) => Stream.Stream<WorkflowEvent, WorkflowExecutionError>

    /**
     * Get current state of a workflow execution.
     */
    readonly getState: (
      executionId: string
    ) => Effect.Effect<ExecutionState | undefined>
  }
>() {
  static readonly layer = Layer.sync(WorkflowExecutor, () => {
    // In-memory store of execution states (would be persisted in production)
    const executions = new Map<string, ExecutionState>()
    // Store workflow definitions for resume
    const workflows = new Map<string, WorkflowDefinition>()

    const executeWorkflow = (
      workflow: WorkflowDefinition,
      state: ExecutionState
    ): Stream.Stream<WorkflowEvent, WorkflowExecutionError> =>
      Stream.unwrap(
        Effect.gen(function*() {
          const events: Array<WorkflowEvent> = []
          const now = () => Date.now()

          // Execute remaining steps
          for (let i = state.currentStepIndex; i < workflow.steps.length; i++) {
            const step = workflow.steps[i]
            if (!step) continue

            state.currentStepIndex = i
            const stepStart = now()

            const result = yield* executeStep(step, state).pipe(
              Effect.catchAll((error) =>
                Effect.succeed({
                  error: true as const,
                  message: error.message
                })
              )
            )

            if ("error" in result) {
              // Step failed
              events.push(
                new WorkflowStepFailedEvent({
                  executionId: state.executionId,
                  stepId: step.id,
                  stepType: step._tag,
                  error: result.message,
                  timestamp: now()
                })
              )
              events.push(
                new WorkflowFailedEvent({
                  executionId: state.executionId,
                  error: result.message,
                  failedStepId: step.id,
                  timestamp: now()
                })
              )
              return Stream.fromIterable(events)
            }

            if ("suspended" in result) {
              // Workflow suspended (approval required)
              state.suspended = true
              state.pendingApprovalStepId = step.id
              events.push(
                new WorkflowSuspendedEvent({
                  executionId: state.executionId,
                  stepId: step.id,
                  reason: "approval",
                  message: result.message,
                  context: result.context,
                  timestamp: now()
                })
              )
              return Stream.fromIterable(events)
            }

            // Step completed successfully
            state.outputs.set(step.id, result.output)
            events.push(
              new WorkflowStepCompletedEvent({
                executionId: state.executionId,
                stepId: step.id,
                stepType: step._tag,
                output: result.output,
                durationMs: now() - stepStart,
                timestamp: now()
              })
            )
          }

          // All steps completed
          const lastStep = workflow.steps[workflow.steps.length - 1]
          const output = workflow.output
            ? resolveTemplate(workflow.output, state)
            : lastStep
            ? state.outputs.get(lastStep.id)
            : undefined

          events.push(
            new WorkflowCompletedEvent({
              executionId: state.executionId,
              output,
              totalDurationMs: now() - state.startTime,
              timestamp: now()
            })
          )

          // Cleanup
          executions.delete(state.executionId)
          workflows.delete(state.executionId)

          return Stream.fromIterable(events)
        })
      )

    return WorkflowExecutor.of({
      execute: (workflow, inputs = {}) => {
        const executionId = crypto.randomUUID()
        const state: ExecutionState = {
          executionId,
          workflowName: workflow.name,
          inputs,
          outputs: new Map(),
          currentStepIndex: 0,
          suspended: false,
          pendingApprovalStepId: null,
          startTime: Date.now()
        }

        executions.set(executionId, state)
        workflows.set(executionId, workflow)

        const startEvent = new WorkflowStartedEvent({
          executionId,
          workflowName: workflow.name,
          inputs,
          timestamp: Date.now()
        })

        return Stream.concat(
          Stream.make(startEvent),
          executeWorkflow(workflow, state)
        )
      },

      resume: (executionId, approvedBy) =>
        Stream.unwrap(
          Effect.sync(() => {
            const state = executions.get(executionId)
            const workflow = workflows.get(executionId)

            if (!state || !workflow) {
              return Stream.fail(
                new WorkflowExecutionError({
                  executionId,
                  message: "Workflow execution not found"
                })
              )
            }

            if (!state.suspended) {
              return Stream.fail(
                new WorkflowExecutionError({
                  executionId,
                  message: "Workflow is not suspended"
                })
              )
            }

            // Resume from the step after the approval
            state.suspended = false
            const approvalStepId = state.pendingApprovalStepId
            state.pendingApprovalStepId = null
            state.currentStepIndex++ // Move past the approval step

            const resumeEvent = new WorkflowResumedEvent({
              executionId,
              stepId: approvalStepId ?? "unknown",
              approvedBy,
              timestamp: Date.now()
            })

            return Stream.concat(
              Stream.make(resumeEvent),
              executeWorkflow(workflow, state)
            )
          })
        ),

      getState: (executionId) => Effect.sync(() => executions.get(executionId))
    })
  })
}
