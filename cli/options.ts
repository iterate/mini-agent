/**
 * Shared CLI Options
 * 
 * Centralized option definitions to avoid duplication across command files
 */

import { Options } from "@effect/cli"
import { DEFAULT_SERVER_URL } from "./client"

// =============================================================================
// Server Connection Options
// =============================================================================

/**
 * Server URL option - use in any command that calls the RPC server
 */
export const serverUrlOption = Options.text("server-url").pipe(
  Options.withAlias("u"),
  Options.withDescription("Server RPC endpoint URL"),
  Options.withDefault(DEFAULT_SERVER_URL)
)

// =============================================================================
// Common Behavior Options
// =============================================================================

/**
 * JSON output option - for machine-readable output
 */
export const jsonOutputOption = Options.boolean("json").pipe(
  Options.withAlias("j"),
  Options.withDescription("Output as JSON"),
  Options.withDefault(false)
)

/**
 * Verbose option - for debugging
 */
export const verboseOption = Options.boolean("verbose").pipe(
  Options.withAlias("v"),
  Options.withDescription("Verbose output"),
  Options.withDefault(false)
)

// =============================================================================
// Server Management Options
// =============================================================================

/**
 * Daemonize option - run server in background
 */
export const daemonizeOption = Options.boolean("daemonize").pipe(
  Options.withAlias("d"),
  Options.withDescription("Run in background"),
  Options.withDefault(false)
)

