/**
 * Codemode Event Schemas
 *
 * Codemode allows the LLM to emit TypeScript code blocks that get:
 * 1. Parsed from <codemode>...</codemode> markers in assistant responses
 * 2. Stored to filesystem with proper structure
 * 3. Typechecked with TypeScript compiler
 * 4. Executed via bun subprocess
 *
 * Events flow through the system as the code is processed.
 */
import { Effect, Option, Schema } from "effect"

/** Branded type for response IDs - timestamps like "2025-12-04_15-30-00" */
export const ResponseId = Schema.String.pipe(Schema.brand("ResponseId"))
export type ResponseId = typeof ResponseId.Type

/** Code block extracted from assistant response */
export class CodeBlockEvent extends Schema.TaggedClass<CodeBlockEvent>()("CodeBlock", {
  code: Schema.String,
  responseId: ResponseId,
  attempt: Schema.Number
}) {}

/** Typecheck started */
export class TypecheckStartEvent extends Schema.TaggedClass<TypecheckStartEvent>()("TypecheckStart", {
  responseId: ResponseId,
  attempt: Schema.Number
}) {}

/** Typecheck passed */
export class TypecheckPassEvent extends Schema.TaggedClass<TypecheckPassEvent>()("TypecheckPass", {
  responseId: ResponseId,
  attempt: Schema.Number
}) {}

/** Typecheck failed with errors */
export class TypecheckFailEvent extends Schema.TaggedClass<TypecheckFailEvent>()("TypecheckFail", {
  responseId: ResponseId,
  attempt: Schema.Number,
  errors: Schema.String
}) {}

/** Code execution started */
export class ExecutionStartEvent extends Schema.TaggedClass<ExecutionStartEvent>()("ExecutionStart", {
  responseId: ResponseId
}) {}

/** Streaming output from code execution */
export class ExecutionOutputEvent extends Schema.TaggedClass<ExecutionOutputEvent>()("ExecutionOutput", {
  responseId: ResponseId,
  stream: Schema.Literal("stdout", "stderr"),
  data: Schema.String
}) {}

/** Code execution completed */
export class ExecutionCompleteEvent extends Schema.TaggedClass<ExecutionCompleteEvent>()("ExecutionComplete", {
  responseId: ResponseId,
  exitCode: Schema.Number
}) {}

/** All codemode events */
export const CodemodeEvent = Schema.Union(
  CodeBlockEvent,
  TypecheckStartEvent,
  TypecheckPassEvent,
  TypecheckFailEvent,
  ExecutionStartEvent,
  ExecutionOutputEvent,
  ExecutionCompleteEvent
)
export type CodemodeEvent = typeof CodemodeEvent.Type

/** Code block extraction markers */
const CODEMODE_START = "<codemode>"
const CODEMODE_END = "</codemode>"

/** Extract code from markdown fences if present */
const stripMarkdownFences = (code: string): string => {
  const trimmed = code.trim()
  const match = trimmed.match(/^```(?:typescript|ts)?\n?([\s\S]*?)\n?```$/)
  return match ? match[1]! : trimmed
}

/**
 * Parse codemode block from text content.
 * Returns Option.some with the extracted code if markers are found.
 */
export const parseCodeBlock = (
  text: string
): Effect.Effect<Option.Option<string>> =>
  Effect.sync(() => {
    const startIdx = text.indexOf(CODEMODE_START)
    if (startIdx === -1) return Option.none()

    const afterStart = startIdx + CODEMODE_START.length
    const endIdx = text.indexOf(CODEMODE_END, afterStart)
    if (endIdx === -1) return Option.none()

    const rawCode = text.slice(afterStart, endIdx)
    const code = stripMarkdownFences(rawCode)

    return code.trim() ? Option.some(code) : Option.none()
  })

/** Check if text contains codemode markers */
export const hasCodeBlock = (text: string): boolean => text.includes(CODEMODE_START) && text.includes(CODEMODE_END)

/** Generate a response ID from current timestamp */
export const generateResponseId = (): Effect.Effect<ResponseId> =>
  Effect.sync(() => {
    const now = new Date()
    const pad = (n: number) => n.toString().padStart(2, "0")
    const id = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${
      pad(now.getMinutes())
    }-${pad(now.getSeconds())}`
    return id as ResponseId
  })
