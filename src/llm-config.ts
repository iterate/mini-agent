/**
 * LLM Configuration
 *
 * Supports three ways to specify an LLM:
 * 1. Named presets: "gpt-4.1-mini", "claude-haiku-4-5", etc.
 * 2. Provider prefix: "openrouter:anthropic/claude-3.5-sonnet", "groq:llama-3.3-70b-versatile"
 * 3. JSON config: '{"apiFormat":"openai-responses","model":"...","baseUrl":"...","apiKeyEnvVar":"..."}'
 */
import { Config, Context, Effect, Layer, Redacted, Schema } from "effect"

export type ApiFormat = "openai-responses" | "anthropic" | "gemini"

export class LlmConfig extends Schema.Class<LlmConfig>("LlmConfig")({
  apiFormat: Schema.Literal("openai-responses", "anthropic", "gemini"),
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
  apiFormat: "openai-responses",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKeyEnvVar: "OPENROUTER_API_KEY"
}

const cerebras: ProviderPreset = {
  apiFormat: "openai-responses",
  baseUrl: "https://api.cerebras.ai/v1",
  apiKeyEnvVar: "CEREBRAS_API_KEY"
}

const groq: ProviderPreset = {
  apiFormat: "openai-responses",
  baseUrl: "https://api.groq.com/openai/v1",
  apiKeyEnvVar: "GROQ_API_KEY"
}

/** Provider prefix mapping for dynamic model resolution */
const PROVIDER_PREFIXES: Record<string, ProviderPreset> = {
  openrouter,
  cerebras,
  groq
}

/** Named model presets */
const LLMS: Record<string, LlmConfig> = {
  // OpenAI
  "gpt-4.1-mini": new LlmConfig({ ...openai, model: "gpt-4.1-mini" }),
  "gpt-4.1": new LlmConfig({ ...openai, model: "gpt-4.1" }),

  // Anthropic
  "claude-haiku-4-5": new LlmConfig({ ...anthropic, model: "claude-haiku-4-5" }),
  "claude-sonnet-4": new LlmConfig({ ...anthropic, model: "claude-sonnet-4-20250514" }),

  // Google
  "gemini-2.5-flash": new LlmConfig({ ...gemini, model: "gemini-2.5-flash" }),

  // OpenRouter shortcuts
  "openrouter-claude-sonnet": new LlmConfig({ ...openrouter, model: "anthropic/claude-sonnet-4" }),
  "openrouter-gpt-4o": new LlmConfig({ ...openrouter, model: "openai/gpt-4o" }),
  "openrouter-llama-70b": new LlmConfig({ ...openrouter, model: "meta-llama/llama-3.3-70b-instruct" }),

  // Cerebras shortcuts (ultra-fast inference)
  "cerebras-llama-70b": new LlmConfig({ ...cerebras, model: "llama-3.3-70b" }),
  "cerebras-llama-8b": new LlmConfig({ ...cerebras, model: "llama-3.1-8b" }),
  "cerebras-qwen-32b": new LlmConfig({ ...cerebras, model: "qwen-3-32b" }),

  // Groq shortcuts (fast inference)
  "groq-llama-70b": new LlmConfig({ ...groq, model: "llama-3.3-70b-versatile" }),
  "groq-llama-8b": new LlmConfig({ ...groq, model: "llama-3.1-8b-instant" })
}

export const DEFAULT_LLM = "gpt-4.1-mini"

/**
 * Get LlmConfig by name, prefix, or JSON.
 *
 * Supports:
 * - Named presets: "gpt-4.1-mini"
 * - Provider prefix: "openrouter:anthropic/claude-3.5-sonnet"
 * - JSON config: '{"apiFormat":"openai-responses",...}'
 */
export const getLlmConfig = (name: string): LlmConfig => {
  // Check named presets first
  const config = LLMS[name]
  if (config) return config

  // Check for provider prefix (e.g., "openrouter:model-name")
  const colonIndex = name.indexOf(":")
  if (colonIndex > 0) {
    const prefix = name.slice(0, colonIndex)
    const modelName = name.slice(colonIndex + 1)

    // Check if it's a JSON config (starts with "{")
    if (prefix === "" || modelName.startsWith("{")) {
      // Not a provider prefix, fall through to JSON parsing
    } else {
      const provider = PROVIDER_PREFIXES[prefix]
      if (provider) {
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

  const validLlms = Object.keys(LLMS).join(", ")
  const validPrefixes = Object.keys(PROVIDER_PREFIXES).join(", ")
  throw new Error(
    `Unknown LLM: ${name}\n` +
      `Valid presets: ${validLlms}\n` +
      `Valid prefixes: ${validPrefixes}:<model-name>`
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
