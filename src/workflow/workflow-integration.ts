/**
 * Workflow Integration with Context Service
 *
 * Demonstrates how to:
 * 1. Detect workflow code in LLM responses
 * 2. Parse and execute workflows
 * 3. Journal workflow events as context events
 * 4. Handle approval flows with suspend/resume
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
import type { WorkflowExecutionError } from "./workflow-executor.ts"
import { WorkflowExecutor } from "./workflow-executor.ts"
import type { WorkflowParseError } from "./workflow-parser.ts"
import { parseWorkflowFromResponse } from "./workflow-parser.ts"

// =============================================================================
// Extended Event Types (add workflow events to persisted events)
// =============================================================================

/**
 * Extended persisted event union that includes workflow events.
 * In production, you'd update context.model.ts to include these.
 */
// Note: For actual integration, add WorkflowEvent types to context.model.ts PersistedEvent union

// =============================================================================
// Combined Error Type
// =============================================================================

type WorkflowIntegrationError =
  | WorkflowParseError
  | WorkflowExecutionError
  | ContextLoadError
  | ContextSaveError

// =============================================================================
// Workflow-Aware Context Service
// =============================================================================

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
    ) => Stream.Stream<WorkflowEvent, WorkflowIntegrationError>

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
      const executor = yield* WorkflowExecutor

      // Track pending approvals by context
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
              // Try to parse workflow from response
              const workflowResult = yield* parseWorkflowFromResponse(response).pipe(
                Effect.map(Option.some),
                Effect.catchTag("WorkflowParseError", () => Effect.succeed(Option.none()))
              )

              if (Option.isNone(workflowResult)) {
                // No workflow - just emit the assistant message
                return Stream.make(
                  new AssistantMessageEvent({ content: response }) as ContextEvent | WorkflowEvent
                )
              }

              const workflow = workflowResult.value

              // Emit assistant message first (contains the workflow definition)
              const assistantEvent = new AssistantMessageEvent({ content: response })

              // Execute workflow and stream events
              const workflowEvents = executor.execute(workflow).pipe(
                // Persist each event
                Stream.tap((event) =>
                  Effect.gen(function*() {
                    const current = yield* repo.load(contextName)
                    // Cast workflow event to persisted event (in prod, WorkflowEvent would be in union)
                    yield* repo.save(contextName, [...current, event as unknown as PersistedEventType])

                    // Track suspended events for approval
                    if (Schema.is(WorkflowSuspendedEvent)(event)) {
                      const map = ensurePendingMap(contextName)
                      map.set(event.executionId, event)
                    }
                  })
                ),
                // Remove from pending on completion/failure
                Stream.tap((event) =>
                  Effect.sync(() => {
                    if (event._tag === "WorkflowCompleted" || event._tag === "WorkflowFailed") {
                      const map = pendingApprovals.get(contextName)
                      map?.delete(event.executionId)
                    }
                  })
                )
              )

              return pipe(
                Stream.make(assistantEvent as ContextEvent | WorkflowEvent),
                Stream.concat(workflowEvents)
              )
            })
          ),

        approveWorkflow: (contextName, executionId, approvedBy) =>
          executor.resume(executionId, approvedBy).pipe(
            Stream.tap((event) =>
              Effect.gen(function*() {
                const current = yield* repo.load(contextName)
                yield* repo.save(contextName, [...current, event as unknown as PersistedEventType])

                // Remove from pending on completion
                if (event._tag === "WorkflowCompleted" || event._tag === "WorkflowFailed") {
                  const map = pendingApprovals.get(contextName)
                  map?.delete(executionId)
                }
              })
            )
          ),

        getPendingApprovals: (contextName) =>
          Effect.sync(() => {
            const map = pendingApprovals.get(contextName)
            return map ? Array.from(map.values()) : []
          })
      })
    })
  )
}

// =============================================================================
// Example Usage (showing the full flow)
// =============================================================================

