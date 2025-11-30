import { Args, Command, Options } from "@effect/cli"
import { FileSystem } from "@effect/platform"
import type { PlatformError } from "@effect/platform/Error"
import { BunContext, BunRuntime } from "@effect/platform-bun"
import {
  Array,
  Console,
  Context,
  Effect,
  Layer,
  Option,
  type ParseResult,
  Schema
} from "effect"

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
      }).pipe(Effect.orElseSucceed(() => TaskList.empty))

      const save = (list: TaskList) =>
        Effect.gen(function* () {
          const json = yield* Schema.encode(TaskList.Json)(list)
          yield* fs.writeFileString(path, json)
        })

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

// add <task>
const taskText = Args.text({ name: "task" }).pipe(
  Args.withDescription("The task description")
)

const addCommand = Command.make("add", { text: taskText }, ({ text }) =>
  Effect.gen(function* () {
    const repo = yield* TaskRepo
    const task = yield* repo.add(text)
    yield* Console.log(`Added task #${task.id}: ${task.text}`)
  })
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
  })
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
  })
).pipe(Command.withDescription("Toggle a task's done status"))

// clear
const clearCommand = Command.make("clear", {}, () =>
  Effect.gen(function* () {
    const repo = yield* TaskRepo
    yield* repo.clear()
    yield* Console.log("Cleared all tasks.")
  })
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

const mainLayer = Layer.provideMerge(TaskRepo.layer, BunContext.layer)

cli(process.argv).pipe(Effect.provide(mainLayer), BunRuntime.runMain)
