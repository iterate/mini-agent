/**
 * Workflow Primitives with Deterministic Replay
 *
 * Key insight from Effect's workflow system: when resuming, we replay from
 * the beginning but return cached results for completed steps.
 *
 * Step IDs are deterministic (counter per execution), so the same workflow
 * code produces the same step sequence on replay.
 */
import { Context, Effect, Layer, Ref, Schema } from "effect"
import type { WorkflowEvent } from "./workflow-events.ts"
import {
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowResumedEvent,
  WorkflowStartedEvent,
  WorkflowStepCompletedEvent,
  WorkflowSuspendedEvent
} from "./workflow-events.ts"

// =============================================================================
// Workflow State - persisted for replay
// =============================================================================

/** Result of a completed step, stored in journal */
export const StepResult = Schema.Struct({
  stepId: Schema.String,
  stepType: Schema.String,
  output: Schema.Unknown,
  durationMs: Schema.Number
})
export type StepResult = typeof StepResult.Type

/** Persisted workflow state for suspend/resume */
export const WorkflowState = Schema.Struct({
  executionId: Schema.String,
  workflowName: Schema.String,
  workflowCode: Schema.String,
  status: Schema.Literal("running", "suspended", "completed", "failed"),
  /** Journal of completed step results, keyed by stepId */
  journal: Schema.Record({ key: Schema.String, value: StepResult }),
  /** If suspended, which approval step we're waiting on */
  pendingApproval: Schema.optional(
    Schema.Struct({
      stepId: Schema.String,
      message: Schema.String,
      context: Schema.optional(Schema.Unknown)
    })
  ),
  /** Approvals that have been granted (stepId -> approvedBy) */
  approvedSteps: Schema.Record({ key: Schema.String, value: Schema.String }),
  startTime: Schema.Number,
  events: Schema.Array(Schema.Unknown)
})
export type WorkflowState = typeof WorkflowState.Type

// =============================================================================
// Workflow Context - runtime state during execution
// =============================================================================

export interface WorkflowContext {
  readonly executionId: string
  readonly workflowName: string
  /** Counter for deterministic step IDs */
  readonly stepCounter: Ref.Ref<number>
  /** Journal from previous run (for replay) */
  readonly journal: ReadonlyMap<string, StepResult>
  /** Steps that have been approved */
  readonly approvedSteps: ReadonlyMap<string, string>
  /** Events emitted during this execution */
  readonly events: Ref.Ref<Array<WorkflowEvent>>
  /** Set when we hit an unapproved approval gate */
  readonly suspended: Ref.Ref<{ stepId: string; message: string; context?: unknown } | null>
  readonly startTime: number
}

export class WorkflowCtx extends Context.Tag("@app/WorkflowCtx")<
  WorkflowCtx,
  WorkflowContext
>() {}

// =============================================================================
// Step ID generation - deterministic per execution
// =============================================================================

const nextStepId = (
  ctx: WorkflowContext,
  prefix: string
): Effect.Effect<string> =>
  Ref.getAndUpdate(ctx.stepCounter, (n) => n + 1).pipe(
    Effect.map((n) => `${prefix}-${n}`)
  )

// =============================================================================
// Journaled Primitives - check cache before executing
// =============================================================================

/**
 * Check if step is in journal (cached from previous run).
 * If yes, return cached result. If no, execute and record.
 */
const withJournal = <A>(
  ctx: WorkflowContext,
  stepId: string,
  stepType: string,
  execute: () => Effect.Effect<A, Error>,
  serializeOutput: (a: A) => unknown = (a) => a
): Effect.Effect<A, Error> =>
  Effect.gen(function*() {
    // Check journal for cached result
    const cached = ctx.journal.get(stepId)
    if (cached) {
      yield* Effect.logDebug(`Replaying cached step ${stepId}`)
      return cached.output as A
    }

    // Execute the actual operation
    const startTime = Date.now()
    const result = yield* execute()

    // Record in events
    yield* Ref.update(ctx.events, (events) => [
      ...events,
      new WorkflowStepCompletedEvent({
        executionId: ctx.executionId,
        stepId,
        stepType,
        output: serializeOutput(result),
        durationMs: Date.now() - startTime,
        timestamp: Date.now()
      })
    ])

    return result
  })

/**
 * Journaled fetch - records the HTTP request and response
 */
