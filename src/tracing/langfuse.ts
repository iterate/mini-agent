/**
 * Langfuse Tracing Provider (LLM Observability & Evaluation)
 */
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import type { ConfigError } from "effect"
import { Config, Effect, Option, Redacted } from "effect"
import { FetchOtlpExporter } from "./exporter.ts"
import type { ProviderConfig } from "./provider.ts"

const LangfusePublicKey = Config.option(Config.redacted("LANGFUSE_PUBLIC_KEY"))
const LangfuseSecretKey = Config.option(Config.redacted("LANGFUSE_SECRET_KEY"))
const LangfuseBaseUrl = Config.string("LANGFUSE_BASE_URL").pipe(
  Config.withDefault("https://cloud.langfuse.com")
)
const LangfuseProjectId = Config.option(Config.string("LANGFUSE_PROJECT_ID"))

export const langfuseProvider = (): Effect.Effect<Option.Option<ProviderConfig>, ConfigError.ConfigError> =>
  Effect.gen(function*() {
    const publicKey = yield* LangfusePublicKey
    const secretKey = yield* LangfuseSecretKey
    const projectId = yield* LangfuseProjectId

    if (Option.isNone(publicKey) || Option.isNone(secretKey)) return Option.none()

    const baseUrl = yield* LangfuseBaseUrl
    const url = `${baseUrl.replace(/\/$/, "")}/api/public/otel/v1/traces`

    // Langfuse uses Basic auth with publicKey:secretKey
    const authString = Buffer.from(
      `${Redacted.value(publicKey.value)}:${Redacted.value(secretKey.value)}`
    ).toString("base64")

    yield* Effect.logDebug(`Langfuse enabled → ${url}`)

    return Option.some({
      name: "Langfuse",
      processor: new BatchSpanProcessor(
        new FetchOtlpExporter({
          name: "Langfuse",
          url,
          headers: {
            "Authorization": `Basic ${authString}`
          }
        }),
        { scheduledDelayMillis: 100 }
      ),
      buildUrl: (traceId) => {
        const pid = Option.isSome(projectId) ? projectId.value : "your-project-id"
        const host = new URL(baseUrl).host
        return `https://${host}/project/${pid}/traces?peek=${traceId}`
      }
    })
  })
