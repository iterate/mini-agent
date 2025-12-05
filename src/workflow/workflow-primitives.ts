/**
 * Workflow Primitives
 *
 * Journaled Effect operations that LLM-generated workflow code can use.
 * Each operation automatically records events to the context.
 *
 * The LLM emits TypeScript Effect code using these primitives:
 *
 * ```typescript
 * Effect.gen(function*() {
 *   const response = yield* W.fetch("https://api.example.com/data")
 *   const parsed = yield* W.transform(response, (r) => r.json())
 *
 *   if (parsed.needsReview) {
 *     yield* W.approval("Deploy changes?", { data: parsed })
 *   }
 *
 *   yield* W.writeFile("output.json", JSON.stringify(parsed))
 *   return parsed
 * })
 * ```
 */
import { Context, Effect, Layer, Ref } from "effect"
import type { WorkflowEvent } from "./workflow-events.ts"
import {
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowStartedEvent,
  WorkflowStepCompletedEvent,
  WorkflowStepFailedEvent,
  WorkflowSuspendedEvent
} from "./workflow-events.ts"

// =============================================================================
// Workflow Context - tracks execution state
// =============================================================================

export interface WorkflowContext {
  readonly executionId: string
  readonly workflowName: string
  readonly events: Ref.Ref<Array<WorkflowEvent>>
  readonly suspended: Ref.Ref<boolean>
  readonly startTime: number
}

export class WorkflowCtx extends Context.Tag("@app/WorkflowCtx")<
  WorkflowCtx,
  WorkflowContext
>() {}

// =============================================================================
// Journaled Primitives - these operations get recorded
// =============================================================================

/** Generate a unique step ID */
let stepCounter = 0
const nextStepId = (prefix: string) => `${prefix}-${++stepCounter}`

/**
 * Journaled fetch - records the HTTP request and response
 */
export const fetch = (
  url: string,
  options?: RequestInit
): Effect.Effect<Response, Error, WorkflowCtx> =>
  Effect.gen(function*() {
    const ctx = yield* WorkflowCtx
    const stepId = nextStepId("fetch")
    const startTime = Date.now()

    try {
      // In production, use @effect/platform HttpClient
      const response = yield* Effect.tryPromise({
        try: () => globalThis.fetch(url, options),
        catch: (e) => new Error(`Fetch failed: ${e}`)
      })

      yield* recordStep(ctx, stepId, "Fetch", { url, status: response.status }, startTime)
      return response
    } catch (error) {
      yield* recordStepFailure(ctx, stepId, "Fetch", String(error))
      throw error
    }
  })

/**
 * Journaled file read
 */
export const readFile = (
  path: string
): Effect.Effect<string, Error, WorkflowCtx> =>
  Effect.gen(function*() {
    const ctx = yield* WorkflowCtx
    const stepId = nextStepId("readFile")
    const startTime = Date.now()

    try {
      // In production, use @effect/platform FileSystem
      const content = yield* Effect.tryPromise({
        try: () => Bun.file(path).text(),
        catch: (e) => new Error(`Read failed: ${e}`)
      })

      yield* recordStep(ctx, stepId, "ReadFile", { path, length: content.length }, startTime)
      return content
    } catch (error) {
      yield* recordStepFailure(ctx, stepId, "ReadFile", String(error))
      throw error
    }
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
    const stepId = nextStepId("writeFile")
    const startTime = Date.now()

    try {
      yield* Effect.tryPromise({
        try: () => Bun.write(path, content),
        catch: (e) => new Error(`Write failed: ${e}`)
      })

      yield* recordStep(ctx, stepId, "WriteFile", { path, length: content.length }, startTime)
    } catch (error) {
      yield* recordStepFailure(ctx, stepId, "WriteFile", String(error))
      throw error
    }
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
    const stepId = nextStepId("exec")
    const startTime = Date.now()

    try {
      // Use Bun's shell
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
      yield* recordStep(ctx, stepId, "Exec", { command, ...result }, startTime)
      return result
    } catch (error) {
      yield* recordStepFailure(ctx, stepId, "Exec", String(error))
      throw error
    }
  })

/**
 * Journaled data transformation with logging
 */
