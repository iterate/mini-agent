import { Args, Command, Options } from "@effect/cli"
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto"
import { SimpleSpanProcessor, type SpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base"
import { ExportResultCode, type ExportResult } from "@opentelemetry/core"
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer"
import { FileSystem } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import {
  Array,
  Config,
  Console,
  Context,
  Effect,
  Layer,
  Option,
  type ParseResult,
  Redacted,
  Schema
} from "effect"

// =============================================================================
// Multi-Provider Tracing - Standard OpenTelemetry approach
// =============================================================================
// One span → multiple SpanProcessors → multiple destinations
// This is the idiomatic OTel pattern: each span is processed by ALL processors

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

// Shared resource config
const ServiceName = Config.string("OTEL_SERVICE_NAME").pipe(
  Config.withDefault("effect-tasks-cli")
)
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
  Config.withDefault("https://eu-central-1.aws.edge.axiom.co")  // EU edge deployment
)
const AxiomOrg = Config.option(Config.string("AXIOM_ORG"))  // For trace URLs

// Sentry - uses OTLP endpoint from project settings
// See: https://docs.sentry.io/concepts/otlp/
const SentryOtlpEndpoint = Config.option(Config.string("SENTRY_OTLP_ENDPOINT"))
const SentryPublicKey = Config.option(Config.redacted("SENTRY_PUBLIC_KEY"))
const SentryTeam = Config.string("SENTRY_TEAM").pipe(
  Config.withDefault("iterate-ec")
)

// Add more providers here as needed...
// const DatadogApiKey = Config.option(Config.redacted("DD_API_KEY"))

// =============================================================================
// Trace Links Service - tracks active providers for printing trace URLs
// =============================================================================

type TraceUrlBuilder = (traceId: string) => string

interface ActiveProvider {
  readonly name: string
  readonly buildUrl: TraceUrlBuilder
}

class TraceLinks extends Context.Tag("TraceLinks")<
  TraceLinks,
  {
    readonly providers: ReadonlyArray<ActiveProvider>
    readonly printLinks: (traceId: string) => Effect.Effect<void>
  }
>() {}

// =============================================================================
// Custom Axiom Exporter using fetch (works with Bun)
// =============================================================================
// The standard OTLP exporters use Node's http module which has issues in Bun

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

