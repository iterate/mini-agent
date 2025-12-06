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
 * Each codeblock in a response gets its own ID and lifecycle.
 */
import { Effect, Option, Schema } from "effect"

/** Branded type for request IDs - timestamps like "2025-12-04_15-30-00-123" */
export const RequestId = Schema.String.pipe(Schema.brand("RequestId"))
export type RequestId = typeof RequestId.Type

/** Branded type for codeblock IDs - sequential within a request ("1", "2", "3"...) */
export const CodeblockId = Schema.String.pipe(Schema.brand("CodeblockId"))
export type CodeblockId = typeof CodeblockId.Type

/** @deprecated Alias for RequestId for backwards compatibility */
export const ResponseId = RequestId
export type ResponseId = RequestId

/** Parsed codeblock with its ID */
export interface ParsedCodeBlock {
  readonly code: string
  readonly codeblockId: CodeblockId
}

/** Code block extracted from assistant response */
export class CodeBlockEvent extends Schema.TaggedClass<CodeBlockEvent>()("CodeBlock", {
  code: Schema.String,
  requestId: RequestId,
  codeblockId: CodeblockId,
  attempt: Schema.Number
}) {}

/** Typecheck started */
export class TypecheckStartEvent extends Schema.TaggedClass<TypecheckStartEvent>()("TypecheckStart", {
  requestId: RequestId,
  codeblockId: CodeblockId,
  attempt: Schema.Number
}) {}

/** Typecheck passed */
export class TypecheckPassEvent extends Schema.TaggedClass<TypecheckPassEvent>()("TypecheckPass", {
  requestId: RequestId,
  codeblockId: CodeblockId,
  attempt: Schema.Number
}) {}

/** Typecheck failed with errors */
export class TypecheckFailEvent extends Schema.TaggedClass<TypecheckFailEvent>()("TypecheckFail", {
  requestId: RequestId,
  codeblockId: CodeblockId,
  attempt: Schema.Number,
  errors: Schema.String
}) {}

/** Code execution started */
export class ExecutionStartEvent extends Schema.TaggedClass<ExecutionStartEvent>()("ExecutionStart", {
  requestId: RequestId,
  codeblockId: CodeblockId
}) {}

/** Streaming output from code execution */
export class ExecutionOutputEvent extends Schema.TaggedClass<ExecutionOutputEvent>()("ExecutionOutput", {
  requestId: RequestId,
  codeblockId: CodeblockId,
  stream: Schema.Literal("stdout", "stderr"),
  data: Schema.String
}) {}

/** Code execution completed */
export class ExecutionCompleteEvent extends Schema.TaggedClass<ExecutionCompleteEvent>()("ExecutionComplete", {
  requestId: RequestId,
  codeblockId: CodeblockId,
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
 * Parse ALL codemode blocks from text content.
 * Returns array of parsed blocks, each with its codeblock ID.
 */
export const parseCodeBlocks = (text: string): Effect.Effect<Array<ParsedCodeBlock>> =>
  Effect.sync(() => {
    const blocks: Array<ParsedCodeBlock> = []
    let searchStart = 0
    let blockIndex = 1

    while (true) {
      const startIdx = text.indexOf(CODEMODE_START, searchStart)
      if (startIdx === -1) break

      const afterStart = startIdx + CODEMODE_START.length
      const endIdx = text.indexOf(CODEMODE_END, afterStart)
      if (endIdx === -1) break

      const rawCode = text.slice(afterStart, endIdx)
      const code = stripMarkdownFences(rawCode)

      if (code.trim()) {
        blocks.push({
          code,
          codeblockId: makeCodeblockId(blockIndex)
        })
        blockIndex++
      }

      searchStart = endIdx + CODEMODE_END.length
    }

    return blocks
  })

/**
 * Parse first codemode block from text content.
 * Returns Option.some with the extracted code if markers are found.
 * @deprecated Use parseCodeBlocks for multiple block support
 */
export const parseCodeBlock = (text: string): Effect.Effect<Option.Option<string>> =>
  Effect.map(parseCodeBlocks(text), (blocks) => blocks.length > 0 ? Option.some(blocks[0]!.code) : Option.none())

/** Check if text contains codemode markers */
export const hasCodeBlock = (text: string): boolean => text.includes(CODEMODE_START) && text.includes(CODEMODE_END)

/** Count codemode blocks in text */
export const countCodeBlocks = (text: string): number => {
  let count = 0
  let searchStart = 0

  while (true) {
    const startIdx = text.indexOf(CODEMODE_START, searchStart)
    if (startIdx === -1) break

    const afterStart = startIdx + CODEMODE_START.length
    const endIdx = text.indexOf(CODEMODE_END, afterStart)
    if (endIdx === -1) break

    count++
    searchStart = endIdx + CODEMODE_END.length
  }

  return count
}

/** Generate a request ID from current timestamp with milliseconds for uniqueness */
export const generateRequestId = (): Effect.Effect<RequestId> =>
  Effect.sync(() => {
    const now = new Date()
    const pad = (n: number, len = 2) => n.toString().padStart(len, "0")
    const id = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${
      pad(now.getMinutes())
    }-${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`
    return id as RequestId
  })

/** @deprecated Use generateRequestId instead */
export const generateResponseId = generateRequestId

/** Generate a codeblock ID from a sequence number */
export const makeCodeblockId = (n: number): CodeblockId => String(n) as CodeblockId
