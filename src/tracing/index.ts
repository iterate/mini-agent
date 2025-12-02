/**
 * Tracing Module
 *
 * Provides OpenTelemetry tracing with support for multiple backends.
 * Use createTracingLayer(serviceName) to get a Layer that sets up tracing.
 *
 * Supported providers (configured via environment variables):
 * - Honeycomb (HONEYCOMB_API_KEY)
 * - Axiom (AXIOM_API_KEY)
 * - Sentry (SENTRY_OTLP_ENDPOINT + SENTRY_PUBLIC_KEY)
 * - Traceloop (TRACELOOP_API_KEY)
 * - Langfuse (LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY)
 */
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api"
import type { ConfigError } from "effect"
import { Config, Console, Context, Effect, Layer, Option } from "effect"
import { axiomProvider } from "./axiom.js"
import { honeycombProvider } from "./honeycomb.js"
import { langfuseProvider } from "./langfuse.js"
import type { ActiveProvider, ProviderConfig } from "./provider.js"
import { sentryProvider } from "./sentry.js"
import { traceloopProvider } from "./traceloop.js"

// =============================================================================
// OpenTelemetry Diagnostic Logging
// =============================================================================

const otelLogLevel = process.env.OTEL_LOG_LEVEL?.toLowerCase() ?? "error"
const diagLevel = otelLogLevel === "debug" ?
  DiagLogLevel.DEBUG
  : otelLogLevel === "info" ?
  DiagLogLevel.INFO
  : otelLogLevel === "warn" ?
  DiagLogLevel.WARN
  : otelLogLevel === "error" ?
  DiagLogLevel.ERROR
  : otelLogLevel === "verbose" ?
  DiagLogLevel.VERBOSE
  : otelLogLevel === "none" ?
  DiagLogLevel.NONE
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

// =============================================================================
// TraceLinks Service
// =============================================================================

export class TraceLinks extends Context.Tag("TraceLinks")<
  TraceLinks,
  {
    readonly providers: ReadonlyArray<ActiveProvider>
    readonly printLinks: (traceId: string) => Effect.Effect<void>
  }
>() {}

// =============================================================================
// Collect Active Providers
// =============================================================================

const collectActiveProviders = (serviceName: string): Effect.Effect<Array<ProviderConfig>, ConfigError.ConfigError> =>
  Effect.gen(function*() {
    const providers: Array<ProviderConfig> = []

    const honeycomb = yield* honeycombProvider(serviceName)
    if (Option.isSome(honeycomb)) providers.push(honeycomb.value)

    const axiom = yield* axiomProvider()
    if (Option.isSome(axiom)) providers.push(axiom.value)

    const sentry = yield* sentryProvider()
    if (Option.isSome(sentry)) providers.push(sentry.value)

    const traceloop = yield* traceloopProvider()
    if (Option.isSome(traceloop)) providers.push(traceloop.value)

    const langfuse = yield* langfuseProvider()
    if (Option.isSome(langfuse)) providers.push(langfuse.value)

    return providers
  })

// =============================================================================
// Create Tracing Layer
// =============================================================================

/**
 * Create a tracing layer for the given service name.
 *
 * This is the main API for enabling tracing. Simply provide this layer
 * and tracing will be configured based on available environment variables.
 *
 * @param serviceName - Name of the service (appears in trace UI)
 * @returns Layer providing OpenTelemetry SDK and TraceLinks service
 */
export const createTracingLayer = (serviceName: string) =>
  Layer.unwrapEffect(
    Effect.gen(function*() {
      const serviceVersion = yield* ServiceVersion
      const providers = yield* collectActiveProviders(serviceName)

      if (providers.length === 0) {
        // No providers configured, provide empty TraceLinks
        return Layer.succeed(TraceLinks, {
          providers: [],
          printLinks: () => Effect.void
        })
      }

      // Build active providers list for trace URLs
      const activeProviders: Array<ActiveProvider> = providers
        .filter((p) => p.buildUrl !== undefined)
        .map((p) => ({ name: p.name, buildUrl: p.buildUrl! }))

      // Terminal hyperlink helper (OSC 8 escape sequence)
      const terminalLink = (text: string, url: string): string => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`

      // Create TraceLinks service
      const traceLinksLayer = Layer.succeed(TraceLinks, {
        providers: activeProviders,
        printLinks: (traceId: string) =>
          Effect.gen(function*() {
            if (activeProviders.length > 0) {
              yield* Console.log("\n\nExiting...\n\n📊 Observability links")
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
        spanProcessor: providers.map((p) => p.processor),
        shutdownTimeout: "5 seconds"
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

// =============================================================================
// Helper for printing trace links
// =============================================================================

/** Print trace links on exit if available */
export const printTraceLinks = Effect.gen(function*() {
  const traceLinks = yield* TraceLinks
  const maybeSpan = yield* Effect.currentSpan.pipe(Effect.option)

  yield* Option.match(maybeSpan, {
    onNone: () => Effect.void,
    onSome: (span) => traceLinks.printLinks(span.traceId)
  })
})

/** Wrapper that prints trace URLs at the start of a command */
export const withTraceLinks = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R | TraceLinks> =>
  Effect.gen(function*() {
    const traceLinks = yield* TraceLinks
    const currentSpan = yield* Effect.currentSpan.pipe(Effect.option)

    if (Option.isSome(currentSpan)) {
      yield* traceLinks.printLinks(currentSpan.value.traceId)
    }

    return yield* effect
  })
