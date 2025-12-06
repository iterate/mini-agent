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

Researched via Effect codebase analysis. Prioritizing simplicity over adding code.

| Issue | Decision | Rationale |
|-------|----------|-----------|
| 1. Effect.Service | **A) Remove `accessors: true`** | Effect's own packages (platform, ai) don't use accessors. Just yield* the tag. |
| 2. Non-Atomic State | **A) `Ref.modify()`** | Single atomic primitive. Semaphore overkill for JS single-threaded runtime. |
| 3. Schema Constructors | **B) Document** | design.ts is reference, not production. Real code uses `DateTime.unsafeNow()`. |
| 4. Unbounded Memory | **A) Bounded sliding** | `{ capacity: 256, strategy: "sliding" }` - TextDelta can drop, final message preserved. |
| 5. Fiber Interruption | **C) `Effect.uninterruptible`** | Wrap persistence calls. Effect's channel executor handles cleanup automatically. |
| 6. Debounce Starvation | **A+B) `aggregateWithin`** | `Sink.last()` + `Schedule.fixed("500ms")` guarantees max wait, reads fresh context. |
| 7. Shutdown Sequence | **A+B) Coordinated** | `end` → `await` with 5s timeout → `shutdown`. Simple and robust. |
| 8. Union Performance | **B) Accept as-is** | TaggedClass unions auto-optimize via `_tag` discriminator. Already O(1) lookup. |

### Key Insight

Most "fixes" are config changes or removing code, not adding complexity:
- Remove `accessors: true` (less code)
- Change `capacity: "unbounded"` to `capacity: 256` (config)
- Replace `debounce(100)` with `aggregateWithin(Sink.last(), Schedule.fixed("500ms"))` (same LOC)
- Wrap persist in `Effect.uninterruptible()` (one wrapper)
- Union already works (no change)
