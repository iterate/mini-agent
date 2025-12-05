/**
 * Workflow Integration with Context Service
 *
 * Integrates TypeScript Effect workflow execution with the context event system.
 * When an LLM response contains workflow code, it's parsed and executed,
 * with all workflow events persisted as context events.
 */
import { Context, Effect, Layer, Option, pipe, Schema, Stream } from "effect"
import {
  AssistantMessageEvent,
  type ContextEvent,
  type PersistedEvent as PersistedEventType
} from "../context.model.ts"
import { ContextRepository } from "../context.repository.ts"
import type { ContextLoadError, ContextSaveError } from "../errors.ts"
import { type WorkflowEvent, WorkflowSuspendedEvent } from "./workflow-events.ts"
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
 * executes it with journaling, and persists events.
 */
export class WorkflowContextService extends Context.Tag("@app/WorkflowContextService")<
  WorkflowContextService,
  {
    /**
     * Process an LLM response, detecting and executing any workflows.
     * Returns a stream of context events (including workflow events).
     */
    readonly processResponse: (
      contextName: string,
      response: string
    ) => Stream.Stream<ContextEvent | WorkflowEvent, WorkflowIntegrationError>

    /**
     * Resume a suspended workflow in a context.
     * Called when user approves a pending workflow step.
     */
    readonly approveWorkflow: (
      contextName: string,
      executionId: string,
      approvedBy?: string
    ) => Effect.Effect<Array<WorkflowEvent>, WorkflowIntegrationError>

    /**
     * Get pending approvals for a context.
     */
    readonly getPendingApprovals: (
      contextName: string
    ) => Effect.Effect<Array<WorkflowSuspendedEvent>>
  }
>() {
  static readonly layer = Layer.effect(
    WorkflowContextService,
    Effect.gen(function*() {
      const repo = yield* ContextRepository
      const runtime = yield* WorkflowRuntime

      // Track pending approvals by context -> executionId -> event
      const pendingApprovals = new Map<string, Map<string, WorkflowSuspendedEvent>>()

      const ensurePendingMap = (contextName: string) => {
        let map = pendingApprovals.get(contextName)
        if (!map) {
          map = new Map()
          pendingApprovals.set(contextName, map)
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

              const { events } = workflowResult.value

              // Persist workflow events
              yield* Effect.gen(function*() {
                const current = yield* repo.load(contextName)
                // Cast workflow events to persisted events
                yield* repo.save(contextName, [
                  ...current,
                  ...events as unknown as Array<PersistedEventType>
                ])

                // Track suspended events for approval
                for (const event of events) {
                  if (Schema.is(WorkflowSuspendedEvent)(event)) {
                    const map = ensurePendingMap(contextName)
                    map.set(event.executionId, event)
                  }
                }

                // Remove from pending on completion/failure
                for (const event of events) {
                  if (event._tag === "WorkflowCompleted" || event._tag === "WorkflowFailed") {
                    const map = pendingApprovals.get(contextName)
                    map?.delete(event.executionId)
                  }
                }
              })

              // Emit all events
              return pipe(
                Stream.make(assistantEvent as ContextEvent | WorkflowEvent),
                Stream.concat(Stream.fromIterable(events))
              )
            })
          ),

        approveWorkflow: (contextName, executionId, _approvedBy) =>
          Effect.gen(function*() {
            // In production, this would resume a suspended workflow
            // For now, just mark as approved and log
            const map = pendingApprovals.get(contextName)
            const pending = map?.get(executionId)

            if (!pending) {
              yield* Effect.logWarning("No pending approval found", { executionId })
              return []
            }

            // Remove from pending
            map?.delete(executionId)

            // In full implementation: resume workflow execution from the approval step
            yield* Effect.logInfo("Workflow approved", { executionId })
            return []
          }),

        getPendingApprovals: (contextName) =>
          Effect.sync(() => {
            const map = pendingApprovals.get(contextName)
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
 * Example: Full conversation with TypeScript workflow
 *
 * ```typescript
 * const program = Effect.gen(function*() {
 *   const contextService = yield* WorkflowContextService
 *
 *   // 1. LLM responds with TypeScript Effect workflow
 *   const llmResponse = `
 * I'll create a workflow to deploy your application:
 *
 * \`\`\`typescript
 * Effect.gen(function*() {
 *   yield* W.log("Starting deployment")
 *
 *   // Build
 *   const build = yield* W.exec("npm run build")
 *   if (build.exitCode !== 0) {
 *     throw new Error("Build failed: " + build.stderr)
 *   }
 *
 *   // Test
 *   const test = yield* W.exec("npm test")
 *   yield* W.log("Tests passed", { exitCode: test.exitCode })
 *
 *   // Request approval before production deploy
 *   yield* W.approval("Build and tests passed. Deploy to production?", {
 *     buildOutput: build.stdout.slice(-200)
 *   })
 *
 *   // Deploy
 *   yield* W.exec("kubectl apply -f k8s/production/")
 *
 *   return { status: "deployed" }
 * })
 * \`\`\`
 *
 * This will build, test, get your approval, then deploy.
 *   `
 *
 *   // 2. Process response - executes workflow, journals events
 *   const events = yield* contextService.processResponse("deployment", llmResponse).pipe(
 *     Stream.runCollect
 *   )
 *
 *   // 3. Events include:
 *   // - AssistantMessageEvent (the LLM response text)
 *   // - WorkflowStartedEvent
 *   // - WorkflowStepCompletedEvent (build)
 *   // - WorkflowStepCompletedEvent (test)
 *   // - WorkflowSuspendedEvent (waiting for approval)
 *
 *   // 4. Get pending approvals
 *   const pending = yield* contextService.getPendingApprovals("deployment")
 *   console.log(pending[0]?.message) // "Build and tests passed. Deploy to production?"
 *
 *   // 5. User approves
 *   yield* contextService.approveWorkflow("deployment", pending[0].executionId, "user@example.com")
 * })
 * ```
 */
