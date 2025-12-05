/**
 * Workflow Runtime
 *
 * Parses and executes TypeScript Effect code from LLM responses.
 * The LLM emits code using `W.*` primitives which are journaled.
 *
 * Supports suspend/resume via deterministic replay:
 * - When suspended at an approval gate, workflow state is persisted
 * - On resume, workflow replays from the beginning using cached step results
 * - Steps before the approval return cached values; steps after execute normally
 */
import { Context, Effect, Layer, Schema } from "effect"
import type { WorkflowCtx, WorkflowExecutionResult, WorkflowState } from "./workflow-primitives.ts"
import { W, WorkflowRunner } from "./workflow-primitives.ts"

/** Pattern to extract TypeScript Effect code from LLM responses */
const TYPESCRIPT_BLOCK_PATTERN = /```(?:typescript|ts)\s*\n([\s\S]*?)\n```/gi

/** Pattern for workflow-tagged TypeScript blocks */
const WORKFLOW_TS_PATTERN = /```workflow(?:\.ts)?\s*\n([\s\S]*?)\n```/gi

/** Extract code blocks from response */
const extractCodeBlocks = (response: string): Array<string> => {
  const blocks: Array<string> = []

  // Try workflow-specific blocks first (higher priority)
  for (const match of response.matchAll(WORKFLOW_TS_PATTERN)) {
    if (match[1]) blocks.push(match[1])
  }

  // If no workflow blocks, try generic typescript blocks that look like Effects
  if (blocks.length === 0) {
    for (const match of response.matchAll(TYPESCRIPT_BLOCK_PATTERN)) {
      const code = match[1]
      // Only include if it looks like Effect workflow code
      if (code && (code.includes("Effect.gen") || code.includes("W."))) {
        blocks.push(code)
      }
    }
  }

  return blocks
}

export class WorkflowCodeParseError extends Schema.TaggedError<WorkflowCodeParseError>()(
  "WorkflowCodeParseError",
  {
    message: Schema.String,
    code: Schema.optional(Schema.String)
  }
) {}

