/**
 * Shared CLI Options
 * 
 * Centralized option definitions to avoid duplication across command files
 */

import { Options } from "@effect/cli"
import { DEFAULT_SERVER_URL } from "../shared/config"

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
