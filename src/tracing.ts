/**
 * Tracing - Multi-destination OTLP export
 *
 * We're evaluating several tracing backends (Honeycomb, Axiom, Sentry, Langfuse, Traceloop)
 * to find the best fit. This module sends traces to all configured providers simultaneously.
 *
 * How it works:
 * - Effect's OtlpTracer batches spans and sends them via HttpClient
 * - We inject a custom HttpClient that fans out each request to all configured destinations
 * - Each destination gets the same OTLP payload with its own auth headers
 * - Failures are logged but don't break other destinations
 *
 * This is the cleanest approach - zero code copied from Effect, uses OtlpTracer as designed.
 */
import * as OtlpTracer from "@effect/opentelemetry/OtlpTracer"
import type * as Headers from "@effect/platform/Headers"
import * as HttpClient from "@effect/platform/HttpClient"
import * as HttpClientError from "@effect/platform/HttpClientError"
import * as HttpClientRequest from "@effect/platform/HttpClientRequest"
import * as HttpClientResponse from "@effect/platform/HttpClientResponse"
import type { ConfigError } from "effect"
import { Config, Context, Effect, identity, Layer, Option, Redacted, Stream } from "effect"

// =============================================================================
// Types
// =============================================================================

interface Destination {
  readonly name: string
  readonly url: string // Full URL including path (e.g., https://api.honeycomb.io/v1/traces)
  readonly headers?: Headers.Input
  readonly buildTraceUrl?: (traceId: string) => string
}

// =============================================================================
// Fan-Out HttpClient
// =============================================================================

/**
 * Execute a single HTTP request using fetch.
 * Simplified from FetchHttpClient - just handles the body types we need for OTLP.
 */
const executeFetch = (
  request: HttpClientRequest.HttpClientRequest,
  url: URL,
  signal: AbortSignal
): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> => {
  const send = (body: unknown) =>
    Effect.tryPromise({
      try: () =>
        globalThis.fetch(url, {
          method: request.method,
          headers: request.headers,
          body: body as RequestInit["body"],
          signal
        }),
      catch: (cause) =>
        new HttpClientError.RequestError({
          request,
          reason: "Transport",
          cause
        })
    }).pipe(Effect.map((response) => HttpClientResponse.fromWeb(request, response)))

  switch (request.body._tag) {
    case "Raw":
    case "Uint8Array":
      return send(request.body.body)
    case "FormData":
      return send(request.body.formData)
    case "Stream":
      return Effect.flatMap(Stream.toReadableStreamEffect(request.body.stream), send)
  }
  return send(undefined)
}

/**
 * Creates an HttpClient layer that fans out requests to multiple OTLP destinations.
 * Each destination specifies its full URL - we just replace the URL and add headers.
 */
const FanOutHttpClient = (destinations: ReadonlyArray<Destination>): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, _url, signal, _fiber) => {
      const effects = destinations.map((dest) => {
        const destRequest = request.pipe(
          HttpClientRequest.setUrl(dest.url),
          dest.headers ? HttpClientRequest.setHeaders(dest.headers) : identity
        )

        return executeFetch(destRequest, new URL(dest.url), signal).pipe(
          Effect.catchAllCause(() =>
            Effect.logWarning(`OTLP export to ${dest.name} failed`).pipe(
              Effect.annotateLogs("destination", dest.name),
              Effect.annotateLogs("url", dest.url),
              Effect.as(undefined as HttpClientResponse.HttpClientResponse | undefined)
            )
          )
        )
      })

      return Effect.all(effects, { concurrency: "unbounded" }).pipe(
        Effect.flatMap((responses) => {
          const successResponse = responses.find((r) => r !== undefined)
          if (successResponse) {
            return Effect.succeed(successResponse)
          }
          return Effect.fail(
            new HttpClientError.RequestError({
              request,
              reason: "Transport",
              cause: new Error("All OTLP export destinations failed")
            })
          )
        }),
        Effect.withTracerEnabled(false)
      )
    })
  )

// =============================================================================
// Provider Destinations
// =============================================================================

