import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api"
import { BatchSpanProcessor, type SpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base"
import { ExportResultCode, type ExportResult } from "@opentelemetry/core"
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer"
import {
  Config,
  Console,
  Context,
  Effect,
  Layer,
  Option,
  Redacted,
} from "effect"

// =============================================================================
// withTraceLinks - prints observability links when CLI command starts
// =============================================================================

/** Wrapper that prints trace URLs at the start of a command */
export const withTraceLinks = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R | TraceLinks> =>
  Effect.gen(function* () {
    const traceLinks = yield* TraceLinks
    const currentSpan = yield* Effect.currentSpan.pipe(Effect.option)

    if (Option.isSome(currentSpan)) {
      yield* traceLinks.printLinks(currentSpan.value.traceId)
    }

    return yield* effect
  })

// =============================================================================
// OpenTelemetry Diagnostic Logging
// =============================================================================

// Enable OpenTelemetry diagnostic logging to see export errors
// Set OTEL_LOG_LEVEL=debug for verbose output, or error for only errors
// Default to ERROR level so we always see export failures
const otelLogLevel = process.env.OTEL_LOG_LEVEL?.toLowerCase() ?? "error"
const diagLevel = otelLogLevel === "debug" ? DiagLogLevel.DEBUG
  : otelLogLevel === "info" ? DiagLogLevel.INFO
  : otelLogLevel === "warn" ? DiagLogLevel.WARN
  : otelLogLevel === "error" ? DiagLogLevel.ERROR
  : otelLogLevel === "verbose" ? DiagLogLevel.VERBOSE
  : otelLogLevel === "none" ? DiagLogLevel.NONE
  : DiagLogLevel.ERROR
if (diagLevel !== DiagLogLevel.NONE) {
  diag.setLogger(new DiagConsoleLogger(), diagLevel)
}

// =============================================================================
// Configuration
// =============================================================================

const ServiceVersion = Config.string("SERVICE_VERSION").pipe(
  Config.withDefault("1.0.0")
)

// Provider-specific configs (all optional)
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

const AxiomApiKey = Config.option(Config.redacted("AXIOM_API_KEY"))
const AxiomDataset = Config.string("AXIOM_DATASET").pipe(
  Config.withDefault("traces")
)
const AxiomEndpoint = Config.string("AXIOM_ENDPOINT").pipe(
  Config.withDefault("https://eu-central-1.aws.edge.axiom.co")
)
const AxiomOrg = Config.option(Config.string("AXIOM_ORG"))

// Sentry - uses OTLP endpoint from project settings
const SentryOtlpEndpoint = Config.option(Config.string("SENTRY_OTLP_ENDPOINT"))
const SentryPublicKey = Config.option(Config.redacted("SENTRY_PUBLIC_KEY"))
const SentryTeam = Config.string("SENTRY_TEAM").pipe(
  Config.withDefault("iterate-ec")
)

// Traceloop - LLM observability platform
const TraceloopApiKey = Config.option(Config.redacted("TRACELOOP_API_KEY"))
const TraceloopEndpoint = Config.string("TRACELOOP_ENDPOINT").pipe(
  Config.withDefault("https://api.traceloop.com")
)

// Langfuse - LLM observability & evaluation
// Uses standard Langfuse env var names from dashboard
const LangfusePublicKey = Config.option(Config.redacted("LANGFUSE_PUBLIC_KEY"))
const LangfuseSecretKey = Config.option(Config.redacted("LANGFUSE_SECRET_KEY"))
const LangfuseBaseUrl = Config.string("LANGFUSE_BASE_URL").pipe(
  Config.withDefault("https://cloud.langfuse.com")
)
const LangfuseProject = Config.option(Config.string("LANGFUSE_PROJECT"))

// =============================================================================
// Trace Links Service
// =============================================================================

type TraceUrlBuilder = (traceId: string) => string

interface ActiveProvider {
  readonly name: string
  readonly buildUrl: TraceUrlBuilder
}

export class TraceLinks extends Context.Tag("TraceLinks")<
  TraceLinks,
  {
    readonly providers: ReadonlyArray<ActiveProvider>
    readonly printLinks: (traceId: string) => Effect.Effect<void>
  }
>() {}

// =============================================================================
// Custom Fetch-based OTLP Exporter (Bun-compatible, better error logging)
// =============================================================================

interface FetchExporterOptions {
  name: string
  url: string
  headers: Record<string, string>
}

class FetchOtlpExporter implements SpanExporter {
  private readonly name: string
  private readonly url: string
  private readonly headers: Record<string, string>
  private readonly serializer = JsonTraceSerializer

  constructor(options: FetchExporterOptions) {
    this.name = options.name
    this.url = options.url
    this.headers = {
      ...options.headers,
      "Content-Type": "application/json"
    }
    diag.info(`[${this.name}] Configured exporter → ${this.url}`)
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const body = this.serializer.serializeRequest(spans)
    if (!body) {
      diag.error(`[${this.name}] Failed to serialize ${spans.length} spans`)
      resultCallback({ code: ExportResultCode.FAILED })
      return
    }

    fetch(this.url, {
      method: "POST",
      headers: this.headers,
      body
    })
      .then(async (response) => {
        if (response.ok) {
          diag.debug(`[${this.name}] Successfully exported ${spans.length} spans`)
          resultCallback({ code: ExportResultCode.SUCCESS })
        } else {
          const text = await response.text().catch(() => "(no body)")
          console.error(`[${this.name}] Export failed: HTTP ${response.status} - ${text}`)
          diag.error(`[${this.name}] Export failed: HTTP ${response.status} - ${text}`)
          resultCallback({ code: ExportResultCode.FAILED })
        }
      })
      .catch((error) => {
        console.error(`[${this.name}] Export error:`, error)
        diag.error(`[${this.name}] Export error: ${error}`)
        resultCallback({ code: ExportResultCode.FAILED })
      })
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }
}

// =============================================================================
// Build SpanProcessors for each configured provider
// =============================================================================

interface ProviderConfig {
  readonly name: string
  readonly processor: SpanProcessor
  readonly buildUrl?: TraceUrlBuilder
}

const makeSpanProcessors = (serviceName: string) => Effect.gen(function* () {
  const processors: Array<ProviderConfig> = []

  // Honeycomb
  const honeycombKey = yield* HoneycombApiKey
  if (Option.isSome(honeycombKey)) {
    const endpoint = yield* HoneycombEndpoint
    const team = yield* HoneycombTeam
    const env = yield* HoneycombEnvironment
    const url = `${endpoint}/v1/traces`
    console.log(`[Tracing] Honeycomb enabled → ${url}`)
    processors.push({
      name: "Honeycomb",
      processor: new BatchSpanProcessor(
        new FetchOtlpExporter({
          name: "Honeycomb",
          url,
          headers: { "x-honeycomb-team": Redacted.value(honeycombKey.value) }
        }),
        { scheduledDelayMillis: 100 }
      ),
      buildUrl: (traceId) =>
        `https://ui.honeycomb.io/${team}/environments/${env}/datasets/${serviceName}/trace?trace_id=${traceId}`
    })
  }

  // Axiom
  const axiomKey = yield* AxiomApiKey
  if (Option.isSome(axiomKey)) {
    const dataset = yield* AxiomDataset
    const endpoint = yield* AxiomEndpoint
    const axiomOrg = yield* AxiomOrg
    const url = `${endpoint}/v1/traces`
    console.log(`[Tracing] Axiom enabled → ${url}`)
    processors.push({
      name: "Axiom",
      processor: new BatchSpanProcessor(
        new FetchOtlpExporter({
          name: "Axiom",
          url,
          headers: {
            "Authorization": `Bearer ${Redacted.value(axiomKey.value)}`,
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
  }

  // Sentry - OTLP endpoint from project settings
  const sentryEndpoint = yield* SentryOtlpEndpoint
  const sentryKey = yield* SentryPublicKey
  const sentryTeam = yield* SentryTeam
  if (Option.isSome(sentryEndpoint) && Option.isSome(sentryKey)) {
    console.log(`[Tracing] Sentry enabled → ${sentryEndpoint.value}`)
    processors.push({
      name: "Sentry",
      processor: new BatchSpanProcessor(
        new FetchOtlpExporter({
          name: "Sentry",
          url: sentryEndpoint.value,
          headers: {
            "x-sentry-auth": `sentry sentry_key=${Redacted.value(sentryKey.value)}`
          }
        }),
        { scheduledDelayMillis: 100 }
      ),
      buildUrl: (traceId) =>
        `https://${sentryTeam}.sentry.io/explore/traces/trace/${traceId}/`
    })
  }

  // Traceloop - LLM observability
  const traceloopKey = yield* TraceloopApiKey
  if (Option.isSome(traceloopKey)) {
    const endpoint = yield* TraceloopEndpoint
    const url = `${endpoint}/v1/traces`
    console.log(`[Tracing] Traceloop enabled → ${url}`)
    processors.push({
      name: "Traceloop",
      processor: new BatchSpanProcessor(
        new FetchOtlpExporter({
          name: "Traceloop",
          url,
          headers: {
            "Authorization": `Bearer ${Redacted.value(traceloopKey.value)}`
          }
        }),
        { scheduledDelayMillis: 100 }
      ),
      // Placeholder URL - Traceloop dashboard URL format TBD
      buildUrl: (traceId) =>
        `https://app.traceloop.com/traces/${traceId}`
    })
  }

  // Langfuse - LLM observability & evaluation
  const langfusePublicKey = yield* LangfusePublicKey
  const langfuseSecretKey = yield* LangfuseSecretKey
  const langfuseProject = yield* LangfuseProject
  if (Option.isSome(langfusePublicKey) && Option.isSome(langfuseSecretKey)) {
    const baseUrl = yield* LangfuseBaseUrl
    // Langfuse OTEL endpoint is at /api/public/otel/v1/traces
    const url = `${baseUrl.replace(/\/$/, "")}/api/public/otel/v1/traces`
    // Langfuse uses Basic auth with publicKey:secretKey
    const authString = Buffer.from(
      `${Redacted.value(langfusePublicKey.value)}:${Redacted.value(langfuseSecretKey.value)}`
    ).toString("base64")
    console.log(`[Tracing] Langfuse enabled → ${url}`)
    processors.push({
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
      // Placeholder URL - actual format depends on project
      buildUrl: (traceId) => {
        const project = Option.isSome(langfuseProject) ? langfuseProject.value : "your-project"
        const host = new URL(baseUrl).host
        return `https://${host}/project/${project}/traces/${traceId}`
      }
    })
  }

  return processors
})

// =============================================================================
// Create Tracing Layer (parameterized by service name)
// =============================================================================

export const createTracingLayer = (serviceName: string) => Layer.unwrapEffect(
  Effect.gen(function* () {
    const serviceVersion = yield* ServiceVersion
    const processors = yield* makeSpanProcessors(serviceName)

    if (processors.length === 0) {
      // Provide empty TraceLinks when no providers
      const emptyTraceLinks = Layer.succeed(TraceLinks, {
        providers: [],
        printLinks: () => Effect.void
      })
      return emptyTraceLinks
    }

    // Build active providers list for trace URLs
    const activeProviders: Array<ActiveProvider> = processors
      .filter((p) => p.buildUrl !== undefined)
      .map((p) => ({ name: p.name, buildUrl: p.buildUrl! }))

    // Terminal hyperlink helper (OSC 8 escape sequence)
    const terminalLink = (text: string, url: string): string =>
      `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`

    // Create TraceLinks service
    const traceLinksLayer = Layer.succeed(TraceLinks, {
      providers: activeProviders,
      printLinks: (traceId: string) =>
        Effect.gen(function* () {
          if (activeProviders.length > 0) {
            yield* Console.log("\n📊 Observability links")
            for (const provider of activeProviders) {
              const url = provider.buildUrl(traceId)
              yield* Console.log(`→ ${terminalLink(provider.name, url)}`)
            }
          }
        })
    })

    // Create the NodeSdk layer with ALL processors
    // CRITICAL: shutdownTimeout ensures spans flush before CLI exits
    const nodeSdkLayer = NodeSdk.layer(() => ({
      resource: {
        serviceName,
        serviceVersion,
        attributes: {
          "deployment.environment": process.env.NODE_ENV ?? "development"
        }
      },
      spanProcessor: processors.map((p) => p.processor),
      shutdownTimeout: "5 seconds"  // CRITICAL for CLI!
    }))

    return Layer.merge(nodeSdkLayer, traceLinksLayer)
  }).pipe(
    Effect.catchAll((error) =>
      Console.error(`Tracing setup failed: ${error}`).pipe(
        Effect.map(() =>
          Layer.succeed(TraceLinks, {
            providers: [],
            printLinks: () => Effect.void
          })
        )
      )
    )
  )
)

