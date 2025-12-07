# Architecture TODOs

Outstanding issues from adversarial review. Each needs a decision before implementation.

## Critical

### 1. Effect.Service Pattern Misuse

`accessors: true` wraps ALL properties in Effects - breaks `initialReducedContext` (plain value) and `execute` (returns Stream). Pre-wrapped Effects get double-wrapped.

**Options:**
- A) Remove `accessors: true`, access services via `yield* ServiceTag` only
- B) Use `Context.Tag` pattern instead of `Effect.Service`

### 2. Non-Atomic State Updates

`Ref.get` → modify → `Ref.set` races with concurrent `addEvent` calls. EventId generation can produce duplicates.

**Options:**
- A) Use `Ref.modify()` for atomic read-modify-write
- B) Serialize all `addEvent` through single fiber (true actor pattern)
- C) Both

### 3. Schema Constructor Validation

- `new Date() as never` fails - need `DateTime.unsafeNow()`
- `Schema.optionalWith` still requires field at construction
- `Schema.Redacted` encodes to plain string (API key leak)

**Options:**
- A) Fix sampleProgram, use explicit `Option.none()`, add custom Redacted encoder
- B) Document as known limitation for design.ts (not production code)

## High

### 4. Unbounded Memory

`capacity: "unbounded"` in broadcastDynamic causes memory growth with slow subscribers. No backpressure.

**Options:**
- A) Bounded capacity with drop strategy for TextDelta events
- B) Document as operational concern, add monitoring
- C) Redesign with explicit backpressure

### 5. Fiber Interruption Semantics

`Fiber.interrupt` returns when fiber EXITS, not when cleanup COMPLETES. Stream.tap can be interrupted mid-persistence.

**Options:**
- A) Use `Fiber.await` after interrupt
- B) Make EventStore.append atomic (file lock)
- C) Add `Stream.onInterrupt` handlers
- D) All of the above

### 6. Debounce Starvation

Continuous events (>10/sec) reset debounce forever - agent never takes turn. Context snapshot is stale after debounce.

**Options:**
- A) Add max wait time (500ms) regardless of new events
- B) Read fresh context AFTER debounce fires
- C) Replace debounce with explicit batching
- D) Use `Stream.throttle` instead

## Medium

### 7. Shutdown Sequence

`mailbox.end` before subscribers drain may lose SessionEndedEvent.

**Options:**
- A) Wait for subscriber acknowledgment
- B) Timeout with forced termination

### 8. Union Schema Performance

No discriminator on ContextEvent - O(n) decode for 13 types.

**Options:**
- A) Add discriminator annotation
- B) Accept O(13) as fine

## Decisions Made

(Record decisions here as they're made)

| Issue | Decision | Rationale |
|-------|----------|-----------|
| | | |
