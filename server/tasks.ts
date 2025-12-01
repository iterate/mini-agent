/**
 * Task RPC Handlers
 * 
 * Server-side implementation of TaskRpcs from shared/schemas.ts
 */

import { Effect, Layer } from "effect"
import { TaskRpcs } from "../shared/schemas"
import { TaskRepository, TaskRepositoryLive } from "./task-repository"

// =============================================================================
// Handler Implementation
// =============================================================================

const TaskHandlersImpl = TaskRpcs.toLayer(
  Effect.gen(function* () {
    const repo = yield* TaskRepository

    return {
      list: ({ all }) => repo.list({ all }).pipe(Effect.withSpan("tasks.list")),

      add: ({ text }) => repo.add(text).pipe(Effect.withSpan("tasks.add")),

      toggle: ({ id }) => repo.toggle(id).pipe(Effect.withSpan("tasks.toggle")),

      clear: () => repo.clear().pipe(Effect.withSpan("tasks.clear"))
    }
  })
)

// =============================================================================
// Export with Repository Dependency
// =============================================================================

export const TaskHandlers = TaskHandlersImpl.pipe(Layer.provide(TaskRepositoryLive))
