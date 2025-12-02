/**
 * Sentry Tracing Provider
 */
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import type { ConfigError } from "effect"
import { Config, Effect, Option, Redacted } from "effect"
import { FetchOtlpExporter } from "./exporter.js"
import type { ProviderConfig } from "./provider.js"

const SentryOtlpEndpoint = Config.option(Config.string("SENTRY_OTLP_ENDPOINT"))
const SentryPublicKey = Config.option(Config.redacted("SENTRY_PUBLIC_KEY"))
const SentryTeam = Config.string("SENTRY_TEAM").pipe(
  Config.withDefault("iterate-ec")
)

export const sentryProvider = (): Effect.Effect<Option.Option<ProviderConfig>, ConfigError.ConfigError> =>
  Effect.gen(function*() {
    const endpoint = yield* SentryOtlpEndpoint
    const key = yield* SentryPublicKey
    const team = yield* SentryTeam

    if (Option.isNone(endpoint) || Option.isNone(key)) return Option.none()

    console.log(`[Tracing] Sentry enabled → ${endpoint.value}`)

    return Option.some({
      name: "Sentry",
      processor: new BatchSpanProcessor(
        new FetchOtlpExporter({
          name: "Sentry",
          url: endpoint.value,
          headers: {
            "x-sentry-auth": `sentry sentry_key=${Redacted.value(key.value)}`
          }
        }),
        { scheduledDelayMillis: 100 }
      ),
      buildUrl: (traceId) => `https://${team}.sentry.io/explore/traces/trace/${traceId}/`
    })
  })
