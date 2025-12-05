/**
 * Workflow Module
 *
 * Provides LLM-emittable workflow DSL with:
 * - Declarative step definitions (Fetch, Shell, Approval, etc.)
 * - Parser for extracting workflows from LLM responses
 * - Executor with journaling to context events
 * - Suspend/resume for human-in-the-loop approvals
 */

// DSL and schema
export * from "./workflow-dsl.ts"

// Event types
export * from "./workflow-events.ts"

// Parser
export * from "./workflow-parser.ts"

// Executor
export * from "./workflow-executor.ts"

// Integration with context service
export * from "./workflow-integration.ts"
