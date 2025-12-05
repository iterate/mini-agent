/**
 * Workflow Parser
 *
 * Extracts workflow definitions from LLM responses.
 * Supports multiple formats: JSON code blocks, YAML, or tagged sections.
 */
import { Effect, Option, Schema } from "effect"
import * as YAML from "yaml"
import { decodeWorkflowEffect, type WorkflowDefinition } from "./workflow-dsl.ts"

// =============================================================================
// Parse Error
// =============================================================================

export class WorkflowParseError extends Schema.TaggedError<WorkflowParseError>()(
  "WorkflowParseError",
  {
    message: Schema.String,
    source: Schema.optional(Schema.String)
  }
) {}

// =============================================================================
// Extraction Patterns
// =============================================================================

/**
 * Pattern 1: JSON code block
 * ```json
 * { "name": "...", "steps": [...] }
 * ```
 */
const JSON_BLOCK_PATTERN = /```json\s*\n([\s\S]*?)\n```/gi

/**
 * Pattern 2: YAML code block
 * ```yaml
 * name: ...
 * steps: [...]
 * ```
 */
const YAML_BLOCK_PATTERN = /```ya?ml\s*\n([\s\S]*?)\n```/gi

/**
 * Pattern 3: Workflow-tagged block (custom marker)
 * <workflow>
 * { ... }
 * </workflow>
 */
const WORKFLOW_TAG_PATTERN = /<workflow>\s*([\s\S]*?)\s*<\/workflow>/gi

/**
 * Pattern 4: Effect workflow code block
 * ```workflow
 * { ... }
 * ```
 */
const WORKFLOW_BLOCK_PATTERN = /```workflow\s*\n([\s\S]*?)\n```/gi

// =============================================================================
// Parser Functions
// =============================================================================

/** Try to parse content as JSON */
const tryParseJson = (content: string): Option.Option<unknown> => {
  try {
    return Option.some(JSON.parse(content))
  } catch {
    return Option.none()
  }
}

/** Try to parse content as YAML */
const tryParseYaml = (content: string): Option.Option<unknown> => {
  try {
    return Option.some(YAML.parse(content))
  } catch {
    return Option.none()
  }
}

/** Extract all matches from a regex pattern */
const extractMatches = (text: string, pattern: RegExp): Array<string> => {
  const matches: Array<string> = []
  let match
  // Reset regex state
  pattern.lastIndex = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match[1]) {
      matches.push(match[1])
    }
  }
  return matches
}

/**
 * Extract and parse workflow definitions from an LLM response.
 * Returns all valid workflows found in the response.
 */
export const parseWorkflowsFromResponse = (
  response: string
): Effect.Effect<Array<WorkflowDefinition>, WorkflowParseError> =>
  Effect.gen(function*() {
    const candidates: Array<{ source: string; parsed: unknown }> = []

    // Try all extraction patterns
    for (const content of extractMatches(response, WORKFLOW_BLOCK_PATTERN)) {
      const parsed = Option.getOrElse(tryParseJson(content), () => Option.getOrUndefined(tryParseYaml(content)))
      if (parsed) candidates.push({ source: content, parsed })
    }

    for (const content of extractMatches(response, WORKFLOW_TAG_PATTERN)) {
      const parsed = Option.getOrElse(tryParseJson(content), () => Option.getOrUndefined(tryParseYaml(content)))
      if (parsed) candidates.push({ source: content, parsed })
    }

    for (const content of extractMatches(response, JSON_BLOCK_PATTERN)) {
      const parsed = Option.getOrUndefined(tryParseJson(content))
      // Only include if it looks like a workflow (has name and steps)
      if (parsed && typeof parsed === "object" && parsed !== null) {
        const obj = parsed as Record<string, unknown>
        if ("name" in obj && "steps" in obj) {
          candidates.push({ source: content, parsed })
        }
      }
    }

    for (const content of extractMatches(response, YAML_BLOCK_PATTERN)) {
      const parsed = Option.getOrUndefined(tryParseYaml(content))
      if (parsed && typeof parsed === "object" && parsed !== null) {
        const obj = parsed as Record<string, unknown>
        if ("name" in obj && "steps" in obj) {
          candidates.push({ source: content, parsed })
        }
      }
    }

    // Validate each candidate against the schema
    const workflows: Array<WorkflowDefinition> = []
    const errors: Array<string> = []

    for (const { parsed, source } of candidates) {
      const result = yield* decodeWorkflowEffect(parsed).pipe(
        Effect.map((w) => ({ success: true as const, workflow: w })),
        Effect.catchAll((e) => Effect.succeed({ success: false as const, error: String(e) }))
      )

      if (result.success) {
        workflows.push(result.workflow)
      } else {
        errors.push(`Failed to parse workflow: ${result.error}\nSource: ${source.slice(0, 100)}...`)
      }
    }

    // Log parse errors for debugging but don't fail
    if (errors.length > 0) {
      yield* Effect.logDebug("Some workflow candidates failed validation", { errors })
    }

    return workflows
  })

