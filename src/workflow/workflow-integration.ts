/**
 * Workflow Integration with Context Service
 *
 * Integrates TypeScript Effect workflow execution with the context event system.
 * When an LLM response contains workflow code, it's parsed and executed,
 * with all workflow events persisted as context events.
 *
 * Suspend/Resume Flow:
 * 1. Workflow hits W.approval() → suspends, WorkflowState saved
 * 2. User approves via approveWorkflow()
 * 3. Workflow replays from beginning with cached results
 * 4. Approval step passes, execution continues
 */
import { Context, Effect, Layer, Option, pipe, Stream } from "effect"
import {
  AssistantMessageEvent,
  type ContextEvent,
  type PersistedEvent as PersistedEventType
} from "../context.model.ts"
import { ContextRepository } from "../context.repository.ts"
import type { ContextLoadError, ContextSaveError } from "../errors.ts"
import type { WorkflowEvent } from "./workflow-events.ts"
import type { WorkflowExecutionResult, WorkflowState } from "./workflow-primitives.ts"
import { WorkflowRunner } from "./workflow-primitives.ts"
import type { WorkflowCodeExecutionError, WorkflowCodeParseError } from "./workflow-runtime.ts"
import { WorkflowRuntime } from "./workflow-runtime.ts"

type WorkflowIntegrationError =
  | WorkflowCodeParseError
  | WorkflowCodeExecutionError
  | ContextLoadError
  | ContextSaveError

/**
 * Workflow-Aware Context Service
 *
 * Processes LLM responses, detects TypeScript Effect workflow code,
 * executes it with journaling, and persists events and state.
 */
export class WorkflowContextService extends Context.Tag("@app/WorkflowContextService")<
  WorkflowContextService,
  {
    /**
     * Process an LLM response, detecting and executing any workflows.
     * Returns a stream of context events (including workflow events).
     * If workflow suspends, state is persisted for later resume.
     */
    readonly processResponse: (
      contextName: string,
      response: string
    ) => Stream.Stream<ContextEvent | WorkflowEvent, WorkflowIntegrationError>

    /**
     * Resume a suspended workflow in a context.
     * Re-executes workflow from beginning with cached results.
     * Returns new events from the resumed execution.
     */
    readonly approveWorkflow: (
      contextName: string,
      executionId: string,
      approvedBy: string
    ) => Effect.Effect<WorkflowExecutionResult, WorkflowIntegrationError>

    /**
     * Get pending workflow states for a context.
     */
    readonly getPendingWorkflows: (
      contextName: string
    ) => Effect.Effect<Array<WorkflowState>>
  }