/**
 * Example: Full conversation with workflow execution and approval
 *
 * ```typescript
 * const program = Effect.gen(function*() {
 *   const contextService = yield* WorkflowContextService
 *
 *   // 1. User asks for a deployment
 *   const userMessage = new UserMessageEvent({
 *     content: "Deploy version 2.0 to production with approval gate"
 *   })
 *
 *   // 2. LLM responds with a workflow
 *   const llmResponse = `
 * I'll create a deployment workflow with an approval gate:
 *
 * \`\`\`workflow
 * {
 *   "name": "deploy-v2",
 *   "steps": [
 *     { "_tag": "Shell", "id": "build", "command": "npm run build" },
 *     { "_tag": "Shell", "id": "test", "command": "npm test" },
 *     { "_tag": "Shell", "id": "deploy-staging", "command": "kubectl apply -f staging/" },
 *     {
 *       "_tag": "Approval",
 *       "id": "approve-prod",
 *       "message": "Staging deployment successful. Deploy to production?",
 *       "context": { "version": "2.0", "staging_url": "https://staging.example.com" }
 *     },
 *     { "_tag": "Shell", "id": "deploy-prod", "command": "kubectl apply -f production/" }
 *   ]
 * }
 * \`\`\`
 *
 * The workflow will:
 * 1. Build the application
 * 2. Run tests
 * 3. Deploy to staging
 * 4. Wait for your approval
 * 5. Deploy to production
 *   `
 *
 *   // 3. Process the response (executes workflow, journals events)
 *   const events = yield* contextService.processResponse("deployment", llmResponse).pipe(
 *     Stream.runCollect
 *   )
 *
 *   // Events will be:
 *   // - AssistantMessageEvent (the LLM response)
 *   // - WorkflowStartedEvent
 *   // - WorkflowStepCompletedEvent (build)
 *   // - WorkflowStepCompletedEvent (test)
 *   // - WorkflowStepCompletedEvent (deploy-staging)
 *   // - WorkflowSuspendedEvent (waiting for approval)
 *
 *   // 4. Check pending approvals
 *   const pending = yield* contextService.getPendingApprovals("deployment")
 *   // [{ executionId: "...", stepId: "approve-prod", message: "Deploy to production?" }]
 *
 *   // 5. User approves (could be from CLI input, web UI, Slack, etc.)
 *   const resumeEvents = yield* contextService.approveWorkflow(
 *     "deployment",
 *     pending[0].executionId,
 *     "user@example.com"
 *   ).pipe(Stream.runCollect)
 *
 *   // Events will be:
 *   // - WorkflowResumedEvent
 *   // - WorkflowStepCompletedEvent (deploy-prod)
 *   // - WorkflowCompletedEvent
 *
 *   // 6. All events are now persisted in the context YAML file
 * })
 * ```
 */

// =============================================================================
// Example: What the context YAML looks like after workflow execution
// =============================================================================

/**
 * After the above flow, the context file would contain:
 *
 * ```yaml
 * events:
 *   - _tag: SystemPrompt
 *     content: "You are a helpful assistant..."
 *
 *   - _tag: UserMessage
 *     content: "Deploy version 2.0 to production with approval gate"
 *
 *   - _tag: AssistantMessage
 *     content: "I'll create a deployment workflow..."
 *
 *   - _tag: WorkflowStarted
 *     executionId: "abc123"
 *     workflowName: "deploy-v2"
 *     inputs: {}
 *     timestamp: 1701234567890
 *
 *   - _tag: WorkflowStepCompleted
 *     executionId: "abc123"
 *     stepId: "build"
 *     stepType: "Shell"
 *     output: { stdout: "...", exitCode: 0 }
 *     durationMs: 45000
 *     timestamp: 1701234612890
 *
 *   - _tag: WorkflowStepCompleted
 *     executionId: "abc123"
 *     stepId: "test"
 *     stepType: "Shell"
 *     output: { stdout: "...", exitCode: 0 }
 *     durationMs: 30000
 *     timestamp: 1701234642890
 *
 *   - _tag: WorkflowStepCompleted
 *     executionId: "abc123"
 *     stepId: "deploy-staging"
 *     stepType: "Shell"
 *     output: { stdout: "...", exitCode: 0 }
 *     durationMs: 15000
 *     timestamp: 1701234657890
 *
 *   - _tag: WorkflowSuspended
 *     executionId: "abc123"
 *     stepId: "approve-prod"
 *     reason: "approval"
 *     message: "Staging deployment successful. Deploy to production?"
 *     context: { version: "2.0", staging_url: "https://staging.example.com" }
 *     timestamp: 1701234657900
 *
 *   # --- User approves later ---
 *
 *   - _tag: WorkflowResumed
 *     executionId: "abc123"
 *     stepId: "approve-prod"
 *     approvedBy: "user@example.com"
 *     timestamp: 1701234957890
 *
 *   - _tag: WorkflowStepCompleted
 *     executionId: "abc123"
 *     stepId: "deploy-prod"
 *     stepType: "Shell"
 *     output: { stdout: "...", exitCode: 0 }
 *     durationMs: 20000
 *     timestamp: 1701234977890
 *
 *   - _tag: WorkflowCompleted
 *     executionId: "abc123"
 *     output: { stdout: "...", exitCode: 0 }
 *     totalDurationMs: 320000
 *     timestamp: 1701234977900
 * ```
 *
 * This provides:
 * - Full audit trail of what happened
 * - Ability to replay/resume workflows
 * - Integration with conversation history
 * - Machine-readable structured events
 */
