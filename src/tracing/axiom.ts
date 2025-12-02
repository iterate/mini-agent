/**
 * Axiom Tracing Provider
 */
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import type { ConfigError } from "effect"
import { Config, Effect, Option, Redacted } from "effect"
import { FetchOtlpExporter } from "./exporter.js"
import type { ProviderConfig } from "./provider.js"

const AxiomApiKey = Config.option(Config.redacted("AXIOM_API_KEY"))
const AxiomDataset = Config.string("AXIOM_DATASET").pipe(
  Config.withDefault("traces")
)
const AxiomEndpoint = Config.string("AXIOM_ENDPOINT").pipe(
  Config.withDefault("https://eu-central-1.aws.edge.axiom.co")
)
const AxiomOrg = Config.option(Config.string("AXIOM_ORG"))

export const axiomProvider = (): Effect.Effect<Option.Option<ProviderConfig>, ConfigError.ConfigError> =>
  Effect.gen(function*() {
    const key = yield* AxiomApiKey
    if (Option.isNone(key)) return Option.none()

    const dataset = yield* AxiomDataset
    const endpoint = yield* AxiomEndpoint
    const axiomOrg = yield* AxiomOrg
    const url = `${endpoint}/v1/traces`

    console.log(`[Tracing] Axiom enabled → ${url}`)

    return Option.some({
      name: "Axiom",
      processor: new BatchSpanProcessor(
        new FetchOtlpExporter({
          name: "Axiom",
          url,
          headers: {
            "Authorization": `Bearer ${Redacted.value(key.value)}`,
            "X-Axiom-Dataset": dataset
          }
        }),
        { scheduledDelayMillis: 100 }
      ),
      ...(Option.isSome(axiomOrg)
        ? {
          buildUrl: (traceId: string) =>
            `https://app.axiom.co/${axiomOrg.value}/stream/${dataset}?traceId=${traceId}&traceDataset=${dataset}`
        }
        : {})
    })
  })