>() {
  static readonly layer = Layer.effect(
    WorkflowContextService,
    Effect.gen(function*() {
      const repo = yield* ContextRepository
      const runtime = yield* WorkflowRuntime

      // In-memory store for suspended workflow states
      // In production, this would be persisted to disk/database
      const suspendedWorkflows = new Map<string, Map<string, WorkflowState>>()

      const getSuspendedMap = (contextName: string) => {
        let map = suspendedWorkflows.get(contextName)
        if (!map) {
          map = new Map()
          suspendedWorkflows.set(contextName, map)
        }
        return map
      }

      return WorkflowContextService.of({
        processResponse: (contextName, response) =>
          Stream.unwrap(
            Effect.gen(function*() {
              // Always emit the assistant message first
              const assistantEvent = new AssistantMessageEvent({ content: response })

              // Check if response contains workflow code
              if (!runtime.hasWorkflowCode(response)) {
                return Stream.make(assistantEvent as ContextEvent | WorkflowEvent)
              }

              // Execute workflow and collect events
              const workflowResult = yield* runtime.executeFromResponse(
                `workflow-${Date.now()}`,
                response
              ).pipe(
                Effect.map(Option.some),
                Effect.catchAll((e) => {
                  // Log error but continue - workflow parsing/execution failed
                  return Effect.logWarning("Workflow execution failed", { error: e }).pipe(
                    Effect.map(() => Option.none())
                  )
                })
              )

              if (Option.isNone(workflowResult)) {
                return Stream.make(assistantEvent as ContextEvent | WorkflowEvent)
              }

              const result = workflowResult.value
              const { events, state, suspended } = result

              // Persist workflow events to context
              yield* Effect.gen(function*() {
                const current = yield* repo.load(contextName)
                yield* repo.save(contextName, [
                  ...current,
                  ...events as unknown as Array<PersistedEventType>
                ])
              })

              // If suspended, save state for later resume
              if (suspended) {
                const map = getSuspendedMap(contextName)
                map.set(state.executionId, state)
                yield* Effect.logInfo("Workflow suspended, awaiting approval", {
                  executionId: state.executionId,
                  pendingApproval: state.pendingApproval
                })
              } else {
                // Completed or failed - remove from suspended if present
                const map = suspendedWorkflows.get(contextName)
                map?.delete(state.executionId)
              }

              // Emit all events
              return pipe(
                Stream.make(assistantEvent as ContextEvent | WorkflowEvent),
                Stream.concat(Stream.fromIterable(events))
              )
            })
          ),

        approveWorkflow: (contextName, executionId, approvedBy) =>
          Effect.gen(function*() {
            const map = suspendedWorkflows.get(contextName)
            const state = map?.get(executionId)

            if (!state) {
              return yield* Effect.fail(
                new Error(`No suspended workflow found: ${executionId}`) as unknown as WorkflowIntegrationError
              )
            }

            if (state.status !== "suspended" || !state.pendingApproval) {
              return yield* Effect.fail(
                new Error(`Workflow is not suspended: ${executionId}`) as unknown as WorkflowIntegrationError
              )
            }

            yield* Effect.logInfo("Resuming workflow", {
              executionId,
              approvedBy,
              stepId: state.pendingApproval.stepId
            })

            // Resume the workflow (replays from beginning with cached results)
            const result = yield* runtime.resume(state, approvedBy)

            // Persist new events
            yield* Effect.gen(function*() {
              const current = yield* repo.load(contextName)
              yield* repo.save(contextName, [
                ...current,
                ...result.events as unknown as Array<PersistedEventType>
              ])
            })

            // Update state
            if (result.suspended) {
              // Hit another approval gate
              map?.set(executionId, result.state)
            } else {
              // Completed or failed
              map?.delete(executionId)
            }

            return result
          }),

        getPendingWorkflows: (contextName) =>
          Effect.sync(() => {
            const map = suspendedWorkflows.get(contextName)
            return map ? Array.from(map.values()) : []
          })
      })
    })
  )

  static readonly live = Layer.provideMerge(
    WorkflowContextService.layer,
    Layer.merge(WorkflowRuntime.layer, WorkflowRunner.layer)
  )
}

/**
 * Complete Example: Workflow with Approval
 *
 * ```typescript
 * const program = Effect.gen(function*() {
 *   const service = yield* WorkflowContextService
 *
 *   // 1. LLM emits workflow code
 *   const llmResponse = `
 * I'll deploy your application:
 *
 * \`\`\`typescript
 * Effect.gen(function*() {
 *   // Build (result cached for replay)
 *   const build = yield* W.exec("npm run build")
 *   yield* W.log("Build complete", { exitCode: build.exitCode })
 *
 *   // Human approval gate
 *   yield* W.approval("Deploy to production?", {
 *     buildOutput: build.stdout.slice(-200)
 *   })
 *
 *   // Deploy (only runs after approval)
 *   yield* W.exec("kubectl apply -f k8s/")
 *   return { status: "deployed" }
 * })
 * \`\`\`
 *   `
 *
 *   // 2. Process response - executes until approval, then suspends
 *   yield* service.processResponse("deploy-ctx", llmResponse).pipe(
 *     Stream.tap((event) => Effect.log("Event:", event._tag)),
 *     Stream.runDrain
 *   )
 *   // Events: AssistantMessage, WorkflowStarted, StepCompleted(build),
 *   //         StepCompleted(log), WorkflowSuspended
 *
 *   // 3. Check pending workflows
 *   const pending = yield* service.getPendingWorkflows("deploy-ctx")
 *   // pending[0].pendingApproval.message === "Deploy to production?"
 *
 *   // 4. User approves...
 *   const result = yield* service.approveWorkflow(
 *     "deploy-ctx",
 *     pending[0].executionId,
 *     "user@example.com"
 *   )
 *   // Workflow replays:
 *   // - build step returns cached result (instant)
 *   // - log step returns cached result (instant)
 *   // - approval step sees it's approved, continues
 *   // - deploy step executes (new)
 *   // - workflow completes
 *
 *   // result.events: [WorkflowResumed, StepCompleted(deploy), WorkflowCompleted]
 *   // result.suspended === false
 * })
 * ```
 */
