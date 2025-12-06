# Interruption Handling: Architecture vs Implementation Comparison

**Date:** 2025-12-06
**Analysis Focus:** How interruption is handled in the proposed architecture vs current implementation

---

## Executive Summary

The **current implementation** has **no interruption handling** for in-flight LLM requests. The **proposed architecture** introduces comprehensive interruption support using Effect's fiber management. This represents a **significant architectural change** requiring substantial implementation effort.

### Key Finding: Zero Interruption Support Currently

The current codebase processes requests **synchronously** with no ability to cancel in-flight LLM requests when new input arrives. The proposed architecture fundamentally changes this by introducing **background processing fibers** that can be interrupted.

---

## Current Implementation Analysis

### Request Flow (src/context.service.ts, src/cli.ts)

**Pattern: Synchronous Stream Processing**

```typescript
// From cli.ts:184-186
yield* contextService.addEvents(contextName, inputEvents).pipe(
  Stream.runForEach((event) => handleEvent(event, options))
)
```

**How it works:**
1. User input arrives via `addEvents(contextName, [new UserMessageEvent(...)])`
2. `ContextService.addEvents`:
   - Loads existing events from file
   - Appends new input events
   - Saves to file
   - If UserMessage present: calls `streamLLMResponse(events)`
   - Returns Stream of events (TextDelta + AssistantMessage)
3. Stream consumed synchronously with `Stream.runForEach`
4. Each event displayed as it arrives
5. Request completes, control returns to CLI loop

**Key Characteristics:**
- ✅ Simple, easy to understand
- ✅ No state management complexity
- ❌ **No cancellation possible** - once LLM request starts, it runs to completion
- ❌ No background processing
- ❌ No debouncing
- ❌ No turn tracking or lifecycle events

### Interruption Handling: Top-Level Only

**From main.ts:112**
```typescript
Effect.catchAllCause((cause) =>
  Cause.isInterruptedOnly(cause) ? Effect.void : Effect.failCause(cause)
)
```

This handles **Ctrl+C** at the application level to exit gracefully, but does **not** handle interruption of individual requests.

### Stream Consumption Patterns

All stream consumption is **synchronous** and **blocking**:
- `Stream.runForEach` in interactive mode
- `Stream.runCollect` when reading stdin
- `Stream.runDrain` in script mode

No use of `Effect.fork` or `Fiber` management in the request handling path.

---

## Proposed Architecture Analysis

### Request Flow (architecture/actor-implementation-sketch.ts)

**Pattern: Actor with Background Processing Fiber**

```typescript
// Lines 208-219: Background processing fiber
const processingFiber = yield* broadcast.pipe(
  Stream.filter((e) => e.triggersAgentTurn),
  Stream.debounce(Duration.millis(100)),
  Stream.mapEffect(() => processBatch),
  Stream.catchAll((error) => ...),
  Stream.runDrain,
  Effect.fork  // ← Runs in background!
)
```

**How it works:**
1. Actor initialization:
   - Creates Mailbox for input
   - Creates broadcast stream via `Stream.broadcastDynamic`
   - Forks background processing fiber that watches for events
   - Returns service interface
2. When event added via `addEvent`:
   - Persists to EventStore immediately
   - Updates in-memory events array
   - Runs reducer to update reducedContext
   - Offers to mailbox (broadcasts to all subscribers)
   - Returns immediately (fire-and-forget)
3. Background fiber:
   - Filters events with `triggersAgentTurn=true`
   - Debounces for 100ms
   - Calls `processBatch` which emits turn events and calls LLM
4. Multiple subscribers can consume the broadcast stream independently

**Key Characteristics:**
- ✅ **Background processing** - requests handled asynchronously
- ✅ **Interruptible** - can cancel in-flight requests
- ✅ **Debouncing** - 100ms delay prevents rapid-fire requests
- ✅ **Turn tracking** - explicit lifecycle events
- ❌ More complex state management
- ❌ Requires understanding of Mailbox, broadcastDynamic, Fiber

### Interruption Mechanism

**From requirements.md:71-80 and architecture.md:177-183**

The proposed architecture handles interruption in **two places**:

#### 1. New Event Arrives During Turn

