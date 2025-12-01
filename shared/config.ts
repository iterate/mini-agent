/**
 * Shared Configuration
 * 
 * Centralized configuration accessors for CLI and server.
 * Uses Effect Config for type-safe, validated configuration.
 */

import { Config } from "effect"

// =============================================================================
// Server Configuration
// =============================================================================

/** Server port (default: 3000) */
export const ServerPort = Config.integer("PORT").pipe(Config.withDefault(3000))

/** Default server RPC URL */
export const DEFAULT_SERVER_URL = "http://localhost:3000/rpc"

// =============================================================================
// OpenAI Configuration
// =============================================================================

/** OpenAI API key (redacted for security) */
export const OpenAiApiKey = Config.redacted("OPENAI_API_KEY")

/** OpenAI API key as optional (for graceful degradation) */
export const OpenAiApiKeyOption = Config.option(OpenAiApiKey)

/** OpenAI model name (default: gpt-4.1) */
export const OpenAiModel = Config.string("OPENAI_MODEL").pipe(
  Config.withDefault("gpt-4.1")
)

/** OpenAI temperature (default: 0.7) */
export const OpenAiTemperature = Config.number("OPENAI_TEMPERATURE").pipe(
  Config.withDefault(0.7)
)

