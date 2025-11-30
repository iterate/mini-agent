/**
 * Task CLI Commands
 * 
 * Commands for managing tasks via RPC
 */

import { Args, Command, Options } from "@effect/cli"
import { Console, Effect } from "effect"
import { withTaskClient } from "./client"
import { serverUrlOption } from "./options"
import { withTraceLinks } from "../shared/tracing"

// =============================================================================
// List Command
// =============================================================================

const listCommand = Command.make(
  "list",
  {
    serverUrl: serverUrlOption,
    all: Options.boolean("all").pipe(
      Options.withAlias("a"),
      Options.withDescription("Show all tasks including completed"),
      Options.withDefault(false)
    )
  },
  ({ serverUrl, all }) =>
    withTaskClient(serverUrl, (client) =>
      Effect.gen(function* () {
        const tasks = yield* client.list({ all })

        if (tasks.length === 0) {
          yield* Console.log("No tasks.")
          return
        }

        for (const task of tasks) {
          const status = task.done ? "[x]" : "[ ]"
          yield* Console.log(`${status} #${task.id} ${task.text}`)
        }
      })
    ).pipe(
      withTraceLinks,
      Effect.withSpan("cli.tasks.list"),
      Effect.catchAll((error) => logError(error))
    )
).pipe(Command.withDescription("List tasks"))

// =============================================================================
// Add Command
// =============================================================================

const addCommand = Command.make(
  "add",
  {
    serverUrl: serverUrlOption,
    text: Args.text({ name: "text" }).pipe(
      Args.withDescription("The task description")
    )
  },
  ({ serverUrl, text }) =>
    withTaskClient(serverUrl, (client) =>
      Effect.gen(function* () {
        const task = yield* client.add({ text })
        yield* Console.log(`Added task #${task.id}: ${task.text}`)
      })
    ).pipe(
      withTraceLinks,
      Effect.withSpan("cli.tasks.add"),
      Effect.catchAll((error) => logError(error))
    )
).pipe(Command.withDescription("Add a new task"))

// =============================================================================
// Toggle Command
// =============================================================================

const toggleCommand = Command.make(
  "toggle",
  {
    serverUrl: serverUrlOption,
    id: Args.integer({ name: "id" }).pipe(
      Args.withDescription("Task ID to toggle")
    )
  },
  ({ serverUrl, id }) =>
    withTaskClient(serverUrl, (client) =>
      Effect.gen(function* () {
        const task = yield* client.toggle({ id })
        yield* Console.log(`Toggled: ${task.text} (${task.done ? "done" : "pending"})`)
      })
    ).pipe(
      withTraceLinks,
      Effect.withSpan("cli.tasks.toggle"),
      Effect.catchAll((error) => logError(error))
    )
).pipe(Command.withDescription("Toggle a task's done status"))

// =============================================================================
// Clear Command
// =============================================================================

const clearCommand = Command.make(
  "clear",
  { serverUrl: serverUrlOption },
  ({ serverUrl }) =>
    withTaskClient(serverUrl, (client) =>
      Effect.gen(function* () {
        const result = yield* client.clear({})
        yield* Console.log(`Cleared ${result.cleared} tasks.`)
      })
    ).pipe(
      withTraceLinks,
      Effect.withSpan("cli.tasks.clear"),
      Effect.catchAll((error) => logError(error))
    )
).pipe(Command.withDescription("Clear all tasks"))

// =============================================================================
// Error Helper
// =============================================================================

const logError = (error: unknown) =>
  Effect.gen(function* () {
    if (typeof error === "object" && error !== null && "_tag" in error) {
      yield* Console.error(`Error [${(error as { _tag: string })._tag}]: ${JSON.stringify(error)}`)
    } else if (error instanceof Error) {
      yield* Console.error(`Error: ${error.message}`)
    } else {
      yield* Console.error(`Error: ${String(error)}`)
    }
  })

// =============================================================================
// Export Group Command
// =============================================================================

export const tasksCommand = Command.make("tasks", {}, () =>
  Console.log("Task commands: list, add, toggle, clear\nUse 'tasks <command> --help' for details")
).pipe(
  Command.withDescription("Task management commands"),
  Command.withSubcommands([listCommand, addCommand, toggleCommand, clearCommand])
)

