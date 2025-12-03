/**
 * LLM Configuration Module
 *
 * Provides multi-provider LLM configuration with shorthand strings.
 * Supports: OpenAI, Anthropic, Google Gemini, AWS Bedrock, OpenRouter, and more.
 */
import type { Redacted } from "effect"
import { Config, Effect, Option } from "effect"

// =============================================================================
// Types
// =============================================================================

export type ApiFormat = "openai-responses" | "anthropic" | "gemini" | "bedrock"

export interface ProviderConfig {
  readonly apiFormat: ApiFormat
  readonly baseUrl: string
  readonly apiKeyEnvVar: string // empty for bedrock (uses AWS credentials)
}

export interface ResolvedLlmConfig {
  readonly apiFormat: ApiFormat
  readonly model: string
  readonly baseUrl: string
  readonly temperature: number | undefined
  readonly maxTokens: number | undefined
  // API key auth (for most providers)
  readonly apiKey?: Redacted.Redacted | undefined
  // AWS auth (for bedrock only)
  readonly awsAccessKeyId?: string | undefined
  readonly awsSecretAccessKey?: Redacted.Redacted | undefined
  readonly awsSessionToken?: Redacted.Redacted | undefined
}

// =============================================================================
// Provider Registry
// =============================================================================

export const PROVIDER_REGISTRY: Record<string, ProviderConfig> = {
  // Native providers - use their @effect/ai packages directly
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
    apiKeyEnvVar: "GOOGLE_API_KEY"
  },
  bedrock: {
    apiFormat: "bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    apiKeyEnvVar: "" // Uses AWS credentials, not API key
  },

  // OpenAI-compatible providers (use @effect/ai-openai with custom URL)
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
  },
  together: {
    apiFormat: "openai-responses",
    baseUrl: "https://api.together.xyz/v1",
    apiKeyEnvVar: "TOGETHER_API_KEY"
  }
}

// =============================================================================
// Parsing
// =============================================================================

/**
 * Parse a DEFAULT_LLM string into provider and model.
 * Examples:
 *   "openai:gpt-4o-mini" → { provider: "openai", model: "gpt-4o-mini" }
 *   "openrouter:openai/gpt-4o" → { provider: "openrouter", model: "openai/gpt-4o" }
 *   "gpt-4o-mini" → { provider: "openai", model: "gpt-4o-mini" }
 */
export const parseDefaultLlm = (input: string): { provider: string; model: string } => {
  const firstColon = input.indexOf(":")
  if (firstColon === -1) {
    return { provider: "openai", model: input }
  }
  return {
    provider: input.slice(0, firstColon),
    model: input.slice(firstColon + 1)
  }
}

/**
 * Parse API format string into ApiFormat type.
 */
export const parseApiFormat = (input: string): ApiFormat => {
  const normalized = input.toLowerCase().replace(/-/g, "")
  switch (normalized) {
    case "openairesponses":
    case "openai":
      return "openai-responses"
    case "anthropic":
      return "anthropic"
    case "gemini":
    case "google":
      return "gemini"
    case "bedrock":
    case "amazonbedrock":
    case "awsbedrock":
      return "bedrock"
    default:
      return "openai-responses"
  }
}

// =============================================================================
// Config Resolution
// =============================================================================

/**
 * Resolve the complete LLM configuration from environment variables.
 *
 * Config sources (in priority order):
 * 1. DEFAULT_LLM_* override env vars
 * 2. Provider registry defaults based on DEFAULT_LLM shorthand
 * 3. Provider-specific API key env vars (e.g., OPENAI_API_KEY)
 */
export const resolveLlmConfig = Effect.gen(function*() {
  // Parse the shorthand DEFAULT_LLM string
  const defaultLlm = yield* Config.string("DEFAULT_LLM").pipe(
    Config.withDefault("openai:gpt-4o-mini")
  )
  const { model: parsedModel, provider } = parseDefaultLlm(defaultLlm)

  // Look up provider in registry
  const providerConfig = PROVIDER_REGISTRY[provider]
  if (!providerConfig) {
    return yield* Effect.fail(
      new Error(`Unknown provider: ${provider}. Valid providers: ${Object.keys(PROVIDER_REGISTRY).join(", ")}`)
    )
  }

  // Apply overrides
  const baseUrlOverride = yield* Config.option(Config.string("DEFAULT_LLM_BASE_URL"))
  const apiFormatOverride = yield* Config.option(Config.string("DEFAULT_LLM_API_FORMAT"))
  const temperatureOverride = yield* Config.option(Config.number("DEFAULT_LLM_TEMPERATURE"))
  const maxTokensOverride = yield* Config.option(Config.number("DEFAULT_LLM_MAX_TOKENS"))

  const baseUrl = Option.getOrElse(baseUrlOverride, () => providerConfig.baseUrl)
  const apiFormat = Option.match(apiFormatOverride, {
    onNone: () => providerConfig.apiFormat,
    onSome: parseApiFormat
  })
  const temperature = Option.getOrUndefined(temperatureOverride)
  const maxTokens = Option.getOrUndefined(maxTokensOverride)
  const model = parsedModel

  // Handle auth based on provider type
  if (apiFormat === "bedrock") {
    // Bedrock uses AWS credentials - make optional so --help works
    const accessKeyId = yield* Config.option(Config.string("AWS_ACCESS_KEY_ID"))
    const secretAccessKey = yield* Config.option(Config.redacted("AWS_SECRET_ACCESS_KEY"))
    const sessionToken = yield* Config.option(Config.redacted("AWS_SESSION_TOKEN"))

    return {
      apiFormat,
      model,
      baseUrl,
      temperature,
      maxTokens,
      awsAccessKeyId: Option.getOrUndefined(accessKeyId),
      awsSecretAccessKey: Option.getOrUndefined(secretAccessKey),
      awsSessionToken: Option.getOrUndefined(sessionToken)
    } satisfies ResolvedLlmConfig
  }

  // Standard API key auth for other providers - make optional so --help works
  const apiKeyOverride = yield* Config.option(Config.redacted("DEFAULT_LLM_API_KEY"))
  const apiKey = yield* Option.match(apiKeyOverride, {
    onSome: (key) => Effect.succeed(Option.some(key)),
    onNone: () => {
      if (!providerConfig.apiKeyEnvVar) {
        return Effect.succeed(Option.none())
      }
      return Config.option(Config.redacted(providerConfig.apiKeyEnvVar))
    }
  })

  return {
    apiFormat,
    model,
    baseUrl,
    temperature,
    maxTokens,
    apiKey: Option.getOrUndefined(apiKey)
  } satisfies ResolvedLlmConfig
})

export type ResolveLlmConfigError = Effect.Effect.Error<typeof resolveLlmConfig>
