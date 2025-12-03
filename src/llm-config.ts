/**
 * LLM Configuration
 *
 * Supports two modes:
 * 1. Lookup: "openai:gpt-4o-mini" → looks up provider in registry, uses model
 * 2. JSON: Full config object for custom setups
 */
import { Config, Effect, Redacted, Schema } from "effect"

export type ApiFormat = "openai-responses" | "anthropic" | "gemini"

/** LLM configuration. Future: may add temperature, headers, extra params */
export class LlmConfig extends Schema.Class<LlmConfig>("LlmConfig")({
  apiFormat: Schema.Literal("openai-responses", "anthropic", "gemini"),
  model: Schema.String,
  baseUrl: Schema.String,
  apiKeyEnvVar: Schema.String
}) {}

export interface ResolvedLlmConfig {
  readonly apiFormat: ApiFormat
  readonly model: string
  readonly baseUrl: string
  readonly apiKeyEnvVar: string
  readonly apiKey: Redacted.Redacted | undefined
}

interface ProviderEntry {
  readonly apiFormat: ApiFormat
  readonly baseUrl: string
  readonly apiKeyEnvVar: string
}

const PROVIDERS: Record<string, ProviderEntry> = {
  openai: {
    apiFormat: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnvVar: "OPENAI_API_KEY"
  },
  anthropic: {
    apiFormat: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnvVar: "ANTHROPIC_API_KEY"
  },
  gemini: {
    apiFormat: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKeyEnvVar: "GEMINI_API_KEY"
  },
  openrouter: {
    apiFormat: "openai-responses",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnvVar: "OPENROUTER_API_KEY"
  },
  cerebras: {
    apiFormat: "openai-responses",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKeyEnvVar: "CEREBRAS_API_KEY"
  },
  groq: {
    apiFormat: "openai-responses",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnvVar: "GROQ_API_KEY"
  }
}

/** Parse "provider:model" into config, or parse JSON object directly */
export const parseLlmString = (input: string): LlmConfig => {
  // Try JSON parse first
  try {
    const parsed = JSON.parse(input) as unknown
    if (typeof parsed === "object" && parsed !== null) {
      return Schema.decodeUnknownSync(LlmConfig)(parsed)
    }
  } catch {
    // Not JSON, continue to lookup
  }

  // Parse as "provider:model" or just "model" (defaults to openai)
  const colonIdx = input.indexOf(":")
  const provider = colonIdx === -1 ? "openai" : input.slice(0, colonIdx)
  const model = colonIdx === -1 ? input : input.slice(colonIdx + 1)

  const entry = PROVIDERS[provider]
  if (!entry) {
    const validProviders = Object.keys(PROVIDERS).join(", ")
    throw new Error(`Unknown provider: ${provider}. Valid: ${validProviders}`)
  }

  return new LlmConfig({
    apiFormat: entry.apiFormat,
    model,
    baseUrl: entry.baseUrl,
    apiKeyEnvVar: entry.apiKeyEnvVar
  })
}

/** Resolve LLM config from env. API key is loaded but not validated here. */
export const resolveLlmConfig = Effect.gen(function*() {
  const llmString = yield* Config.string("LLM").pipe(Config.withDefault("openai:gpt-4o-mini"))
  const config = parseLlmString(llmString)

  const apiKeyValue = process.env[config.apiKeyEnvVar]

  return {
    apiFormat: config.apiFormat,
    model: config.model,
    baseUrl: config.baseUrl,
    apiKeyEnvVar: config.apiKeyEnvVar,
    apiKey: apiKeyValue ? Redacted.make(apiKeyValue) : undefined
  } satisfies ResolvedLlmConfig
})
