# Code Mode Integration Plan

## Overview

Integrate the TypeScript sandbox (`code-mode/`) into the mini-agent actor architecture, leveraging OpenTUI's syntax-highlighted Code component for TUI rendering.

## Current State

### Code Mode (Standalone)
- Location: `src/code-mode/`
- Pipeline: TypeScript → type-check → transpile → validate → execute
- Services: `TypeChecker`, `Transpiler`, `Validator`, `Executor`
- Security: static analysis blocks imports, eval, constructor chains, etc.
- API: `CodeMode.run(typescript, ctx, config)` returns `ExecutionResult`

### Actor Architecture (Main)
- Events flow through `MiniAgent` actors
- `ContextEvent` union defines all event types
- `feedReducer` in OpenTUI chat maps events to UI items
- `ChatUI` service orchestrates TUI interaction

### OpenTUI Capabilities
- `SyntaxStyle` class for syntax highlighting
- Tree-Sitter integration for language parsing
- **Code Renderable** component for syntax-highlighted source code
- Flexbox layout, scrolling, mouse/keyboard input

## Integration Design

### 1. New Event Types

Add to `src/domain.ts`:

```typescript
// Code editing events
class CodeBlockStartEvent extends Schema.TaggedClass<CodeBlockStartEvent>()(
  "CodeBlockStartEvent",
  { ...BaseEventFields, language: Schema.String, initialCode: Schema.String }
)

class CodeBlockUpdateEvent extends Schema.TaggedClass<CodeBlockUpdateEvent>()(
  "CodeBlockUpdateEvent",
  { ...BaseEventFields, code: Schema.String }
)

class CodeBlockEndEvent extends Schema.TaggedClass<CodeBlockEndEvent>()(
  "CodeBlockEndEvent",
  { ...BaseEventFields, finalCode: Schema.String }
)

// Execution events
class CodeExecutionStartedEvent extends Schema.TaggedClass<CodeExecutionStartedEvent>()(
  "CodeExecutionStartedEvent",
  { ...BaseEventFields, codeHash: Schema.String }
)

class CodeExecutionResultEvent extends Schema.TaggedClass<CodeExecutionResultEvent>()(
  "CodeExecutionResultEvent",
  {
    ...BaseEventFields,
    codeHash: Schema.String,
    success: Schema.Boolean,
    result: Schema.optionalWith(Schema.Unknown, { as: "Option" }),
    error: Schema.optionalWith(Schema.String, { as: "Option" }),
    durationMs: Schema.Number
  }
)

// Type checking events (optional, for real-time feedback)
class TypeCheckResultEvent extends Schema.TaggedClass<TypeCheckResultEvent>()(
  "TypeCheckResultEvent",
  {
    ...BaseEventFields,
    codeHash: Schema.String,
    success: Schema.Boolean,
    diagnostics: Schema.Array(Schema.Struct({
      line: Schema.Number,
      column: Schema.Number,
      message: Schema.String,
      severity: Schema.Literal("error", "warning")
    }))
  }
)
```

### 2. OpenTUI Code Component

Create `src/cli/components/code-block.tsx`:

```tsx
import { SyntaxStyle, RGBA } from "@opentui/core"
import { memo } from "react"

const typescriptSyntaxStyle = SyntaxStyle.fromStyles({
  keyword: { fg: RGBA.fromHex("#C792EA") },      // purple
  string: { fg: RGBA.fromHex("#C3E88D") },       // green
  number: { fg: RGBA.fromHex("#F78C6C") },       // orange
  comment: { fg: RGBA.fromHex("#676E95") },      // gray
  function: { fg: RGBA.fromHex("#82AAFF") },     // blue
  type: { fg: RGBA.fromHex("#FFCB6B") },         // yellow
  variable: { fg: RGBA.fromHex("#A6ACCD") },     // light gray
  default: { fg: RGBA.fromHex("#EEFFFF") },      // white
})

interface CodeBlockProps {
  code: string
  language: "typescript" | "javascript"
  diagnostics?: Array<{ line: number; message: string; severity: "error" | "warning" }>
  showLineNumbers?: boolean
  status?: "editing" | "executing" | "complete" | "error"
}

export const CodeBlock = memo<CodeBlockProps>(({
  code,
  language,
  diagnostics = [],
  showLineNumbers = true,
  status = "complete"
}) => {
  // Tree-sitter parsing + syntax highlighting
  // Line gutter with diagnostics markers
  // Status indicator (spinner for executing)

  return (
    <box flexDirection="column" width="100%" border padding={1}>
      <box flexDirection="row" marginBottom={1}>
        <text fg="#888">{language}</text>
        <box flexGrow={1} />
        {status === "executing" && <text fg="#FFCB6B">⏳ Running...</text>}
        {status === "error" && <text fg="#FF5555">✗ Error</text>}
        {status === "complete" && <text fg="#5ABF7A">✓ Done</text>}
      </box>

      <code
        language={language}
        syntaxStyle={typescriptSyntaxStyle}
        lineNumbers={showLineNumbers}
        diagnostics={diagnostics.map(d => ({
          line: d.line,
          sign: d.severity === "error" ? "!" : "?",
          color: d.severity === "error" ? "#FF5555" : "#FFCB6B"
        }))}
      >
        {code}
      </code>

      {diagnostics.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          {diagnostics.map((d, i) => (
            <text key={i} fg={d.severity === "error" ? "#FF5555" : "#FFCB6B"}>
              L{d.line}: {d.message}
            </text>
          ))}
        </box>
      )}
    </box>
  )
})
```

### 3. Feed Reducer Extension

Update `feedReducer` in `opentui-chat.tsx` to handle code events:

```typescript
// New FeedItem types
class CodeBlockItem extends Schema.TaggedClass<CodeBlockItem>()("CodeBlockItem", {
  id: Schema.String,
  code: Schema.String,
  language: Schema.String,
  status: Schema.Literal("editing", "executing", "complete", "error"),
  result: Schema.optionalWith(Schema.Unknown, { as: "Option" }),
  error: Schema.optionalWith(Schema.String, { as: "Option" }),
  diagnostics: Schema.Array(Schema.Struct({
    line: Schema.Number,
    message: Schema.String,
    severity: Schema.Literal("error", "warning")
  })),
  ...TimestampFields
})

// In feedReducer switch:
case "CodeBlockStartEvent":
  return [...items, new CodeBlockItem({
    id: crypto.randomUUID(),
    code: event.initialCode,
    language: event.language,
    status: "editing",
    result: Option.none(),
    error: Option.none(),
    diagnostics: [],
    ...timestampFields
  })]

case "CodeBlockUpdateEvent":
  // Update existing code block
  return items.map(item =>
    item._tag === "CodeBlockItem" && item.status === "editing"
      ? new CodeBlockItem({ ...item, code: event.code })
      : item
  )

case "CodeExecutionStartedEvent":
  return items.map(item =>
    item._tag === "CodeBlockItem" && item.status === "editing"
      ? new CodeBlockItem({ ...item, status: "executing" })
      : item
  )

case "CodeExecutionResultEvent":
  return items.map(item =>
    item._tag === "CodeBlockItem" && item.status === "executing"
      ? new CodeBlockItem({
          ...item,
          status: event.success ? "complete" : "error",
          result: event.result,
          error: event.error
        })
      : item
  )

case "TypeCheckResultEvent":
  return items.map(item =>
    item._tag === "CodeBlockItem"
      ? new CodeBlockItem({ ...item, diagnostics: event.diagnostics })
      : item
  )
```

### 4. Code Execution Service

Create `src/code-execution.ts`:

```typescript
import { Effect, Layer, Stream } from "effect"
import { CodeMode, CodeModeLive } from "./code-mode/index.ts"
import { AgentName, ContextEvent, ContextName, makeBaseEventFields } from "./domain.ts"

export class CodeExecutionService extends Effect.Service<CodeExecutionService>()(
  "@mini-agent/CodeExecutionService",
  {
    effect: Effect.gen(function*() {
      const codeMode = yield* CodeMode

      const executeCode = Effect.fn("CodeExecutionService.executeCode")(
        function*<TCtx extends object>(
          typescript: string,
          ctx: TCtx,
          agentName: AgentName,
          contextName: ContextName,
          nextEventNumber: number
        ): Stream.Stream<ContextEvent> {
          const baseFields = (trigger: boolean, offset: number) =>
            makeBaseEventFields(agentName, contextName, nextEventNumber + offset, trigger)

          yield* Effect.logDebug("Starting code execution", { codeLength: typescript.length })

          return Stream.make(
            new CodeExecutionStartedEvent({
              ...baseFields(false, 0),
              codeHash: "pending"
            })
          ).pipe(
            Stream.concat(
              Stream.fromEffect(
                codeMode.run(typescript, ctx).pipe(
                  Effect.map(result => new CodeExecutionResultEvent({
                    ...baseFields(false, 1),
                    codeHash: result.hash ?? "unknown",
                    success: true,
                    result: Option.some(result.value),
                    error: Option.none(),
                    durationMs: result.durationMs
                  })),
                  Effect.catchAll(error => Effect.succeed(new CodeExecutionResultEvent({
                    ...baseFields(false, 1),
                    codeHash: "error",
                    success: false,
                    result: Option.none(),
                    error: Option.some(String(error)),
                    durationMs: 0
                  })))
                )
              )
            )
          )
        }
      )

      return { executeCode }
    }),
    dependencies: [CodeModeLive]
  }
) {}
```

### 5. Integration Points

#### A. As Agent Tool
The LLM can emit code blocks that get executed:

```typescript
// In llm-turn.ts, detect code blocks in assistant messages
// Emit CodeBlockStartEvent + CodeBlockEndEvent
// CodeExecutionService picks up CodeBlockEndEvent and runs execution
```

#### B. As Interactive Mode
User types `/code` to enter code editing mode:

```typescript
// In chat-ui.ts
if (userMessage.startsWith("/code")) {
  // Enter code editing mode
  // Show CodeBlock component with editable code
  // On submit, execute and show results
}
```

#### C. Context Capabilities
Provide agent capabilities to executed code:

```typescript
const agentContext = {
  // Read from agent's reduced context
  getMessages: () => reducedContext.messages,

  // Send events back to agent
  sendMessage: (content: string) => agent.addEvent(new UserMessageEvent(...)),

  // Access filesystem (scoped)
  readFile: (path: string) => fs.readFileSync(path),

  // HTTP requests (with whitelist)
  fetch: (url: string) => fetch(url)
}

yield* codeMode.run(userCode, agentContext)
```

## Implementation Steps

### Phase 1: Events & Types
1. Add code-related events to `domain.ts`
2. Update `ContextEvent` union
3. Add `CodeBlockItem` to feed items

### Phase 2: OpenTUI Code Component
1. Create `src/cli/components/code-block.tsx`
2. Integrate Tree-Sitter for TypeScript syntax highlighting
3. Add diagnostics display with line markers

### Phase 3: Feed Reducer
1. Extend `feedReducer` for code events
2. Add `CodeBlockRenderer` component
3. Update `FeedItemRenderer` switch

### Phase 4: Execution Service
1. Create `CodeExecutionService`
2. Wire into agent layer
3. Add to CLI commands

### Phase 5: Interactive Features
1. `/code` command for code editing mode
2. Real-time type checking feedback
3. Result display (JSON pretty-print, tables)

## Open Questions

1. **Editor UX**: Full editor in terminal or just code paste + execute?
2. **Persistence**: Store code blocks in event stream or separate?
3. **Capabilities**: What should `ctx` provide? Filesystem? HTTP? Agent state?
4. **Security**: Per-execution timeouts? Memory limits? Capability revocation?

## Dependencies

- OpenTUI's Code component (verify existence/API)
- Tree-Sitter WASM for TypeScript grammar
- May need custom component if Code doesn't exist

## Testing

1. Unit tests for new events/reducers
2. Integration tests for code execution flow
3. E2E tests for TUI code block rendering
4. Security tests for sandbox escapes in agent context

## Notes

- Keep `code-mode/` as standalone module (testable without actor deps)
- Events are the interface; execution is fire-and-forget from agent
- TypeScript rendering is the showcase feature (syntax + types + execution)