const honeycombDestination = (
  serviceName: string
): Effect.Effect<Option.Option<Destination>, ConfigError.ConfigError> =>
  Effect.gen(function*() {
    const key = yield* Config.option(Config.redacted("HONEYCOMB_API_KEY"))
    if (Option.isNone(key)) return Option.none()

    const endpoint = yield* Config.string("HONEYCOMB_ENDPOINT").pipe(Config.withDefault("https://api.honeycomb.io"))
    const team = yield* Config.string("HONEYCOMB_TEAM").pipe(Config.withDefault("iterate"))
    const env = yield* Config.string("HONEYCOMB_ENVIRONMENT").pipe(Config.withDefault("test"))

    const url = `${endpoint.replace(/\/$/, "")}/v1/traces`
    yield* Effect.logDebug(`Honeycomb enabled → ${url}`)

    return Option.some({
      name: "Honeycomb",
      url,
      headers: { "x-honeycomb-team": Redacted.value(key.value) },
      buildTraceUrl: (traceId) =>
        `https://ui.honeycomb.io/${team}/environments/${env}/datasets/${serviceName}/trace?trace_id=${traceId}`
    })
  })

const axiomDestination = (): Effect.Effect<Option.Option<Destination>, ConfigError.ConfigError> =>
  Effect.gen(function*() {
    const key = yield* Config.option(Config.redacted("AXIOM_API_KEY"))
    if (Option.isNone(key)) return Option.none()

    const dataset = yield* Config.string("AXIOM_DATASET").pipe(Config.withDefault("traces"))
    const endpoint = yield* Config.string("AXIOM_ENDPOINT").pipe(
      Config.withDefault("https://eu-central-1.aws.edge.axiom.co")
    )
    const org = yield* Config.option(Config.string("AXIOM_ORG"))

    const url = `${endpoint.replace(/\/$/, "")}/v1/traces`
    yield* Effect.logDebug(`Axiom enabled → ${url}`)

    return Option.some({
      name: "Axiom",
      url,
      headers: {
        "Authorization": `Bearer ${Redacted.value(key.value)}`,
        "X-Axiom-Dataset": dataset
      },
      ...(Option.isSome(org)
        ? {
          buildTraceUrl: (traceId: string) =>
            `https://app.axiom.co/${org.value}/stream/${dataset}?traceId=${traceId}&traceDataset=${dataset}`
        }
        : {})
    })
  })

const sentryDestination = (): Effect.Effect<Option.Option<Destination>, ConfigError.ConfigError> =>
  Effect.gen(function*() {
    const endpoint = yield* Config.option(Config.string("SENTRY_OTLP_ENDPOINT"))
    const key = yield* Config.option(Config.redacted("SENTRY_PUBLIC_KEY"))
    const team = yield* Config.string("SENTRY_TEAM").pipe(Config.withDefault("iterate-ec"))

    if (Option.isNone(endpoint) || Option.isNone(key)) return Option.none()

    // Ensure URL ends with /v1/traces (add if not present)
    const url = endpoint.value.replace(/\/?$/, "").replace(/\/v1\/traces$/, "") + "/v1/traces"

    yield* Effect.logDebug(`Sentry enabled → ${url}`)

    return Option.some({
      name: "Sentry",
      url,
      headers: { "x-sentry-auth": `sentry sentry_key=${Redacted.value(key.value)}` },
      buildTraceUrl: (traceId) => `https://${team}.sentry.io/explore/traces/trace/${traceId}/`
    })
  })

const langfuseDestination = (): Effect.Effect<Option.Option<Destination>, ConfigError.ConfigError> =>
  Effect.gen(function*() {
    const publicKey = yield* Config.option(Config.redacted("LANGFUSE_PUBLIC_KEY"))
    const secretKey = yield* Config.option(Config.redacted("LANGFUSE_SECRET_KEY"))
    const projectId = yield* Config.option(Config.string("LANGFUSE_PROJECT_ID"))

    if (Option.isNone(publicKey) || Option.isNone(secretKey)) return Option.none()

    const host = yield* Config.string("LANGFUSE_BASE_URL").pipe(Config.withDefault("https://cloud.langfuse.com"))
    // Langfuse uses non-standard path: /api/public/otel/v1/traces
    const url = `${host.replace(/\/$/, "")}/api/public/otel/v1/traces`

    const authString = Buffer.from(
      `${Redacted.value(publicKey.value)}:${Redacted.value(secretKey.value)}`
    ).toString("base64")

    yield* Effect.logDebug(`Langfuse enabled → ${url}`)

    return Option.some({
      name: "Langfuse",
      url,
      headers: { "Authorization": `Basic ${authString}` },
      buildTraceUrl: (traceId) => {
        const pid = Option.isSome(projectId) ? projectId.value : "your-project-id"
        const h = new URL(host).host
        return `https://${h}/project/${pid}/traces?peek=${traceId}`
      }
    })
  })