export const transform = <A, B>(
  name: string,
  input: A,
  fn: (a: A) => B
): Effect.Effect<B, Error, WorkflowCtx> =>
  Effect.gen(function*() {
    const ctx = yield* WorkflowCtx
    const stepId = nextStepId("transform")
    const startTime = Date.now()

    try {
      const result = fn(input)
      yield* recordStep(
        ctx,
        stepId,
        "Transform",
        { name, inputType: typeof input, outputType: typeof result },
        startTime
      )
      return result
    } catch (error) {
      yield* recordStepFailure(ctx, stepId, "Transform", String(error))
      throw error
    }
  })

/**
 * Approval gate - suspends workflow until approved
 */
export const approval = (
  message: string,
  context?: unknown
): Effect.Effect<void, never, WorkflowCtx> =>
  Effect.gen(function*() {
    const ctx = yield* WorkflowCtx
    const stepId = nextStepId("approval")

    // Record suspension
    const event = new WorkflowSuspendedEvent({
      executionId: ctx.executionId,
      stepId,
      reason: "approval",
      message,
      context,
      timestamp: Date.now()
    })

    yield* Ref.update(ctx.events, (events) => [...events, event])
    yield* Ref.set(ctx.suspended, true)

    // This will be caught by the executor and cause suspension
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
    const stepId = nextStepId("log")

    yield* recordStep(ctx, stepId, "Log", { message, data }, Date.now())
  })

// =============================================================================
// Internal helpers
// =============================================================================

const recordStep = (
  ctx: WorkflowContext,
  stepId: string,
  stepType: string,
  output: unknown,
  startTime: number
): Effect.Effect<void> =>
  Ref.update(ctx.events, (events) => [
    ...events,
    new WorkflowStepCompletedEvent({
      executionId: ctx.executionId,
      stepId,
      stepType,
      output,
      durationMs: Date.now() - startTime,
      timestamp: Date.now()
    })
  ])

const recordStepFailure = (
  ctx: WorkflowContext,
  stepId: string,
  stepType: string,
  error: string
): Effect.Effect<void> =>
  Ref.update(ctx.events, (events) => [
    ...events,
    new WorkflowStepFailedEvent({
      executionId: ctx.executionId,
      stepId,
      stepType,
      error,
      timestamp: Date.now()
    })
  ])

// =============================================================================
// Workflow Runner - executes workflow code with journaling
// =============================================================================

export class WorkflowRunner extends Context.Tag("@app/WorkflowRunner")<
  WorkflowRunner,
  {
    /**
     * Run a workflow Effect, capturing all journaled events.
     * Returns the events that occurred during execution.
     */
    readonly run: <A, E>(
      name: string,
      workflow: Effect.Effect<A, E, WorkflowCtx>
    ) => Effect.Effect<{
      readonly result: A | undefined
      readonly events: Array<WorkflowEvent>
      readonly suspended: boolean
      readonly error?: E
    }>
  }
>() {
  static readonly layer = Layer.sync(WorkflowRunner, () => {
    return WorkflowRunner.of({
      run: <A, E>(name: string, workflow: Effect.Effect<A, E, WorkflowCtx>) =>
        Effect.gen(function*() {
          const executionId = crypto.randomUUID()
          const events = yield* Ref.make<Array<WorkflowEvent>>([])
          const suspended = yield* Ref.make(false)
          const startTime = Date.now()

          const ctx: WorkflowContext = {
            executionId,
            workflowName: name,
            events,
            suspended,
            startTime
          }

          // Record start
          yield* Ref.update(events, (e) => [
            ...e,
            new WorkflowStartedEvent({
              executionId,
              workflowName: name,
              timestamp: startTime
            })
          ])

          // Run workflow
          const exit = yield* workflow.pipe(
            Effect.provideService(WorkflowCtx, ctx),
            Effect.exit
          )

          const isSuspended = yield* Ref.get(suspended)
          const allEvents = yield* Ref.get(events)

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

            return {
              result: exit.value,
              events: yield* Ref.get(events),
              suspended: false
            }
          } else if (isSuspended) {
            // Workflow suspended (approval gate)
            return {
              result: undefined,
              events: allEvents,
              suspended: true
            }
          } else {
            // Record failure
            const error = exit.cause
            yield* Ref.update(events, (e) => [
              ...e,
              new WorkflowFailedEvent({
                executionId,
                error: String(error),
                timestamp: Date.now()
              })
            ])

            return {
              result: undefined,
              events: yield* Ref.get(events),
              suspended: false,
              error: error as E
            }
          }
        })
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