const makeSpanProcessors = Effect.gen(function* () {
  const serviceName = yield* ServiceName
  const processors: Array<ProviderConfig> = []

  // Honeycomb
  const honeycombKey = yield* HoneycombApiKey
  if (Option.isSome(honeycombKey)) {
    const endpoint = yield* HoneycombEndpoint
    const team = yield* HoneycombTeam
    const env = yield* HoneycombEnvironment
    processors.push({
      name: "Honeycomb",
      processor: new SimpleSpanProcessor(
        new OTLPTraceExporter({
          url: `${endpoint}/v1/traces`,
          headers: { "x-honeycomb-team": Redacted.value(honeycombKey.value) }
        })
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
      processor: new SimpleSpanProcessor(
        new AxiomFetchExporter({
          url: `${endpoint}/v1/traces`,
          apiKey: Redacted.value(axiomKey.value),
          dataset
        })
      ),
      // Only include buildUrl if org is configured
      ...(Option.isSome(axiomOrg)
        ? {
            buildUrl: (traceId: string) =>
              `https://app.axiom.co/${axiomOrg.value}/stream/${dataset}?traceId=${traceId}&traceDataset=${dataset}`
          }
        : {})
    })
  }

  // Sentry - OTLP endpoint from project settings
  // https://docs.sentry.io/concepts/otlp/
  const sentryEndpoint = yield* SentryOtlpEndpoint
  const sentryKey = yield* SentryPublicKey
  const sentryTeam = yield* SentryTeam
  if (Option.isSome(sentryEndpoint) && Option.isSome(sentryKey)) {
    processors.push({
      name: "Sentry",
      processor: new SimpleSpanProcessor(
        new OTLPTraceExporter({
          url: sentryEndpoint.value,
          headers: {
            "x-sentry-auth": `sentry sentry_key=${Redacted.value(sentryKey.value)}`
          }
        })
      ),
      buildUrl: (traceId) =>
        `https://${sentryTeam}.sentry.io/explore/traces/trace/${traceId}/`
    })
  }

  // Add more providers here following the same pattern:
  // if (Option.isSome(someKey)) { processors.push({ name: "...", processor: ... }) }

  return processors
})

// =============================================================================
// Final Tracing Layer
// =============================================================================

const TracingLayer = Layer.unwrapEffect(
  Effect.gen(function* () {
    const serviceName = yield* ServiceName
    const serviceVersion = yield* ServiceVersion
    const processors = yield* makeSpanProcessors

    if (processors.length === 0) {
      yield* Console.log("⚠️  No tracing providers configured")
      // Provide empty TraceLinks when no providers
      const emptyTraceLinks = Layer.succeed(TraceLinks, {
        providers: [],
        printLinks: () => Effect.void
      })
      return emptyTraceLinks
    }

    // Log enabled providers
    for (const p of processors) {
      yield* Console.log(`✓ Tracing enabled: ${p.name}`)
    }

    // Build active providers list for trace URLs
    const activeProviders: Array<ActiveProvider> = processors
      .filter((p) => p.buildUrl !== undefined)
      .map((p) => ({ name: p.name, buildUrl: p.buildUrl! }))

    // Terminal hyperlink helper (OSC 8 escape sequence)
    // Format: \x1b]8;;URL\x1b\\TEXT\x1b]8;;\x1b\\
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
    // Each span will be sent to ALL destinations
    const nodeSdkLayer = NodeSdk.layer(() => ({
      resource: {
        serviceName,
        serviceVersion,
        attributes: {
          "deployment.environment": process.env.NODE_ENV ?? "development"
        }
      },
      spanProcessor: processors.map((p) => p.processor)
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
// Task Schema
// =============================================================================

const TaskId = Schema.Number.pipe(Schema.brand("TaskId"))
type TaskId = typeof TaskId.Type

class Task extends Schema.Class<Task>("Task")({
  id: TaskId,
  text: Schema.NonEmptyString,
  done: Schema.Boolean
}) {
  toggle() {
    return Task.make({ ...this, done: !this.done })
  }
}

class TaskList extends Schema.Class<TaskList>("TaskList")({
  tasks: Schema.Array(Task)
}) {
  static Json = Schema.parseJson(TaskList)
  static empty = TaskList.make({ tasks: [] })

  get nextId(): TaskId {
    if (this.tasks.length === 0) return TaskId.make(1)
    return TaskId.make(Math.max(...this.tasks.map((t) => t.id)) + 1)
  }

  add(text: string): [TaskList, Task] {
    const task = Task.make({ id: this.nextId, text, done: false })
    return [TaskList.make({ tasks: [...this.tasks, task] }), task]
  }

  toggle(id: TaskId): [TaskList, Option.Option<Task>] {
    const index = this.tasks.findIndex((t) => t.id === id)
    if (index === -1) return [this, Option.none()]

    const existingTask = this.tasks[index]
    if (!existingTask) return [this, Option.none()]

    const updated = existingTask.toggle()
    const tasks = Array.modify(this.tasks, index, () => updated)
    return [TaskList.make({ tasks }), Option.some(updated)]
  }

  find(id: TaskId): Option.Option<Task> {
    return Array.findFirst(this.tasks, (t) => t.id === id)
  }

  get pending() {
    return this.tasks.filter((t) => !t.done)
  }

  get completed() {
    return this.tasks.filter((t) => t.done)
  }
}

// =============================================================================
// TaskRepo Service
// =============================================================================

type TaskRepoError = PlatformError | ParseResult.ParseError

class TaskRepo extends Context.Tag("TaskRepo")<
  TaskRepo,
  {
    readonly list: (all?: boolean) => Effect.Effect<ReadonlyArray<Task>>
    readonly add: (text: string) => Effect.Effect<Task, TaskRepoError>
    readonly toggle: (
      id: TaskId
    ) => Effect.Effect<Option.Option<Task>, TaskRepoError>
    readonly clear: () => Effect.Effect<void, TaskRepoError>
  }
>() {
  static layer = Layer.effect(
    TaskRepo,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = "tasks.json"

      // Helpers
      const load = Effect.gen(function* () {
        const content = yield* fs.readFileString(path)
        return yield* Schema.decode(TaskList.Json)(content)
      }).pipe(
        Effect.orElseSucceed(() => TaskList.empty),
        Effect.withSpan("TaskRepo.load")
      )

      const save = (list: TaskList) =>
        Effect.gen(function* () {
          const json = yield* Schema.encode(TaskList.Json)(list)
          yield* fs.writeFileString(path, json)
        }).pipe(
          Effect.withSpan("TaskRepo.save", {
            attributes: { "task.count": list.tasks.length }
          })
        )

      // Public API
      const list = Effect.fn("TaskRepo.list")(function* (all?: boolean) {
        const taskList = yield* load
        if (all) return taskList.tasks
        return taskList.tasks.filter((t) => !t.done)
      })

      const add = Effect.fn("TaskRepo.add")(function* (text: string) {
        const currentList = yield* load
        const [newList, task] = currentList.add(text)
        yield* save(newList)
        return task
      })

      const toggle = Effect.fn("TaskRepo.toggle")(function* (id: TaskId) {
        const currentList = yield* load
        const [newList, task] = currentList.toggle(id)
        yield* save(newList)
        return task
      })

      const clear = Effect.fn("TaskRepo.clear")(function* () {
        yield* save(TaskList.empty)
      })

      return { list, add, toggle, clear }
    })
  )
}

// =============================================================================
// CLI Commands
// =============================================================================

/** Wrapper that prints trace URLs after a command completes */
const withTraceLinks = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R | TraceLinks> =>
  Effect.gen(function* () {
    const result = yield* effect
    const traceLinks = yield* TraceLinks
    const currentSpan = yield* Effect.currentSpan.pipe(Effect.option)

    if (Option.isSome(currentSpan)) {
      yield* traceLinks.printLinks(currentSpan.value.traceId)
    }

    return result
  })

// add <task>
const taskText = Args.text({ name: "task" }).pipe(
  Args.withDescription("The task description")
)

const addCommand = Command.make("add", { text: taskText }, ({ text }) =>
  Effect.gen(function* () {
    const repo = yield* TaskRepo
    const task = yield* repo.add(text)
    yield* Console.log(`Added task #${task.id}: ${task.text}`)
  }).pipe(
    withTraceLinks,
    Effect.withSpan("cli.add", {
      attributes: { "cli.command": "add", "task.text": text }
    })
  )
).pipe(Command.withDescription("Add a new task"))

// list [--all]
const allOption = Options.boolean("all").pipe(
  Options.withAlias("a"),
  Options.withDescription("Show all tasks including completed")
)

const listCommand = Command.make("list", { all: allOption }, ({ all }) =>
  Effect.gen(function* () {
    const repo = yield* TaskRepo
    const tasks = yield* repo.list(all)

    if (tasks.length === 0) {
      yield* Console.log("No tasks.")
      return
    }

    for (const task of tasks) {
      const status = task.done ? "[x]" : "[ ]"
      yield* Console.log(`${status} #${task.id} ${task.text}`)
    }
  }).pipe(
    withTraceLinks,
    Effect.withSpan("cli.list", {
      attributes: { "cli.command": "list", "cli.args.all": all }
    })
  )
).pipe(Command.withDescription("List pending tasks"))

// toggle <id>
const taskId = Args.integer({ name: "id" }).pipe(
  Args.withSchema(TaskId),
  Args.withDescription("The task ID to toggle")
)

const toggleCommand = Command.make("toggle", { id: taskId }, ({ id }) =>
  Effect.gen(function* () {
    const repo = yield* TaskRepo
    const result = yield* repo.toggle(id)

    yield* Option.match(result, {
      onNone: () => Console.log(`Task #${id} not found`),
      onSome: (task) =>
        Console.log(`Toggled: ${task.text} (${task.done ? "done" : "pending"})`)
    })
  }).pipe(
    withTraceLinks,
    Effect.withSpan("cli.toggle", {
      attributes: { "cli.command": "toggle", "task.id": id }
    })
  )
).pipe(Command.withDescription("Toggle a task's done status"))

// clear
const clearCommand = Command.make("clear", {}, () =>
  Effect.gen(function* () {
    const repo = yield* TaskRepo
    yield* repo.clear()
    yield* Console.log("Cleared all tasks.")
  }).pipe(
    withTraceLinks,
    Effect.withSpan("cli.clear", {
      attributes: { "cli.command": "clear" }
    })
  )
).pipe(Command.withDescription("Clear all tasks"))

// =============================================================================
// Main App
// =============================================================================

const app = Command.make("tasks", {}).pipe(
  Command.withDescription("A simple task manager"),
  Command.withSubcommands([addCommand, listCommand, toggleCommand, clearCommand])
)

const cli = Command.run(app, {
  name: "tasks",
  version: "1.0.0"
})

const mainLayer = Layer.provideMerge(TaskRepo.layer, BunContext.layer).pipe(
  Layer.provideMerge(TracingLayer)
)

cli(process.argv).pipe(Effect.provide(mainLayer), BunRuntime.runMain)