const traceloopDestination = (): Effect.Effect<Option.Option<Destination>, ConfigError.ConfigError> =>
  Effect.gen(function*() {
    const key = yield* Config.option(Config.redacted("TRACELOOP_API_KEY"))
    if (Option.isNone(key)) return Option.none()

    const endpoint = yield* Config.string("TRACELOOP_ENDPOINT").pipe(Config.withDefault("https://api.traceloop.com"))
    const projectSlug = yield* Config.string("TRACELOOP_PROJECT_SLUG").pipe(Config.withDefault("default"))

    const url = `${endpoint.replace(/\/$/, "")}/v1/traces`
    yield* Effect.logDebug(`Traceloop enabled → ${url}`)

    return Option.some({
      name: "Traceloop",
      url,
      headers: { "Authorization": `Bearer ${Redacted.value(key.value)}` },
      buildTraceUrl: (traceId) => `https://app.traceloop.com/projects/${projectSlug}/trace/${traceId}`
    })
  })

// =============================================================================
// TraceLinks Service
// =============================================================================

interface ActiveProvider {
  readonly name: string
  readonly buildUrl: (traceId: string) => string
}

export class TraceLinks extends Context.Tag("TraceLinks")<
  TraceLinks,
  {
    readonly providers: ReadonlyArray<ActiveProvider>
    readonly printLinks: (traceId: string) => Effect.Effect<void>
  }
>() {}

// Terminal hyperlink (OSC 8 escape sequence)
const terminalLink = (text: string, url: string): string => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`

// =============================================================================
// Create Tracing Layer
// =============================================================================

const collectDestinations = (serviceName: string): Effect.Effect<Array<Destination>, ConfigError.ConfigError> =>
  Effect.gen(function*() {
    const destinations: Array<Destination> = []

    const honeycomb = yield* honeycombDestination(serviceName)
    if (Option.isSome(honeycomb)) destinations.push(honeycomb.value)

    const axiom = yield* axiomDestination()
    if (Option.isSome(axiom)) destinations.push(axiom.value)

    const sentry = yield* sentryDestination()
    if (Option.isSome(sentry)) destinations.push(sentry.value)

    const langfuse = yield* langfuseDestination()
    if (Option.isSome(langfuse)) destinations.push(langfuse.value)

    const traceloop = yield* traceloopDestination()
    if (Option.isSome(traceloop)) destinations.push(traceloop.value)

    return destinations
  }).pipe(Effect.annotateLogs("source", "tracing"))

/**
 * Create a tracing layer for the given service name.
 * Configures OtlpTracer with fan-out to all enabled providers.
 */
export const createTracingLayer = (serviceName: string) =>
  Layer.unwrapEffect(
    Effect.gen(function*() {
      const serviceVersion = yield* Config.string("SERVICE_VERSION").pipe(Config.withDefault("1.0.0"))
      const destinations = yield* collectDestinations(serviceName)

      if (destinations.length === 0) {
        return Layer.succeed(TraceLinks, {
          providers: [],
          printLinks: () => Effect.void
        })
      }

      // Build active providers list for trace URLs
      const activeProviders: Array<ActiveProvider> = destinations
        .filter((d) => d.buildTraceUrl !== undefined)
        .map((d) => ({ name: d.name, buildUrl: d.buildTraceUrl! }))

      const traceLinksLayer = Layer.succeed(TraceLinks, {
        providers: activeProviders,
        printLinks: (traceId: string) =>
          Effect.gen(function*() {
            if (activeProviders.length > 0) {
              yield* Effect.logDebug("Exiting...")
              for (const provider of activeProviders) {
                const url = provider.buildUrl(traceId)
                yield* Effect.logDebug(`→ ${terminalLink(provider.name, url)}`)
              }
            }
          }).pipe(Effect.annotateLogs("source", "tracing"))
      })

      // OtlpTracer with fan-out HttpClient
      const tracerLayer = OtlpTracer.layer({
        url: "http://placeholder", // Ignored - FanOutHttpClient rewrites URLs
        resource: {
          serviceName,
          serviceVersion,
          attributes: {
            "deployment.environment": process.env.NODE_ENV ?? "development"
          }
        }
      }).pipe(
        Layer.provide(FanOutHttpClient(destinations))
      )

      return Layer.merge(tracerLayer, traceLinksLayer)
    }).pipe(
      Effect.catchAll((error) =>
        Effect.logWarning("Tracing setup failed, continuing without tracing", { error: String(error) }).pipe(
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