export class WorkflowCodeExecutionError extends Schema.TaggedError<WorkflowCodeExecutionError>()(
  "WorkflowCodeExecutionError",
  {
    message: Schema.String,
    code: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * Build a workflow Effect from code string.
 * Uses Function constructor to create the Effect.
 *
 * SECURITY NOTE: This executes arbitrary code. In production:
 * - Use isolated-vm or similar sandbox
 * - Validate code structure before execution
 * - Limit available APIs
 */
export const buildWorkflowEffect = (
  code: string
): Effect.Effect<
  Effect.Effect<unknown, Error, WorkflowCtx>,
  WorkflowCodeParseError
> =>
  Effect.try({
    try: () => {
      // Wrap code in a function that returns the Effect
      // The LLM is expected to emit an Effect.gen(...) expression
      const wrappedCode = `
        return (function(Effect, W) {
          "use strict";
          return ${code.trim()};
        })
      `

      // Create the factory function

      const factory = new Function(wrappedCode)() as (
        effect: typeof Effect,
        w: typeof W
      ) => Effect.Effect<unknown, Error, WorkflowCtx>

      // Call with our Effect and W namespace
      return factory(Effect, W)
    },
    catch: (e) =>
      new WorkflowCodeParseError({
        message: `Failed to parse workflow code: ${e}`,
        code: code.slice(0, 200)
      })
  })

/**
 * Workflow Runtime Service
 *
 * Parses TypeScript Effect code from LLM responses and executes it
 * with journaling. Supports suspend/resume for approval gates.
 */
export class WorkflowRuntime extends Context.Tag("@app/WorkflowRuntime")<
  WorkflowRuntime,
  {
    /**
     * Check if a response contains executable workflow code.
     */
    readonly hasWorkflowCode: (response: string) => boolean

    /**
     * Extract workflow code from an LLM response.
     */
    readonly extractCode: (
      response: string
    ) => Effect.Effect<string, WorkflowCodeParseError>

    /**
     * Execute workflow code and return journaled events.
     * Returns WorkflowState which can be persisted for resume.
     */
    readonly execute: (
      name: string,
      code: string
    ) => Effect.Effect<
      WorkflowExecutionResult,
      WorkflowCodeParseError | WorkflowCodeExecutionError
    >

    /**
     * Parse and execute workflow from an LLM response.
     * Combines extractCode and execute.
     */
    readonly executeFromResponse: (
      name: string,
      response: string
    ) => Effect.Effect<
      WorkflowExecutionResult,
      WorkflowCodeParseError | WorkflowCodeExecutionError
    >

    /**
     * Resume a suspended workflow.
     * Re-parses the code from saved state and replays with cached results.
     */
    readonly resume: (
      state: WorkflowState,
      approvedBy: string
    ) => Effect.Effect<
      WorkflowExecutionResult,
      WorkflowCodeParseError | WorkflowCodeExecutionError
    >
  }
>() {
  static readonly layer = Layer.effect(
    WorkflowRuntime,
    Effect.gen(function*() {
      const runner = yield* WorkflowRunner

      return WorkflowRuntime.of({
        hasWorkflowCode: (response) => {
          const blocks = extractCodeBlocks(response)
          return blocks.length > 0
        },

        extractCode: (response) =>
          Effect.gen(function*() {
            const blocks = extractCodeBlocks(response)
            if (blocks.length === 0) {
              return yield* new WorkflowCodeParseError({
                message: "No workflow code found in response"
              })
            }

            if (blocks.length > 1) {
              yield* Effect.logWarning("Multiple code blocks found, using first one", {
                count: blocks.length
              })
            }

            const code = blocks[0]
            if (!code) {
              return yield* new WorkflowCodeParseError({
                message: "Empty code block"
              })
            }
            return code
          }),

        execute: (name, code) =>
          Effect.gen(function*() {
            const workflow = yield* buildWorkflowEffect(code)
            return yield* runner.run(name, code, workflow).pipe(
              Effect.catchAll((e) =>
                Effect.fail(
                  new WorkflowCodeExecutionError({
                    message: `Workflow execution failed: ${e}`,
                    code: code.slice(0, 200),
                    cause: e
                  })
                )
              )
            )
          }),

        executeFromResponse: (name, response) =>
          Effect.gen(function*() {
            const blocks = extractCodeBlocks(response)
            if (blocks.length === 0) {
              return yield* new WorkflowCodeParseError({
                message: "No workflow code found in response"
              })
            }
            const code = blocks[0]!

            const workflow = yield* buildWorkflowEffect(code)
            return yield* runner.run(name, code, workflow).pipe(
              Effect.catchAll((e) =>
                Effect.fail(
                  new WorkflowCodeExecutionError({
                    message: `Workflow execution failed: ${e}`,
                    code: code.slice(0, 200),
                    cause: e
                  })
                )
              )
            )
          }),

        resume: (state, approvedBy) =>
          Effect.gen(function*() {
            // Re-parse the workflow code from saved state
            const workflow = yield* buildWorkflowEffect(state.workflowCode)

            // Resume with the runner (replays from beginning with cached results)
            return yield* runner.resume(state, workflow, approvedBy).pipe(
              Effect.catchAll((e) =>
                Effect.fail(
                  new WorkflowCodeExecutionError({
                    message: `Workflow resume failed: ${e}`,
                    code: state.workflowCode.slice(0, 200),
                    cause: e
                  })
                )
              )
            )
          })
      })
    })
  )

  /** Layer with all dependencies */
  static readonly live = Layer.merge(WorkflowRunner.layer, WorkflowRuntime.layer)
}

/**
 * Resume Flow Example:
 *
 * ```typescript
 * // 1. First execution hits approval gate and suspends
 * const result1 = yield* runtime.executeFromResponse("deploy", llmResponse)
 * // result1.suspended === true
 * // result1.pendingApproval === { stepId: "approval-3", message: "Deploy to prod?" }
 * // result1.state contains the full workflow state for persistence
 *
 * // 2. Save state (e.g., to context events or database)
 * yield* saveWorkflowState(result1.state)
 *
 * // 3. Later, user approves...
 * const savedState = yield* loadWorkflowState(executionId)
 *
 * // 4. Resume - replays from beginning with cached results
 * const result2 = yield* runtime.resume(savedState, "user@example.com")
 * // Steps before approval return cached values instantly
 * // Approval step passes (now approved)
 * // Steps after approval execute normally
 * // result2.suspended === false (or true if another approval)
 * ```
 */
