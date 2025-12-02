/**
 * Tracing Provider Types
 *
 * Common types and helpers for telemetry providers.
 */
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base"
import type { ConfigError, Effect, Option } from "effect"

/** Function that builds a trace URL from a trace ID */
export type TraceUrlBuilder = (traceId: string) => string

/** Configuration for an active tracing provider */
export interface ProviderConfig {
  readonly name: string
  readonly processor: SpanProcessor
  readonly buildUrl?: TraceUrlBuilder
}

/** Provider that is active and has a URL builder */
export interface ActiveProvider {
  readonly name: string
  readonly buildUrl: TraceUrlBuilder
}

/** Effect that optionally returns a provider config */
export type ProviderEffect = Effect.Effect<Option.Option<ProviderConfig>, ConfigError.ConfigError, never>
