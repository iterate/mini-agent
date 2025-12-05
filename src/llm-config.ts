/**
 * LLM Configuration
 *
 * Supports two ways to specify an LLM:
 * 1. Provider prefix: "openai:gpt-4.1-mini", "groq:llama-3.3-70b-versatile"
 * 2. JSON config: '{"apiFormat":"openai-responses","model":"...","baseUrl":"...","apiKeyEnvVar":"..."}'
 */
import { Config, Context, Effect, Layer, Redacted, Schema } from "effect"

export type ApiFormat = "openai-responses" | "openai-chat-completions" | "anthropic" | "gemini"

export class LlmConfig extends Schema.Class<LlmConfig>("LlmConfig")({
  apiFormat: Schema.Literal("openai-responses", "openai-chat-completions", "anthropic", "gemini"),
  model: Schema.String,
  baseUrl: Schema.String,
  apiKeyEnvVar: Schema.String
}) {}

/** Provider presets define common provider configurations */
interface ProviderPreset {
  readonly apiFormat: ApiFormat
  readonly baseUrl: string
  readonly apiKeyEnvVar: string
}

const openai: ProviderPreset = {
  apiFormat: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  apiKeyEnvVar: "OPENAI_API_KEY"
}

const anthropic: ProviderPreset = {
  apiFormat: "anthropic",
  baseUrl: "https://api.anthropic.com",
  apiKeyEnvVar: "ANTHROPIC_API_KEY"
}

const gemini: ProviderPreset = {
  apiFormat: "gemini",
  baseUrl: "https://generativelanguage.googleapis.com",
  apiKeyEnvVar: "GEMINI_API_KEY"
}

const openrouter: ProviderPreset = {
  apiFormat: "openai-chat-completions",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKeyEnvVar: "OPENROUTER_API_KEY"
}

const cerebras: ProviderPreset = {
  apiFormat: "openai-chat-completions",
  baseUrl: "https://api.cerebras.ai/v1",
  apiKeyEnvVar: "CEREBRAS_API_KEY"
}

const groq: ProviderPreset = {
  apiFormat: "openai-chat-completions",
  baseUrl: "https://api.groq.com/openai/v1",
  apiKeyEnvVar: "GROQ_API_KEY"
}

/** Provider prefix mapping for dynamic model resolution */
const PROVIDER_PREFIXES: Record<string, ProviderPreset> = {
  openai,
  anthropic,
  gemini,
  openrouter,
  cerebras,
  groq
}

export const DEFAULT_LLM = "openai:gpt-4.1-mini"

/**
 * Get LlmConfig by prefix or JSON.
 *
 * Supports:
 * - Provider prefix: "openai:gpt-4.1-mini", "openrouter:anthropic/claude-3.5-sonnet"
 * - JSON config: '{"apiFormat":"openai-responses",...}'
 */
export const getLlmConfig = (name: string): LlmConfig => {
  // Check for provider prefix (e.g., "openrouter:model-name")
  const colonIndex = name.indexOf(":")
  if (colonIndex > 0) {
    const prefix = name.slice(0, colonIndex)
    const modelName = name.slice(colonIndex + 1)

    // Check if it's a JSON config (starts with "{")
    if (prefix !== "" && !modelName.startsWith("{")) {
      const provider = PROVIDER_PREFIXES[prefix]
      if (provider) {
        if (!modelName) {
          throw new Error(`Missing model name for provider '${prefix}'. Use: ${prefix}:<model-name>`)
        }
        return new LlmConfig({ ...provider, model: modelName })
      }
    }
  }

  // Try parsing as JSON config
  if (name.startsWith("{")) {
    try {
      const parsed = JSON.parse(name)
      return new LlmConfig(parsed)
    } catch {
      throw new Error(`Invalid JSON LLM config: ${name}`)
    }
  }

  const validPrefixes = Object.keys(PROVIDER_PREFIXES).join(", ")
  throw new Error(
    `Invalid LLM: ${name}\n` +
      `Use prefix syntax: ${validPrefixes}:<model-name>\n` +
      `Example: openai:gpt-4.1-mini, anthropic:claude-sonnet-4-20250514`
  )
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
