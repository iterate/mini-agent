/**
 * Workflow Module
 *
 * Provides TypeScript Effect workflow execution:
 * - Journaled primitives (W.fetch, W.exec, W.approval, etc.)
 * - Parser for extracting TypeScript code from LLM responses
 * - Runtime with journaling to context events
 * - Suspend/resume for human-in-the-loop approvals
 *
 * Also includes JSON DSL for declarative workflows.
 */

// TypeScript workflow primitives (W namespace)
export * from "./workflow-primitives.ts"

// TypeScript workflow runtime (parser + executor)
export * from "./workflow-runtime.ts"

// Event types
export * from "./workflow-events.ts"

// Integration with context service
export * from "./workflow-integration.ts"

// JSON DSL (alternative declarative approach)
export * from "./workflow-dsl.ts"
export * from "./workflow-executor.ts"
export * from "./workflow-parser.ts"