export const fetch = (
  url: string,
  options?: RequestInit
): Effect.Effect<Response, Error, WorkflowCtx> =>
  Effect.gen(function*() {
    const ctx = yield* WorkflowCtx
    const stepId = yield* nextStepId(ctx, "fetch")

    // Check journal - but Response can't be serialized, so we store status
    const cached = ctx.journal.get(stepId)
    if (cached) {
      yield* Effect.logDebug(`Replaying cached fetch ${stepId}`)
      // Re-fetch but we know it should succeed
      const response = yield* Effect.tryPromise({
        try: () => globalThis.fetch(url, options),
        catch: (e) => new Error(`Fetch failed: ${e}`)
      })
      return response
    }

    const startTime = Date.now()
    const response = yield* Effect.tryPromise({
      try: () => globalThis.fetch(url, options),
      catch: (e) => new Error(`Fetch failed: ${e}`)
    })

    yield* Ref.update(ctx.events, (events) => [
      ...events,
      new WorkflowStepCompletedEvent({
        executionId: ctx.executionId,
        stepId,
        stepType: "Fetch",
        output: { url, status: response.status },
        durationMs: Date.now() - startTime,
        timestamp: Date.now()
      })
    ])

    return response
  })

/**
 * Journaled file read - cached on replay
 */
export const readFile = (
  path: string
): Effect.Effect<string, Error, WorkflowCtx> =>
  Effect.gen(function*() {
    const ctx = yield* WorkflowCtx
    const stepId = yield* nextStepId(ctx, "readFile")

    return yield* withJournal(
      ctx,
      stepId,
      "ReadFile",
      () =>
        Effect.tryPromise({
          try: () => Bun.file(path).text(),
          catch: (e) => new Error(`Read failed: ${e}`)
        }),
      (content) => ({ path, length: content.length, content })
    )
  })

/**
 * Journaled file write
 */
export const writeFile = (
  path: string,
  content: string
): Effect.Effect<void, Error, WorkflowCtx> =>
  Effect.gen(function*() {
    const ctx = yield* WorkflowCtx
    const stepId = yield* nextStepId(ctx, "writeFile")

    // Check journal - if we already wrote, skip
    const cached = ctx.journal.get(stepId)
    if (cached) {
      yield* Effect.logDebug(`Skipping cached writeFile ${stepId}`)
      return
    }

    const startTime = Date.now()
    yield* Effect.tryPromise({
      try: () => Bun.write(path, content),
      catch: (e) => new Error(`Write failed: ${e}`)
    })

    yield* Ref.update(ctx.events, (events) => [
      ...events,
      new WorkflowStepCompletedEvent({
        executionId: ctx.executionId,
        stepId,
        stepType: "WriteFile",
        output: { path, length: content.length },
        durationMs: Date.now() - startTime,
        timestamp: Date.now()
      })
    ])
  })

/**
 * Journaled shell command execution
 */
export const exec = (
  command: string,
  options?: { cwd?: string; timeout?: number }
): Effect.Effect<{ stdout: string; stderr: string; exitCode: number }, Error, WorkflowCtx> =>
  Effect.gen(function*() {
    const ctx = yield* WorkflowCtx
    const stepId = yield* nextStepId(ctx, "exec")

    // Check journal for cached result
    const cached = ctx.journal.get(stepId)
    if (cached) {
      yield* Effect.logDebug(`Replaying cached exec ${stepId}`)
      const output = cached.output as { stdout: string; stderr: string; exitCode: number }
      return output
    }

    const startTime = Date.now()
    const proc = options?.cwd
      ? Bun.spawn(["sh", "-c", command], { cwd: options.cwd, stdout: "pipe", stderr: "pipe" })
      : Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" })

    const [stdout, stderr] = yield* Effect.tryPromise({
      try: async () => {
        const out = proc.stdout ? await new Response(proc.stdout).text() : ""
        const err = proc.stderr ? await new Response(proc.stderr).text() : ""
        await proc.exited
        return [out, err] as const
      },
      catch: (e) => new Error(`Exec failed: ${e}`)
    })

    const result = { stdout, stderr, exitCode: proc.exitCode ?? 0 }

    yield* Ref.update(ctx.events, (events) => [
      ...events,
      new WorkflowStepCompletedEvent({
        executionId: ctx.executionId,
        stepId,
        stepType: "Exec",
        output: { command, ...result },
        durationMs: Date.now() - startTime,
        timestamp: Date.now()
      })
    ])

    return result
  })

/**
 * Journaled data transformation
 */
