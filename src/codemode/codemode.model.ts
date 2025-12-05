/**
 * Codemode Event Model
 *
 * Defines the event emitted when a codemode block is executed.
 * Each <codemode> block in an assistant message becomes its own event.
 */
import { Schema } from "effect"
import type { LLMMessage } from "../context.model.ts"

/** Schema for triggerAgentTurn field */
const TriggerAgentTurnSchema = Schema.Literal("after-current-turn", "never")

/** Event for a single executed codemode block */
export class CodemodeBlockEvent extends Schema.TaggedClass<CodemodeBlockEvent>()("CodemodeBlock", {
  /** The source code of the block (as written by LLM, without wrapper) */
  code: Schema.String,
  /** Block index within the assistant response (1-indexed) */
  blockNumber: Schema.Number,
  /** Which assistant response this came from (1-indexed) */
  responseNumber: Schema.Number,
  /** Output visible to user (from sendMessage via stderr) */
  userOutput: Schema.String,
  /** Output visible to agent (from console.log via stdout) - triggers continuation */
  agentOutput: Schema.String,
  /** Whether this block triggers another agent turn */
  triggerAgentTurn: TriggerAgentTurnSchema
}) {
  toLLMMessage(): LLMMessage {
    return { role: "user", content: this.agentOutput }
  }
}