/**
 * Extract exactly one workflow from a response.
 * Fails if zero or multiple workflows found.
 */
export const parseWorkflowFromResponse = (
  response: string
): Effect.Effect<WorkflowDefinition, WorkflowParseError> =>
  Effect.gen(function*() {
    const workflows = yield* parseWorkflowsFromResponse(response)

    if (workflows.length === 0) {
      return yield* new WorkflowParseError({
        message: "No valid workflow definition found in response",
        source: response.slice(0, 500)
      })
    }

    if (workflows.length > 1) {
      yield* Effect.logWarning("Multiple workflows found, using first one", {
        count: workflows.length,
        names: workflows.map((w) => w.name)
      })
    }

    const first = workflows[0]
    if (!first) {
      return yield* new WorkflowParseError({
        message: "No workflows found",
        source: response.slice(0, 500)
      })
    }

    return first
  })

// =============================================================================
// Example LLM Response (for documentation)
// =============================================================================

/**
 * Example of what an LLM might emit:
 *
 * ---
 * I'll create a workflow to deploy your application with approval gates:
 *
 * \`\`\`workflow
 * {
 *   "name": "deploy-to-production",
 *   "description": "Deploy application with staging verification and approval",
 *   "inputs": {
 *     "version": { "type": "string", "required": true },
 *     "environment": { "type": "string", "required": true }
 *   },
 *   "steps": [
 *     {
 *       "_tag": "Shell",
 *       "id": "build",
 *       "command": "npm run build"
 *     },
 *     {
 *       "_tag": "Shell",
 *       "id": "test",
 *       "command": "npm run test"
 *     },
 *     {
 *       "_tag": "Shell",
 *       "id": "deploy-staging",
 *       "command": "kubectl apply -f k8s/staging/"
 *     },
 *     {
 *       "_tag": "Fetch",
 *       "id": "health-check",
 *       "url": "https://staging.example.com/health",
 *       "extract": { "status": "$.status" }
 *     },
 *     {
 *       "_tag": "Conditional",
 *       "id": "check-health",
 *       "condition": "{{health-check.status}} === 'healthy'",
 *       "then": [
 *         {
 *           "_tag": "Approval",
 *           "id": "prod-approval",
 *           "message": "Staging deployment successful. Approve production deployment?",
 *           "context": {
 *             "version": "{{inputs.version}}",
 *             "staging_status": "{{health-check.status}}"
 *           }
 *         },
 *         {
 *           "_tag": "Shell",
 *           "id": "deploy-prod",
 *           "command": "kubectl apply -f k8s/production/"
 *         }
 *       ],
 *       "else": [
 *         {
 *           "_tag": "Shell",
 *           "id": "rollback",
 *           "command": "kubectl rollout undo -f k8s/staging/"
 *         }
 *       ]
 *     }
 *   ],
 *   "output": "{{deploy-prod}}"
 * }
 * \`\`\`
 *
 * This workflow will:
 * 1. Build and test locally
 * 2. Deploy to staging
 * 3. Run health check
 * 4. If healthy, request approval then deploy to prod
 * 5. If unhealthy, rollback staging
 * ---
 */