**Flow:**
```
User types new message while LLM is generating
    ↓
New UserMessageEvent with triggersAgentTurn=true arrives
    ↓
addEvent() persists immediately, offers to mailbox
    ↓
Background fiber sees new triggering event
    ↓
Need to interrupt current turn!
    ↓
Fiber.interrupt(currentTurnFiber)  ← Blocks until cleanup done
    ↓
onInterrupt handler in processBatch emits AgentTurnInterruptedEvent
    ↓
New debounce timer starts (100ms)
    ↓
When quiet, new turn begins
```

**Implementation pattern** (from architecture.md:207-216):
```typescript
// In processBatch - the effect that runs each turn
yield* Fiber.interrupt(runningFiber)  // Blocks until cleanup

Effect.onInterrupt(() =>
  Effect.gen(function*() {
    yield* emit(AgentTurnInterruptedEvent.make({ reason: "new input" }))
  })
)
```

#### 2. Shutdown During Turn

**From actor-implementation-sketch.ts:231-243**

```typescript
yield* Effect.addFinalizer((_exit) =>
  Effect.gen(function*() {
    const state = yield* Ref.get(stateRef)
    const sessionEndMeta = makeEventMeta(state)
    const sessionEndEvent = { _tag: "SessionEndedEvent", ...sessionEndMeta }
    yield* mailbox.offer(sessionEndEvent)
    yield* mailbox.end
    yield* Fiber.interrupt(processingFiber)  // ← Cleanup on shutdown
  })
)
```

When the actor scope closes (app shutdown, agent removed), the finalizer:
1. Emits SessionEndedEvent
2. Ends the mailbox (completes the stream)
3. Interrupts the processing fiber
4. Blocks until cleanup completes

### Event Types for Interruption

**New events in design.ts:201-217**

```typescript
export class AgentTurnInterruptedEvent extends Schema.TaggedClass<AgentTurnInterruptedEvent>()(
  "AgentTurnInterruptedEvent",
  {
    ...BaseEventFields,
    turnNumber: AgentTurnNumber,
    reason: Schema.String
  }
) {}
```

Also includes:
- `AgentTurnStartedEvent` - marks beginning of turn
- `AgentTurnCompletedEvent` - successful completion
- `AgentTurnFailedEvent` - error during turn

These provide **observability** into the turn lifecycle.

---

## Compatibility Analysis

### Are They Compatible?

**No - fundamentally different architectures.**

| Aspect | Current | Proposed | Compatible? |
|--------|---------|----------|-------------|
| Request processing | Synchronous | Asynchronous (background fiber) | ❌ No |
| Interruption support | None | Full fiber interruption | ❌ No |
| State management | Stateless service | Actor with internal state (events + reducedContext) | ❌ No |
| Event model | Simple events (5 types) | Rich event model (12+ types with metadata) | ⚠️ Partial |
| Persistence | Direct file I/O | EventStore abstraction | ⚠️ Partial |
| Stream pattern | Direct consumption | Mailbox + broadcastDynamic | ❌ No |
| Lifecycle | None | Explicit (SessionStarted/Ended, turn events) | ❌ No |

### What Can Be Reused?

**✅ Can migrate directly:**
- Event schemas (SystemPrompt, UserMessage, AssistantMessage, TextDelta, FileAttachment)
- LLM streaming logic (streamLLMResponse in llm.ts)
- Config system (config.ts, llm-config.ts)
- Logging and tracing infrastructure
- Repository file I/O logic (can become EventStore.yamlFileLayer)

**⚠️ Needs refactoring:**
- ContextService → needs to become stateless domain services (Agent, EventReducer)
- ContextRepository → becomes EventStore with pluggable implementations
- Event model → add BaseEventFields (id, timestamp, agentName, parentEventId, triggersAgentTurn)

**❌ Complete rewrite:**
- CLI interaction loop → needs to work with actor events stream
- Request flow → convert from synchronous to actor-based
- State management → introduce Ref for events + reducedContext

---

## Migration Effort Assessment

### Phase 1: Foundation (Est: 2-3 days)

**Goal: Event model + EventStore**

1. ✅ Add BaseEventFields to all events
   - Add id, timestamp, agentName, parentEventId, triggersAgentTurn
   - Update all event constructors
2. ✅ Create EventStore interface + implementations
   - Extract file I/O from ContextRepository → EventStore.yamlFileLayer
   - Create EventStore.inMemoryLayer for tests
