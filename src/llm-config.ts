/**
 * LLM Configuration
 */
import { Config, Context, Effect, Layer, Redacted, Schema } from "effect"

export type ApiFormat = "openai-responses" | "anthropic" | "gemini"

export class LlmConfig extends Schema.Class<LlmConfig>("LlmConfig")({
  apiFormat: Schema.Literal("openai-responses", "anthropic", "gemini"),
  model: Schema.String,
  baseUrl: Schema.String,
  apiKeyEnvVar: Schema.String
}) {}

const openai = {
  apiFormat: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  apiKeyEnvVar: "OPENAI_API_KEY"
} as const

const anthropic = {
  apiFormat: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKeyEnvVar: "ANTHROPIC_API_KEY"
} as const

const gemini = {
  apiFormat: "gemini",
  baseUrl: "https://generativelanguage.googleapis.com",
  apiKeyEnvVar: "GEMINI_API_KEY"
} as const

const LLMS: Record<string, LlmConfig> = {
  "gpt-4.1-mini": new LlmConfig({ ...openai, model: "gpt-4.1-mini" }),
  "claude-haiku-4-5": new LlmConfig({ ...anthropic, model: "claude-3-5-haiku-20241022" }),
  "gemini-2.5-flash": new LlmConfig({ ...gemini, model: "gemini-2.0-flash" })
}

export const DEFAULT_LLM = "gpt-4.1-mini"

/** Get LlmConfig by name. Throws if not found. */
export const getLlmConfig = (name: string): LlmConfig => {
  const config = LLMS[name]
  if (!config) {
    const validLlms = Object.keys(LLMS).join(", ")
    throw new Error(`Unknown LLM: ${name}. Valid: ${validLlms}`)
  }
  return config
}

/** Get API key for an LlmConfig from environment */
export const getApiKey = (config: LlmConfig): Redacted.Redacted | undefined => {
  const apiKeyValue = process.env[config.apiKeyEnvVar]
  return apiKeyValue ? Redacted.make(apiKeyValue) : undefined
}

/** Resolve LLM config from Config. */
export const resolveLlmConfig = Effect.gen(function*() {
  const llmName = yield* Config.string("LLM").pipe(Config.withDefault(DEFAULT_LLM))
  return getLlmConfig(llmName)
})

/** Service to access the resolved LlmConfig */
export class CurrentLlmConfig extends Context.Tag("@app/CurrentLlmConfig")<
  CurrentLlmConfig,
  LlmConfig
>() {
  static fromConfig(config: LlmConfig): Layer.Layer<CurrentLlmConfig> {
    return Layer.succeed(CurrentLlmConfig, config)
  }
}