export const transform = <A, B>(
  name: string,
  input: A,
  fn: (a: A) => B
): Effect.Effect<B, Error, WorkflowCtx> =>
  Effect.gen(function*() {
    const ctx = yield* WorkflowCtx
    const stepId = yield* nextStepId(ctx, "transform")

    // Transforms are deterministic, so we can cache the result
    const cached = ctx.journal.get(stepId)
    if (cached) {
      yield* Effect.logDebug(`Replaying cached transform ${stepId}`)
      return cached.output as B
    }

    const startTime = Date.now()
    const result = fn(input)

    yield* Ref.update(ctx.events, (events) => [
      ...events,
      new WorkflowStepCompletedEvent({
        executionId: ctx.executionId,
        stepId,
        stepType: "Transform",
        output: { name, result },
        durationMs: Date.now() - startTime,
        timestamp: Date.now()
      })
    ])

    return result
  })

/**
 * Approval gate - suspends workflow until approved
 *
 * On replay: if this stepId is in approvedSteps, continue.
 * Otherwise, suspend and record the pending approval.
 */
export const approval = (
  message: string,
  context?: unknown
): Effect.Effect<void, never, WorkflowCtx> =>
  Effect.gen(function*() {
    const ctx = yield* WorkflowCtx
    const stepId = yield* nextStepId(ctx, "approval")

    // Check if this approval was already granted
    const approvedBy = ctx.approvedSteps.get(stepId)
    if (approvedBy) {
      yield* Effect.logDebug(`Approval ${stepId} already granted by ${approvedBy}`)

      // Record the resume event
      yield* Ref.update(ctx.events, (events) => [
        ...events,
        new WorkflowResumedEvent({
          executionId: ctx.executionId,
          stepId,
          approvedBy,
          timestamp: Date.now()
        })
      ])
      return
    }

    // Not approved - record suspension and interrupt
    const event = new WorkflowSuspendedEvent({
      executionId: ctx.executionId,
      stepId,
      reason: "approval",
      message,
      context,
      timestamp: Date.now()
    })

    yield* Ref.update(ctx.events, (events) => [...events, event])
    yield* Ref.set(ctx.suspended, { stepId, message, context })

    // Interrupt execution - will be caught by runner
    return yield* Effect.interrupt
  })

/**
 * Log a message (journaled)
 */
export const log = (
  message: string,
  data?: unknown
): Effect.Effect<void, never, WorkflowCtx> =>
  Effect.gen(function*() {
    const ctx = yield* WorkflowCtx
    const stepId = yield* nextStepId(ctx, "log")

    // Logs don't need caching, but we still increment counter for determinism
    yield* Ref.update(ctx.events, (events) => [
      ...events,
      new WorkflowStepCompletedEvent({
        executionId: ctx.executionId,
        stepId,
        stepType: "Log",
        output: { message, data },
        durationMs: 0,
        timestamp: Date.now()
      })
    ])
  })

// =============================================================================
// Workflow Runner - executes with journaling and supports resume
// =============================================================================

export interface WorkflowExecutionResult {
  readonly executionId: string
  readonly result: unknown
  readonly events: Array<WorkflowEvent>
  readonly suspended: boolean
  readonly pendingApproval?: { stepId: string; message: string; context?: unknown }
  readonly state: WorkflowState
}

export class WorkflowRunner extends Context.Tag("@app/WorkflowRunner")<
  WorkflowRunner,
  {
    /**
     * Run a workflow Effect from scratch.
     */
    readonly run: (
      name: string,
      code: string,
      workflow: Effect.Effect<unknown, Error, WorkflowCtx>
    ) => Effect.Effect<WorkflowExecutionResult>

    /**
     * Resume a suspended workflow with an approval.
     */
    readonly resume: (
      state: WorkflowState,
      workflow: Effect.Effect<unknown, Error, WorkflowCtx>,
      approvedBy: string
    ) => Effect.Effect<WorkflowExecutionResult, Error>
  }