3. ✅ Create EventReducer service
   - Pure function: (ReducedContext, events) → ReducedContext
   - Handle config events (SetLlmProviderConfig, SetTimeout)
   - Derive messages for LLM
   - Track nextEventNumber, currentTurnNumber, agentTurnStartedAtEventId
4. ✅ Create Agent service
   - Move LLM logic from ContextService
   - takeTurn(reducedContext) → Stream<ContextEvent, AgentError>

**Tests:** Unit tests for EventReducer (pure function), EventStore (in-memory)

### Phase 2: Actor Implementation (Est: 3-4 days)

**Goal: MiniAgent with basic functionality**

1. ✅ Implement MiniAgent.make
   - Mailbox creation
   - Stream.broadcastDynamic setup
   - State management (events + reducedContext in Ref)
   - addEvent implementation
2. ✅ Background processing fiber
   - Filter triggersAgentTurn events
   - Debounce (100ms hard-coded)
   - Call processBatch
   - Error handling
3. ✅ Event lifecycle
   - SessionStartedEvent on creation
   - AgentTurnStartedEvent before LLM call
   - AgentTurnCompletedEvent on success
   - AgentTurnFailedEvent on error
   - SessionEndedEvent on shutdown
4. ⚠️ **Skip interruption for Phase 2** - implement in Phase 3

**Tests:** Actor lifecycle tests, event broadcasting, turn processing

### Phase 3: Interruption (Est: 2-3 days)

**Goal: Full interruption support**

1. ✅ Track current turn fiber
   - Store Fiber<...> in Ref when turn starts
   - Clear when turn completes/fails
2. ✅ Implement interruption on new triggering event
   - Check if turn in progress (agentTurnStartedAtEventId)
   - Interrupt current fiber if present
   - Emit AgentTurnInterruptedEvent
3. ✅ onInterrupt handler in processBatch
   - Clean up resources
   - Emit interruption event
4. ✅ Shutdown interruption
   - addFinalizer interrupts processing fiber
   - Blocks until cleanup done

**Tests:** Interruption scenarios, concurrent event handling, shutdown during turn

### Phase 4: Registry + CLI Integration (Est: 2-3 days)

**Goal: Multi-agent support + working CLI**

1. ✅ Implement AgentRegistry
   - getOrCreate caches agents
   - Route events to correct agent
   - shutdownAll for cleanup
2. ✅ Update CLI to use actors
   - Subscribe to agent.events stream
   - Fork subscription fiber
   - addEvent for user input
   - Handle graceful shutdown
3. ✅ Script mode + raw output
   - JSONL input/output
   - Multiple subscribers to same agent

**Tests:** Multi-agent scenarios, CLI integration tests

### Phase 5: Polish + Migration (Est: 1-2 days)

**Goal: Production-ready**

1. ✅ Remove old ContextService
2. ✅ Update all tests
3. ✅ Documentation updates
4. ✅ Performance testing
5. ✅ Migration guide for config files

**Total Estimated Effort: 10-15 days**

---

## Risks and Considerations

### Technical Risks

1. **Fiber interruption complexity**
   - Effect's fiber model needs to be well understood
   - Interrupt handlers must be bulletproof (no resource leaks)
   - Testing concurrent scenarios is challenging

2. **State management bugs**
   - Reducer must be pure and deterministic
   - Race conditions between addEvent and background processing
   - Ref updates must be atomic

3. **broadcastDynamic behavior**
   - Late subscribers miss events (by design)
   - Need to understand PubSub semantics
   - Testing multi-subscriber scenarios

4. **Performance implications**
   - Background fiber adds overhead
   - Debouncing adds latency (100ms minimum)
   - Mailbox memory usage with high event volume

### Behavioral Changes

1. **Fire-and-forget addEvent**
   - Current: addEvent returns when LLM completes
   - Proposed: addEvent returns immediately
   - **Impact:** CLI needs to wait for events stream, not addEvent completion

2. **Debouncing delay**
   - Current: Immediate response
   - Proposed: 100ms delay minimum
   - **Impact:** Perceptible latency in interactive mode

3. **Live stream semantics**
   - Current: N/A (synchronous)
   - Proposed: Late subscribers miss events
   - **Impact:** Must subscribe BEFORE adding events, or use getEvents for history

### Migration Complexity

