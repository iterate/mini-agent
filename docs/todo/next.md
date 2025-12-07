# CLI and Agent Interface Cleanup

## Overview

Fix naming inconsistencies and improve the MiniAgent interface. The key distinction:
- **agentName** = agent identity (stable, e.g., "chat", "assistant-1")
- **contextName** = context storage name (can change, e.g., "chat-v1", used for EventIds and file paths)

## 1. Rename `contextName` → `agentName` Where Misused

These places use `contextName` to mean agent identity - should be `agentName`:

### src/cli/chat-ui.ts
- Line 27: `function*(contextName: string)` → `function*(agentName: string)`
- Update usage on line 28: `getOrCreate(contextName as AgentName)` → `getOrCreate(agentName)`

### src/cli/commands.ts
- Line 127: `runEventStream(contextName: string, ...)` → `runEventStream(agentName: string, ...)`
- Line 134: remove cast `contextName as AgentName` → `agentName`
- Line 231: `scriptInteractiveLoop(contextName: string, ...)` → `scriptInteractiveLoop(agentName: string, ...)`
- Line 234: remove cast
- Line 373: `const contextName = ...` → `const agentName = ...`
- Lines 388, 398, 404, 410: update variable references

### src/cli/components/opentui-chat.tsx
- Line 544: `contextName: string` in ChatAppProps → `agentName: string`
- Line 550: update destructuring
- Line 631: `{contextName}` → `{agentName}` (UI displays "Agent: xxx")

### test/tty.e2e.test.ts
- Line 101: `const contextName = "my-special-context"` → `const agentName = "my-special-context"`
- Update all references in that test

## 2. MiniAgent Interface Renames

### Rename `subscribe` → `tapEventStream`

More descriptive name - taps into the live event stream.

**domain.ts:**
- Line 292: `readonly subscribe: ...` → `readonly tapEventStream: ...`

**mini-agent.ts:**
- Line 498: `subscribe: Effect.gen(...)` → `tapEventStream: Effect.gen(...)`

**Update usages (5 files, 6 instances):**
- `src/http-routes.ts`: lines 83, 135
- `src/layercode/layercode.adapter.ts`: line 177
- `test/mini-agent.test.ts`: lines 524, 543, 614

### Rename `getReducedContext` → `getState`

Simpler, clearer name.

**domain.ts:**
- Line 296: `readonly getReducedContext: ...` → `readonly getState: ...`

**mini-agent.ts:**
- Line 508: `getReducedContext: ...` → `getState: ...`

**Update usages (4 files, 7 instances):**
- `src/cli/chat-ui.ts`: lines 110, 153
- `src/cli/commands.ts`: lines 143, 251
- `src/http-routes.ts`: lines 73, 169
- `src/layercode/layercode.adapter.ts`: line 169

### Remove deprecated `events` property

Replace all usages with `tapEventStream`.

**domain.ts:**
- Delete lines 293-294 (the `events` property and @deprecated comment)

**mini-agent.ts:**
- Line 504: delete `events: broadcast,`
- Line 367: delete `yield* mailbox.end` (no longer needed)

**Update usages (2 files, 5 instances):**
- `src/cli/chat-ui.ts`: line 48 - change `agent.events.pipe(...)` to use `tapEventStream`
- `src/cli/commands.ts`: lines 157, 170, 264, 281 - same

## 3. Session Initialization - First Session Only

**File:** `src/mini-agent.ts`

Current behavior (lines 405-446): Always emits SessionStartedEvent, SetLlmConfigEvent, SystemPromptEvent.

**Change:**
- **SessionStartedEvent**: Always emit (marks new session boundary)
- **SetLlmConfigEvent**: Only if `existingEvents.length === 0` (first-ever session)
- **SystemPromptEvent**: Only if `existingEvents.length === 0` (first-ever session)

Add TODO comment: "If CLI llmConfig differs from agent's reduced config, emit SetLlmConfigEvent to update"

**Tests to update:**
- `test/tty.e2e.test.ts` lines 33-58: expects LlmConfig/SystemPrompt on every start
- `test/cli.e2e.test.ts` lines 170-190: expects all initial events in raw mode

## 4. Fix Trace Links and Goodbye Message

**File:** `src/cli/commands.ts`

Current code (around line 417):
```typescript
yield* chatUI.runChat(resolvedName).pipe(
  Effect.catchAllCause(() => Effect.void),
  Effect.ensuring(printTraceLinks.pipe(Effect.flatMap(() => Console.log("\nGoodbye!"))))
)
```

**Problems:**
1. `catchAllCause(() => Effect.void)` silently swallows all errors
2. If `printTraceLinks` fails, goodbye never prints (chained with flatMap)

**Fix:**
```typescript
yield* chatUI.runChat(resolvedName).pipe(
  Effect.ensuring(
    Effect.all([
      printTraceLinks.pipe(Effect.catchAll(() => Effect.void)),
      Console.log("\nGoodbye!")
    ], { discard: true })
  )
)
```

## 5. Make Modes Symmetrical

**File:** `src/cli/commands.ts`

- Add trace links to pipe mode (currently missing - around line 398)
- Ensure consistent error handling across single-turn, pipe, tty-interactive modes

## 6. Mailbox Pattern - Add Comment

**File:** `src/cli/chat-ui.ts`

Current code uses `Mailbox.make()` with `unsafeOffer`. This is correct (unbounded mailbox always succeeds).

Add comment explaining:
```typescript
// Unbounded mailbox - unsafeOffer always succeeds (idiomatic Effect pattern)
const mailbox = yield* Mailbox.make<ChatSignal>()
```

## Implementation Order

1. MiniAgent interface renames (`subscribe` → `tapEventStream`, `getReducedContext` → `getState`)
2. Remove deprecated `events`, update all usages to `tapEventStream`
3. Rename `contextName` → `agentName` where misused
4. Fix trace links/goodbye message
5. Make modes symmetrical
6. Session initialization - first session only + test updates
7. Add mailbox comment

## Files to Modify

**Core:**
- `src/domain.ts` (interface changes)
- `src/mini-agent.ts` (implementation + session init)

**CLI:**
- `src/cli/commands.ts`
- `src/cli/chat-ui.ts`
- `src/cli/components/opentui-chat.tsx`

**Adapters:**
- `src/http-routes.ts`
- `src/layercode/layercode.adapter.ts`

**Tests:**
- `test/mini-agent.test.ts`
- `test/tty.e2e.test.ts`
- `test/cli.e2e.test.ts`

## Testing

```bash
bun run check:fix        # typecheck + lint
doppler run -- bun run test  # all tests
```

Manual verification:
- `bun run mini-agent -n test-agent -m "hello"` (single-turn)
- `bun run mini-agent` (interactive mode)
- Verify trace links + goodbye print on exit
- Verify resumed sessions don't re-emit config/system prompt events
