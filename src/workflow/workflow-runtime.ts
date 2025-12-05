/**
 * Workflow Runtime
 *
 * Parses and executes TypeScript Effect code from LLM responses.
 * The LLM emits code using `W.*` primitives which are journaled.
 *
 * Example LLM output:
 * ```typescript
 * Effect.gen(function*() {
 *   const response = yield* W.fetch("https://api.example.com/data")
 *   const body = yield* Effect.tryPromise(() => response.json())
 *
 *   if (body.requiresApproval) {
 *     yield* W.approval("Deploy to production?", { data: body })
 *   }
 *
 *   yield* W.writeFile("output.json", JSON.stringify(body, null, 2))
 *   return body
 * })
 * ```
 */
import { Context, Effect, Layer, Schema } from "effect"
import type { WorkflowEvent } from "./workflow-events.ts"
import type { WorkflowCtx } from "./workflow-primitives.ts"
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
const buildWorkflowEffect = (
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

export interface WorkflowExecutionResult {
  readonly result: unknown
  readonly events: Array<WorkflowEvent>
  readonly suspended: boolean
  readonly error?: unknown
}

/**
 * Workflow Runtime Service
 *
 * Parses TypeScript Effect code from LLM responses and executes it
 * with journaling.
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
            // Build the Effect from code
            const workflow = yield* buildWorkflowEffect(code)

            // Run with journaling
            const result = yield* runner.run(name, workflow).pipe(
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

            return result
          }),

        executeFromResponse: (name, response) =>
          Effect.gen(function*() {
            // Extract code
            const blocks = extractCodeBlocks(response)
            if (blocks.length === 0) {
              return yield* new WorkflowCodeParseError({
                message: "No workflow code found in response"
              })
            }
            const code = blocks[0]!

            // Build and run
            const workflow = yield* buildWorkflowEffect(code)
            return yield* runner.run(name, workflow).pipe(
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
          })
      })
    })
  )

  /** Layer with all dependencies */
  static readonly live = Layer.merge(WorkflowRunner.layer, WorkflowRuntime.layer)
}

/**
 * Example LLM Response:
 *
 * ---
 * I'll create a workflow to fetch data and save it:
 *
 * ```typescript
 * Effect.gen(function*() {
 *   yield* W.log("Starting data fetch workflow")
 *
 *   const response = yield* W.fetch("https://api.example.com/data")
 *   const data = yield* Effect.tryPromise(() => response.json())
 *
 *   yield* W.log("Data fetched", { count: data.items.length })
 *
 *   if (data.items.length > 100) {
 *     yield* W.approval("Large dataset detected. Continue with processing?", {
 *       itemCount: data.items.length
 *     })
 *   }
 *
 *   const processed = yield* W.transform("processItems", data, (d) => ({
 *     ...d,
 *     processedAt: new Date().toISOString()
 *   }))
 *
 *   yield* W.writeFile("output.json", JSON.stringify(processed, null, 2))
 *
 *   return { success: true, itemCount: data.items.length }
 * })
 * ```
 *
 * This workflow will:
 * 1. Fetch data from the API
 * 2. Request approval if there are more than 100 items
 * 3. Process and save the results
 * ---
 */