**Breaking changes:**
1. Event schema changes (BaseEventFields)
2. Service interface changes (ContextService → Agent, EventReducer, MiniAgent)
3. File format changes (event IDs, metadata)
4. CLI behavior changes (async event handling)

**Migration path:**
- Cannot migrate gradually - need cutover
- Old context files need migration script
- Config format changes

---

## Effect Pattern Analysis

### Patterns Used in Proposed Architecture

The architecture document references several Effect patterns. Let me verify these:

#### ✅ Mailbox Pattern

**Status: Well-established Effect pattern**

From actor-implementation-sketch.ts:107-108:
```typescript
const mailbox = yield* Mailbox.make<ContextEvent>()
yield* mailbox.offer(event)
```

This is standard Effect.Mailbox usage for actor input queues.

#### ✅ Stream.broadcastDynamic Pattern

**Status: Core Effect streaming primitive**

From actor-implementation-sketch.ts:126-128:
```typescript
const broadcast = yield* Stream.broadcastDynamic(Mailbox.toStream(mailbox), {
  capacity: "unbounded"
})
```

Creates internal PubSub. Each execution of the stream = new subscriber.

**Key insight from lines 24-26:**
> broadcastDynamic is a LIVE stream:
> - Late subscribers only receive events published AFTER they subscribe
> - For historical events, use getEvents (reads from in-memory state)

This is correct behavior - not a bug.

#### ✅ Fiber.interrupt Pattern

**Status: Core Effect concurrency primitive**

From architecture.md:207-216:
```typescript
yield* Fiber.interrupt(runningFiber)  // Blocks until cleanup

Effect.onInterrupt(() =>
  Effect.gen(function*() {
    yield* emit(AgentTurnInterruptedEvent.make({ reason: "new input" }))
  })
)
```

Standard Effect interruption:
- `Fiber.interrupt(fiber)` - interrupts and waits for cleanup
- `Effect.onInterrupt(() => ...)` - cleanup handler

#### ✅ Layer.scoped Pattern

**Status: Standard Effect resource management**

From architecture.md:222-234:
```typescript
Layer.scoped(MiniAgent, Effect.gen(function*() {
  const mailbox = yield* Mailbox.make<ContextEvent>()

  yield* Effect.addFinalizer((_exit) =>
    Effect.gen(function*() {
      yield* mailbox.offer(SessionEndedEvent.make({ ... }))
      yield* mailbox.end
    })
  )

  return { /* service */ }
}))
```

Standard pattern for scoped resources with cleanup.

### Pattern Verification Summary

All Effect patterns used in the proposed architecture are **standard, well-documented patterns**. No experimental or risky APIs.

**Sources checked:**
- ❌ Effect source not available at ~/src/github.com/Effect-TS/effect
- ❌ EffectPatterns not available at ~/src/github.com/PaulJPhilp/EffectPatterns
- ✅ Patterns verified against Effect documentation and common usage

---

## Inconsistencies Found

### 1. ⚠️ Event ID Generation

**In actor-implementation-sketch.ts:112-121**
```typescript
const makeEventMeta = (state: ActorState, triggersAgentTurn = false) => {
  const id = `${agentName}:${String(state.reducedContext.nextEventNumber).padStart(4, "0")}`
  return {
    id,
    timestamp: DateTime.unsafeNow(),
    agentName,
    parentEventId: state.reducedContext.agentTurnStartedAtEventId,
    triggersAgentTurn
  }
}
```

**Issue:** This generates event ID inline, but the reducer increments `nextEventNumber` AFTER the event is created.

**Fix needed:** Increment counter BEFORE generating ID, or include counter increment in makeEventMeta.

### 2. ⚠️ Turn Number Increment Timing

**From design.ts:308-316 comments:**
> AgentTurnStartedEvent → agentTurnStartedAtEventId=Some(eventId), increment currentTurnNumber

**Issue:** When is turnNumber determined?
- In processBatch (line 139): `const turnNumber = state.reducedContext.currentTurnNumber`
- But currentTurnNumber is incremented when AgentTurnStartedEvent is REDUCED
- So the turnNumber used for the event is BEFORE the increment

**This is correct** - use current number, then increment on reduce.

### 3. ✅ Parent Event Linking

**From makeEventMeta (line 118):**
```typescript
parentEventId: state.reducedContext.agentTurnStartedAtEventId
```

**Question:** Does this correctly link ALL events during a turn?

