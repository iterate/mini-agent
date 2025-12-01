/**
 * Task Repository Service
 * 
 * In-memory task storage using Effect Ref for safe concurrent access.
 * Abstracted as a service for testability and future persistence options.
 */

import { Context, Effect, Layer, Ref } from "effect"
import { Task, TaskId, TaskNotFoundError } from "../shared/schemas"

// =============================================================================
// Repository State
// =============================================================================

interface TaskState {
  readonly tasks: ReadonlyArray<Task>
  readonly nextId: number
}

const initialState: TaskState = {
  tasks: [],
  nextId: 1
}

// =============================================================================
// Repository Interface
// =============================================================================

export class TaskRepository extends Context.Tag("TaskRepository")<
  TaskRepository,
  {
    readonly list: (options: { all: boolean }) => Effect.Effect<ReadonlyArray<Task>>
    readonly add: (text: string) => Effect.Effect<Task>
    readonly toggle: (id: number) => Effect.Effect<Task, TaskNotFoundError>
    readonly clear: () => Effect.Effect<{ cleared: number }>
  }
>() {}

// =============================================================================
// In-Memory Implementation
// =============================================================================

export const TaskRepositoryLive = Layer.effect(
  TaskRepository,
  Effect.gen(function* () {
    const state = yield* Ref.make(initialState)

    return {
      list: ({ all }) =>
        Ref.get(state).pipe(
          Effect.map(({ tasks }) => (all ? tasks : tasks.filter((t) => !t.done)))
        ),

      add: (text) =>
        Ref.modify(state, (s) => {
          const task = new Task({
            id: s.nextId as TaskId,
            text,
            done: false
          })
          return [task, { tasks: [...s.tasks, task], nextId: s.nextId + 1 }]
        }),

      toggle: (id) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(state)
          const index = current.tasks.findIndex((t) => t.id === id)

          if (index === -1) {
            return yield* Effect.fail(new TaskNotFoundError({ id }))
          }

          const task = current.tasks[index]!
          const updated = new Task({ id: task.id, text: task.text, done: !task.done })

          yield* Ref.update(state, (s) => ({
            ...s,
            tasks: s.tasks.map((t, i) => (i === index ? updated : t))
          }))

          return updated
        }),

      clear: () =>
        Ref.modify(state, (s) => [{ cleared: s.tasks.length }, initialState])
    }
  })
)

