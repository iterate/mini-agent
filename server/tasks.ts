/**
 * Task RPC Handlers
 * 
 * Server-side implementation of TaskRpcs from shared/schemas.ts
 */

import { Effect, Array as Arr, Option } from "effect"
import { TaskRpcs, Task, TaskId, TaskNotFoundError } from "../shared/schemas"

// =============================================================================
// In-Memory Task Storage
// =============================================================================

// Simple in-memory storage (replace with database in production)
let tasks: Task[] = []
let nextId = 1

// =============================================================================
// Handler Implementation
// =============================================================================

export const TaskHandlers = TaskRpcs.toLayer({
  list: ({ all }) =>
    Effect.gen(function* () {
      if (all) {
        return tasks
      }
      return tasks.filter((t) => !t.done)
    }).pipe(Effect.withSpan("tasks.list")),

  add: ({ text }) =>
    Effect.gen(function* () {
      const task = new Task({
        id: nextId++ as TaskId,
        text,
        done: false
      })
      tasks.push(task)
      return task
    }).pipe(Effect.withSpan("tasks.add")),

  toggle: ({ id }) =>
    Effect.gen(function* () {
      const index = tasks.findIndex((t) => t.id === id)
      if (index === -1) {
        return yield* Effect.fail(new TaskNotFoundError({ id }))
      }
      
      const task = tasks[index]
      const updated = new Task({
        ...task,
        done: !task.done
      })
      tasks[index] = updated
      return updated
    }).pipe(Effect.withSpan("tasks.toggle")),

  clear: () =>
    Effect.gen(function* () {
      const count = tasks.length
      tasks = []
      nextId = 1
      return { cleared: count }
    }).pipe(Effect.withSpan("tasks.clear"))
})

