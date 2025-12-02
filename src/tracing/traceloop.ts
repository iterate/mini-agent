/**
 * Traceloop Tracing Provider (LLM Observability)
 */
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Config, ConfigError, Effect, Option, Redacted } from "effect"
import { FetchOtlpExporter } from "./exporter.js"
import type { ProviderConfig } from "./provider.js"

const TraceloopApiKey = Config.option(Config.redacted("TRACELOOP_API_KEY"))
const TraceloopEndpoint = Config.string("TRACELOOP_ENDPOINT").pipe(
  Config.withDefault("https://api.traceloop.com")
)
const TraceloopProjectSlug = Config.string("TRACELOOP_PROJECT_SLUG").pipe(
  Config.withDefault("default")
)

export const traceloopProvider = (): Effect.Effect<Option.Option<ProviderConfig>, ConfigError.ConfigError> =>
  Effect.gen(function*() {
    const key = yield* TraceloopApiKey
    if (Option.isNone(key)) return Option.none()

    const endpoint = yield* TraceloopEndpoint
    const projectSlug = yield* TraceloopProjectSlug
    const url = `${endpoint}/v1/traces`

    console.log(`[Tracing] Traceloop enabled → ${url}`)

    return Option.some({
      name: "Traceloop",
      processor: new BatchSpanProcessor(
        new FetchOtlpExporter({
          name: "Traceloop",
          url,
          headers: {
            "Authorization": `Bearer ${Redacted.value(key.value)}`
          }
        }),
        { scheduledDelayMillis: 100 }
      ),
      buildUrl: (traceId) =>
        `https://app.traceloop.com/projects/${projectSlug}/trace/${traceId}`
    })
  })

