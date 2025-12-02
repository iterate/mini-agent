/**
 * Honeycomb Tracing Provider
 */
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import type { ConfigError } from "effect"
import { Config, Effect, Option, Redacted } from "effect"
import { FetchOtlpExporter } from "./exporter.js"
import type { ProviderConfig } from "./provider.js"

const HoneycombApiKey = Config.option(Config.redacted("HONEYCOMB_API_KEY"))
const HoneycombEndpoint = Config.string("HONEYCOMB_ENDPOINT").pipe(
  Config.withDefault("https://api.honeycomb.io")
)
const HoneycombTeam = Config.string("HONEYCOMB_TEAM").pipe(
  Config.withDefault("iterate")
)
const HoneycombEnvironment = Config.string("HONEYCOMB_ENVIRONMENT").pipe(
  Config.withDefault("test")
)

export const honeycombProvider = (
  serviceName: string
): Effect.Effect<Option.Option<ProviderConfig>, ConfigError.ConfigError> =>
  Effect.gen(function*() {
    const key = yield* HoneycombApiKey
    if (Option.isNone(key)) return Option.none()

    const endpoint = yield* HoneycombEndpoint
    const team = yield* HoneycombTeam
    const env = yield* HoneycombEnvironment
    const url = `${endpoint}/v1/traces`

    console.log(`[Tracing] Honeycomb enabled → ${url}`)

    return Option.some({
      name: "Honeycomb",
      processor: new BatchSpanProcessor(
        new FetchOtlpExporter({
          name: "Honeycomb",
          url,
          headers: { "x-honeycomb-team": Redacted.value(key.value) }
        }),
        { scheduledDelayMillis: 100 }
      ),
      buildUrl: (traceId) =>
        `https://ui.honeycomb.io/${team}/environments/${env}/datasets/${serviceName}/trace?trace_id=${traceId}`
    })
  })
