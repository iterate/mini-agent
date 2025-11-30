import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
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
const otelLogLevel = process.env.OTEL_LOG_LEVEL?.toLowerCase()
if (otelLogLevel) {
  const level = otelLogLevel === "debug" ? DiagLogLevel.DEBUG
    : otelLogLevel === "info" ? DiagLogLevel.INFO
    : otelLogLevel === "warn" ? DiagLogLevel.WARN
    : otelLogLevel === "error" ? DiagLogLevel.ERROR
    : otelLogLevel === "verbose" ? DiagLogLevel.VERBOSE
    : DiagLogLevel.INFO
  diag.setLogger(new DiagConsoleLogger(), level)
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
// Custom Axiom Exporter (Bun-compatible, uses fetch)
// =============================================================================

class AxiomFetchExporter implements SpanExporter {
  private readonly url: string
  private readonly headers: Record<string, string>
  private readonly serializer = JsonTraceSerializer

  constructor(options: { url: string; apiKey: string; dataset: string }) {
    this.url = options.url
    this.headers = {
      "Authorization": `Bearer ${options.apiKey}`,
      "X-Axiom-Dataset": options.dataset,
      "Content-Type": "application/json"
    }
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const body = this.serializer.serializeRequest(spans)
    if (!body) {
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
          resultCallback({ code: ExportResultCode.SUCCESS })
        } else {
          const text = await response.text()
          diag.error(`Axiom export failed: ${response.status} ${text}`)
          resultCallback({ code: ExportResultCode.FAILED })
        }
      })
      .catch((error) => {
        diag.error(`Axiom export error: ${error}`)
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
    processors.push({
      name: "Honeycomb",
      processor: new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: `${endpoint}/v1/traces`,
          headers: { "x-honeycomb-team": Redacted.value(honeycombKey.value) }
        }),
        { scheduledDelayMillis: 100 }
      ),
      buildUrl: (traceId) =>
        `https://ui.honeycomb.io/${team}/environments/${env}/datasets/${serviceName}/trace?trace_id=${traceId}`
    })
  }

  // Axiom - use custom fetch-based exporter for Bun compatibility
  const axiomKey = yield* AxiomApiKey
  if (Option.isSome(axiomKey)) {
    const dataset = yield* AxiomDataset
    const endpoint = yield* AxiomEndpoint
    const axiomOrg = yield* AxiomOrg
    processors.push({
      name: "Axiom",
      processor: new BatchSpanProcessor(
        new AxiomFetchExporter({
          url: `${endpoint}/v1/traces`,
          apiKey: Redacted.value(axiomKey.value),
          dataset
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
    processors.push({
      name: "Sentry",
      processor: new BatchSpanProcessor(
        new OTLPTraceExporter({
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