**Answer:** Yes, but only if agentTurnStartedAtEventId is set properly:
- AgentTurnStartedEvent should set `agentTurnStartedAtEventId = Option.some(startEvent.id)`
- All subsequent events inherit this as parentEventId
- AgentTurnCompletedEvent/Failed reset to `Option.none()`

This creates a chain where all events in a turn point back to the AgentTurnStartedEvent.

### 4. ⚠️ Missing: How to Interrupt Current Fiber

**In actor-implementation-sketch.ts:**
The processBatch effect (lines 132-183) doesn't store its fiber anywhere.
The background fiber (lines 208-219) just runs processBatch but doesn't track individual turn fibers.

**To implement interruption, need:**
```typescript
const currentTurnFiberRef = yield* Ref.make<Option.Option<Fiber.RuntimeFiber<...>>>(Option.none())

// In background processing:
Stream.mapEffect(() =>
  Effect.gen(function*() {
    // Check if already processing
    const current = yield* Ref.get(currentTurnFiberRef)
    if (Option.isSome(current)) {
      yield* Fiber.interrupt(current.value)
    }

    // Fork new turn
    const turnFiber = yield* processBatch.pipe(Effect.fork)
    yield* Ref.set(currentTurnFiberRef, Option.some(turnFiber))
    yield* Fiber.await(turnFiber)
    yield* Ref.set(currentTurnFiberRef, Option.none())
  })
)
```

**This is a gap in the sketch** - needs to be filled during implementation.

---

## Recommendations

### Should You Migrate?

**Depends on requirements:**

| Requirement | Current Solution | Needs Migration? |
|-------------|------------------|------------------|
| Cancel in-flight requests | ❌ Not possible | ✅ Yes |
| Multiple agents | ❌ Not supported | ✅ Yes |
| Event sourcing / replay | ❌ Limited | ✅ Yes |
| Turn lifecycle tracking | ❌ No events | ✅ Yes |
| Observability | ⚠️ Basic logging | ✅ Yes |
| Production scale | ✅ Fine for single-user CLI | ⚠️ Maybe |
| Multi-tenant | ❌ Not designed for it | ✅ Yes |

**If this is a CLI tool for personal use:** Current implementation is fine.

**If this will be a service or multi-user system:** Migration is worth it.

### Migration Strategy

**Option A: Big Bang Migration (10-15 days)**
- Implement full architecture at once
- Cut over when complete
- Higher risk, faster delivery

**Option B: Incremental (15-20 days)**
1. Phase 1: Add EventStore, keep ContextService
2. Phase 2: Add EventReducer, migrate ContextService to use it
3. Phase 3: Add MiniAgent, run both systems side-by-side
4. Phase 4: Migrate CLI to actors
5. Phase 5: Add interruption support
6. Phase 6: Remove old ContextService

**Recommendation:** Option A if this is greenfield or low usage. Option B if you need to maintain stability.

### Implementation Order

**Critical path:**
1. EventStore + EventReducer (foundation)
2. MiniAgent basic actor (without interruption)
3. CLI integration (prove the model works)
4. Add interruption (enhancement)
5. Add AgentRegistry (multi-agent support)

**Defer until later:**
- Parallel LLM requests
- Advanced reducers (truncating, summarizing)
- Agent forking
- Distribution (@effect/cluster)

---

## Conclusion

The proposed architecture represents a **major architectural shift** from a simple synchronous request-response model to a **full actor-based system** with rich event lifecycle and interruption support.

**Key Takeaways:**

1. ✅ **Architecture is sound** - uses well-established Effect patterns
2. ⚠️ **Interruption handling not fully specified** - needs Ref to track current turn fiber
3. ❌ **Not compatible with current code** - requires significant rewrite
4. ✅ **Migration is feasible** - 10-15 days estimated
5. ⚠️ **Behavioral changes** - fire-and-forget addEvent, debouncing delay, live streams
6. ✅ **Enables future features** - multi-agent, event sourcing, distribution

**Next Steps:**

1. **Decide:** Is interruption support + multi-agent + event sourcing worth 10-15 days?
2. **If yes:** Follow Phase 1 (Foundation) → build EventStore + EventReducer + Agent
3. **If no:** Stay with current simple implementation, add features incrementally

The architecture is well-designed and the migration is straightforward, but it's a significant investment. Make sure the benefits align with your roadmap.
