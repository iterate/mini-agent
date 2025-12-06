# Interruption Handling Analysis

## Executive Summary

**Current implementation** has full interruption support via `Fiber.interrupt` in `chat-ui.ts`. The proposed architecture uses a different approach with background processing fibers and actor-based event distribution.

Both approaches are valid - the current implementation is simpler (per-turn fiber), while the proposed architecture enables multi-agent scenarios and richer observability.

---

## Current Implementation Analysis

### Location: `src/cli/chat-ui.ts`

**Pattern: Per-Turn Fiber with Race**

```typescript
// Fork LLM streaming
const streamFiber = yield* Effect.fork(
  streamLLMResponse(events).pipe(Stream.runDrain)
)

// Race between fiber completion and user interrupt
const waitForFiber = Fiber.join(fiber).pipe(Effect.as({ _tag: "completed" }))
const waitForInterrupt = Effect.gen(function*() {
  const signal = yield* mailbox.take
  yield* Fiber.interrupt(fiber)  // ← Cancel in-flight request
  return { _tag: "interrupted", newMessage: signal.text }
})

return yield* Effect.race(waitForFiber, waitForInterrupt)
```

**Interruption Flow:**
1. User input arrives via `mailbox.take`
2. `Fiber.interrupt(streamFiber)` cancels the LLM request
3. `LLMRequestInterruptedEvent` persisted with `partialResponse`
4. If user typed new message, starts new turn immediately

**Strengths:**
- Simple, self-contained per-turn logic
- Partial response captured and persisted
- Works well for single-user CLI

**Limitations:**
- No debouncing (each keypress could trigger)
- No turn lifecycle events (no AgentTurnStarted/Completed)
- Single context at a time
- No background processing - blocks on each turn

---

## Proposed Architecture Analysis

### Location: `architecture/actor-implementation-sketch.ts`

**Pattern: Background Processing Fiber with Mailbox + broadcastDynamic**

```typescript
// Background fiber watches for triggering events
const processingFiber = yield* broadcast.pipe(
  Stream.filter((e) => e.triggersAgentTurn),
  Stream.debounce(Duration.millis(100)),  // ← Debouncing
  Stream.mapEffect(() => processBatch),
  Stream.runDrain,
  Effect.fork
)

// Interruption on new triggering event (conceptual)
const currentTurnFiberRef = yield* Ref.make<Option<Fiber>>(Option.none())

// When new triggering event arrives during turn:
const current = yield* Ref.get(currentTurnFiberRef)
if (Option.isSome(current)) {
  yield* Fiber.interrupt(current.value)  // ← Interrupt existing
}
```

**Interruption Flow:**
1. New event with `triggersAgentTurn=true` arrives
2. Check if turn in progress via `agentTurnStartedAtEventId`
3. If yes, `Fiber.interrupt(currentTurnFiber)`
4. `onInterrupt` handler emits `AgentTurnInterruptedEvent`
5. 100ms debounce timer starts
6. When quiet, new turn begins

**Strengths:**
- Debouncing prevents rapid-fire requests
- Turn lifecycle events for observability
- Multi-agent support via AgentRegistry
- Broadcast to multiple subscribers

**Limitations:**
- More complex to implement
- 100ms minimum latency from debounce
- Late subscribers miss events

---

## Key Differences

| Aspect | Current | Proposed |
|--------|---------|----------|
| Fiber scope | Per-turn | Background processing |
| Interruption trigger | User input signal | New triggering event |
| Debouncing | None | 100ms hard-coded |
| Turn tracking | None | AgentTurnStarted/Completed events |
| Partial response | `LLMRequestInterruptedEvent.partialResponse` | Not specified (gap) |
| Multi-agent | Not supported | Via AgentRegistry |

## Gap: Partial Response in Architecture

The proposed architecture has `AgentTurnInterruptedEvent` with `reason: string` but **no field for partial response**. The current `LLMRequestInterruptedEvent.partialResponse` captures what the LLM generated before interruption.

**Recommendation:** Add `partialResponse: Schema.optionalWith(Schema.String, { as: "Option" })` to `AgentTurnInterruptedEvent` in design.ts.

---

## Implementation Notes

### Current Fiber Tracking (Missing from Sketch)

The `actor-implementation-sketch.ts` doesn't track the current turn fiber. To implement interruption:

```typescript
// Add to ActorState or separate Ref
const currentTurnFiberRef = yield* Ref.make<Option<Fiber.RuntimeFiber<void, AgentError>>>(Option.none())

// In processBatch, before starting turn:
const current = yield* Ref.get(currentTurnFiberRef)
if (Option.isSome(current)) {
  yield* Fiber.interrupt(current.value)
}

// Fork new turn
const turnFiber = yield* agentTurn.pipe(
  Effect.onInterrupt(() => emit(AgentTurnInterruptedEvent.make({ ... }))),
  Effect.fork
)
yield* Ref.set(currentTurnFiberRef, Option.some(turnFiber))
yield* Fiber.await(turnFiber)
yield* Ref.set(currentTurnFiberRef, Option.none())
```

### Effect Patterns Used

Both implementations use standard Effect patterns:
- `Effect.fork` / `Fiber.join` - fiber management
- `Fiber.interrupt` - cooperative cancellation
- `Mailbox` - actor input queue
- `Effect.race` - concurrent completion
- `Effect.onInterrupt` - cleanup handlers

---

## Conclusion

The current implementation has **working interruption support** - the original analysis was incorrect. The proposed architecture offers a different approach with additional capabilities (debouncing, turn lifecycle, multi-agent) at the cost of complexity.

Migration should preserve partial response capture by adding it to `AgentTurnInterruptedEvent`.