>() {
  static readonly layer = Layer.sync(WorkflowRunner, () => {
    const executeWorkflow = (
      executionId: string,
      name: string,
      code: string,
      workflow: Effect.Effect<unknown, Error, WorkflowCtx>,
      journal: ReadonlyMap<string, StepResult>,
      approvedSteps: ReadonlyMap<string, string>,
      existingEvents: Array<WorkflowEvent>
    ): Effect.Effect<WorkflowExecutionResult> =>
      Effect.gen(function*() {
        const stepCounter = yield* Ref.make(0)
        const events = yield* Ref.make<Array<WorkflowEvent>>(existingEvents)
        const suspended = yield* Ref.make<{ stepId: string; message: string; context?: unknown } | null>(null)
        const startTime = Date.now()

        const ctx: WorkflowContext = {
          executionId,
          workflowName: name,
          stepCounter,
          journal,
          approvedSteps,
          events,
          suspended,
          startTime
        }

        // Record start if this is a fresh run
        if (existingEvents.length === 0) {
          yield* Ref.update(events, (e) => [
            ...e,
            new WorkflowStartedEvent({
              executionId,
              workflowName: name,
              timestamp: startTime
            })
          ])
        }

        // Run workflow
        const exit = yield* workflow.pipe(
          Effect.provideService(WorkflowCtx, ctx),
          Effect.exit
        )

        const suspendedState = yield* Ref.get(suspended)
        const allEvents = yield* Ref.get(events)

        // Build journal from completed steps
        const newJournal: Record<string, StepResult> = {}
        for (const [k, v] of journal) {
          newJournal[k] = v
        }
        for (const event of allEvents) {
          if (event._tag === "WorkflowStepCompleted") {
            newJournal[event.stepId] = {
              stepId: event.stepId,
              stepType: event.stepType,
              output: event.output,
              durationMs: event.durationMs
            }
          }
        }

        // Build approved steps record
        const newApprovedSteps: Record<string, string> = {}
        for (const [k, v] of approvedSteps) {
          newApprovedSteps[k] = v
        }

        if (exit._tag === "Success") {
          // Record completion
          yield* Ref.update(events, (e) => [
            ...e,
            new WorkflowCompletedEvent({
              executionId,
              output: exit.value,
              totalDurationMs: Date.now() - startTime,
              timestamp: Date.now()
            })
          ])

          const finalEvents = yield* Ref.get(events)
          return {
            executionId,
            result: exit.value,
            events: finalEvents,
            suspended: false,
            state: {
              executionId,
              workflowName: name,
              workflowCode: code,
              status: "completed",
              journal: newJournal,
              approvedSteps: newApprovedSteps,
              startTime,
              events: finalEvents
            }
          }
        } else if (suspendedState) {
          // Workflow suspended at approval gate
          return {
            executionId,
            result: undefined,
            events: allEvents,
            suspended: true,
            pendingApproval: suspendedState,
            state: {
              executionId,
              workflowName: name,
              workflowCode: code,
              status: "suspended",
              journal: newJournal,
              pendingApproval: suspendedState,
              approvedSteps: newApprovedSteps,
              startTime,
              events: allEvents
            }
          }
        } else {
          // Workflow failed
          const error = exit.cause
          yield* Ref.update(events, (e) => [
            ...e,
            new WorkflowFailedEvent({
              executionId,
              error: String(error),
              timestamp: Date.now()
            })
          ])

          const finalEvents = yield* Ref.get(events)
          return {
            executionId,
            result: undefined,
            events: finalEvents,
            suspended: false,
            state: {
              executionId,
              workflowName: name,
              workflowCode: code,
              status: "failed",
              journal: newJournal,
              approvedSteps: newApprovedSteps,
              startTime,
              events: finalEvents
            }
          }
        }
      })

    return WorkflowRunner.of({
      run: (name, code, workflow) =>
        executeWorkflow(
          crypto.randomUUID(),
          name,
          code,
          workflow,
          new Map(), // empty journal
          new Map(), // no approvals
          [] // no existing events
        ),

      resume: (state, workflow, approvedBy) => {
        if (state.status !== "suspended" || !state.pendingApproval) {
          return Effect.fail(new Error("Cannot resume: workflow not suspended"))
        }

        // Build journal map from state
        const journal = new Map<string, StepResult>()
        for (const [k, v] of Object.entries(state.journal)) {
          journal.set(k, v)
        }

        // Build approved steps map, adding the new approval
        const approvedSteps = new Map<string, string>()
        for (const [k, v] of Object.entries(state.approvedSteps)) {
          approvedSteps.set(k, v)
        }
        approvedSteps.set(state.pendingApproval.stepId, approvedBy)

        // Replay from the beginning with cached results
        return executeWorkflow(
          state.executionId,
          state.workflowName,
          state.workflowCode,
          workflow,
          journal,
          approvedSteps,
          [] // Fresh events for this run - we'll emit ResumedEvent when we hit the approval
        )
      }
    })
  })
}

// =============================================================================
// Export namespace for clean usage in workflow code
// =============================================================================

/**
 * Workflow primitives namespace.
 * LLM-generated code uses these as `W.fetch`, `W.approval`, etc.
 */
export const W = {
  fetch,
  readFile,
  writeFile,
  exec,
  transform,
  approval,
  log
} as const
