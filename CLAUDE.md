---
description: Effect-TS CLI project conventions and patterns
globs: "*.ts, *.tsx, package.json"
alwaysApply: true
---
# General

- Sacrifice grammar in favour of concision. Write like a good software engineer would write to another.
- Comments and documentation must be standalone - readable without knowledge of prior versions. Never write "now simplified to X", "previously was Y", "changed from Z". Describe what IS, not what changed.
- Never give time estimates for how long tasks would take humans. Focus on implementation steps and actions, not timelines.

# What we're building

See README.md for context

# Typescript

- Use bun as runtime and package manager
- Run CLI using `bun run mini-agent` (includes doppler for env vars)
- kebab-case filenames
- tests using vitest; colocate test files with .test.ts
- import using .ts extension; no .js
- Use comments sparingly to explain any additional context and "why" that isn't evident from the code. Don't redundantly describe the code below.
- No banner comments (e.g. `// ===== Section Name =====`). Use whitespace and JSDoc to organize code.
- DO NOT use nodejs imports like node:fs etc - you must use @effect/platform/FileSystem and @effect/platform/Path instead (read source if you need to grok it). Exception: test fixtures in `test/fixtures.ts` may use node:* imports for test infrastructure.
- Acronyms in identifiers use PascalCase, not ALL_CAPS: `LlmConfig` not `LLMConfig`, `HttpClient` not `HTTPClient`

## Scripts

- `bun run typecheck` — tsc only
- `bun run lint` / `bun run lint:fix` — eslint only
- `bun run check` — typecheck + lint
- `bun run check:fix` — typecheck + lint:fix
- `doppler run -- bun run test` — vitest (requires Doppler for API keys)
- `doppler run -- bun run test:watch` — vitest watch mode

## Pull Requests

Before committing and pushing code, you must run:
```bash
bun run check:fix
```

This runs typecheck + linter with auto-fix. Commit any resulting changes before pushing.

Also make sure to amend the pull request description using the `gh` utility each time you push.

## Use of effect

<!-- effect-solutions:start -->
## Effect Solutions Usage

- `effect-solutions list` - List all available topics
- `effect-solutions show <slug...>` - Read one or more topics
- `effect-solutions search <term>` - Search topics by keyword

**Local Effect Source:** `~/src/github.com/Effect-TS/effect`
<!-- effect-solutions:end -->

**Effect Patterns Knowledge Base:** Cross-reference with `~/src/github.com/PaulJPhilp/EffectPatterns` for community patterns in `content/` and `packages/`.


## Services with Effect.Service

Use `Effect.Service` for service definitions. It combines tag, implementation, and layer generation:

```typescript
class MyService extends Effect.Service<MyService>()("@mini-agent/MyService", {
  effect: Effect.gen(function*() {
    const dep = yield* SomeDependency
    return {
      doSomething: (input: string) => Effect.succeed(`result: ${input}`)
    }
  }),
  dependencies: [SomeDependency.Default]
}) {}

// Auto-generated: MyService.Default (includes dependencies)
// Usage:
Effect.provide(program, MyService.Default)
```

For simple services without dependencies:

```typescript
class Config extends Effect.Service<Config>()("@mini-agent/Config", {
  sync: () => ({
    logLevel: "info",
    apiUrl: "https://api.example.com"
  })
}) {}
```

**Test layers** use `Layer.succeed` with the service tag:

```typescript
const MyServiceTest = Layer.succeed(MyService, {
  doSomething: (input) => Effect.succeed(`mock: ${input}`)
})
```

**Tag identifiers** use package-scoped names: `@mini-agent/ServiceName`

## Prefer Schema Over Plain Types

Use `Schema` instead of plain TypeScript types for domain values. Schemas provide runtime validation, encoding/decoding, and type guards - plain types only exist at compile time.

```typescript
// ❌ Plain type - no runtime validation
type Status = "pending" | "active" | "done"

// ✅ Schema - runtime validation + type derivation
const Status = Schema.Literal("pending", "active", "done")
type Status = typeof Status.Type

// Use the schema for validation
const validateStatus = Schema.decodeUnknown(Status)
const isStatus = Schema.is(Status)
```

This applies to:
- **Enums/Literals**: `Schema.Literal("a", "b", "c")` over `type T = "a" | "b" | "c"`
- **Domain objects**: `Schema.Struct({...})` or `Schema.TaggedClass` over `interface`
- **Unions**: `Schema.Union(A, B, C)` over `type T = A | B | C`
- **Branded types**: `Schema.String.pipe(Schema.brand("UserId"))` over `string & { _brand: "UserId" }`

The pattern: define Schema first, derive type with `typeof Schema.Type`.

## Branded Types

Use branded types for domain identifiers to prevent mixing strings:

```typescript
export const ContextName = Schema.String.pipe(Schema.brand("ContextName"))
export type ContextName = typeof ContextName.Type

export const UserId = Schema.String.pipe(Schema.brand("UserId"))
export type UserId = typeof UserId.Type
```

## Schemas with TaggedClass

```typescript
export class UserMessage extends Schema.TaggedClass<UserMessage>()("UserMessage", {
  content: Schema.String
}) {}

// Type guard
export const isUserMessage = Schema.is(UserMessage)

// Union types - use Schema.Union for runtime encoding/decoding
export const Event = Schema.Union(UserMessage, SystemPrompt, AssistantMessage)
export type Event = typeof Event.Type
```

## Tagged Errors

Define domain errors with Schema.TaggedError for type-safe error handling:

```typescript
export class ContextNotFound extends Schema.TaggedError<ContextNotFound>()(
  "ContextNotFound",
  { name: ContextName }
) {}

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
  "ConfigurationError",
  { key: Schema.String, message: Schema.String }
) {}

// Union for error types
export const ContextError = Schema.Union(ContextNotFound, ContextLoadError)
export type ContextError = typeof ContextError.Type

// Typed error recovery
effect.pipe(
  Effect.catchTag("ContextNotFound", (e) => Effect.succeed(fallback)),
  Effect.catchTags({
    ContextNotFound: (e) => handleNotFound(e),
    ConfigurationError: (e) => handleConfig(e)
  })
)
```

## Config Service Pattern

```typescript
class AppConfig extends Context.Tag("@app/AppConfig")<
  AppConfig,
  {
    readonly apiKey: Redacted.Redacted
    readonly model: string
  }
>() {
  // Layer that loads from ConfigProvider
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.gen(function* () {
      const apiKey = yield* Config.redacted("API_KEY")
      const model = yield* Config.string("MODEL").pipe(
        Config.withDefault("gpt-4o-mini")
      )
      return { apiKey, model }
    })
  )

  // Test layer with mock values
  static readonly testLayer = Layer.succeed(AppConfig, {
    apiKey: Redacted.make("test-key"),
    model: "test-model"
  })
}
```

## Terminal Service (not direct process access)

Use Terminal service instead of `process.stdout.write`:

```typescript
import { Terminal } from "@effect/platform"

// ❌ Bad - direct process access
Effect.sync(() => process.stdout.write(text))

// ✅ Good - Terminal service
Effect.gen(function*() {
  const terminal = yield* Terminal.Terminal
  yield* terminal.display(text)
})
```

## Launching Commands

Use `@effect/platform` Command for subprocess execution. Pipe stdin with `Command.stdin(Stream)`, capture output with `Command.string` / `Command.lines` / `Command.stream`:

```typescript
import { Command } from "@effect/platform"
import { Stream } from "effect"

// Run command with stdin input
const output = yield* Command.make("cat").pipe(
  Command.stdin(Stream.make(Buffer.from("hello\n", "utf-8"))),
  Command.string
)

// Stream output line by line
const lines = Command.streamLines(Command.make("ls", "-la"))
```

## Logging vs User Output

Two different output mechanisms:

**`Effect.log*`** = Observability logging (timestamps, levels, goes to file)
```typescript
yield* Effect.log("Processing request")      // info (stdout + file)
yield* Effect.logDebug("Detailed state")     // debug (file only by default)
yield* Effect.logWarning("Retrying...")      // warn
yield* Effect.logError("Failed", { error })  // error with structured data
```

**`Console.log/error`** = Direct user output (chat messages, JSON, prompts)
```typescript
yield* Console.log(assistantMessage)  // User-facing output
yield* Console.error("Error: ...")    // User-visible error
```

Config defaults: stdout=warn, file=debug (in `.mini-agent/logs/`).

For errors, do BOTH - log for observability AND show user:
```typescript
Effect.logError("Request failed", { error }).pipe(
  Effect.flatMap(() => Console.error(`Error: ${error}`))
)
```

## Log Annotations and Spans

**Annotations** add structured metadata to all logs within an effect scope. Use `Effect.annotateLogs` to attach key-value pairs (e.g., requestId, userId) that appear in every log emitted by nested effects.

**Spans** track execution duration. Wrap an effect with `Effect.withLogSpan("label")` to automatically include timing in logs—useful for performance debugging.

```typescript
const program = Effect.gen(function*() {
  yield* Effect.log("Starting")
  yield* doWork()
  yield* Effect.log("Done")
}).pipe(
  Effect.annotateLogs({ requestId: "abc123", userId: "user42" }),
  Effect.withLogSpan("processRequest")
)
// Logs include: requestId=abc123 userId=user42 processRequest=152ms
```

See [Effect logging docs](https://effect.website/docs/observability/logging/#log-spans) for details.

## Vitest test Fixtures (test/fixtures.ts)

Use `test` from `./fixtures.js` for e2e tests needing isolated temp directories:

```typescript
import { test, expect } from "./fixtures.js"

test("my test", async ({ testDir }) => {
  // testDir is a unique temp directory for this test
  // Files written here are preserved for debugging
})
```

Suite directory logged once per file; test directory only logged on failure.

## Testing with testLayer

Use `Layer.sync` for test layers (cleaner than `Layer.effect(Effect.sync(...))`):

```typescript
import { describe, expect, it } from "@effect/vitest"

describe("MyService", () => {
  // Each test gets fresh layer - no state leakage
  it.effect("does something", () =>
    Effect.gen(function*() {
      const service = yield* MyService
      const result = yield* service.doSomething("input")
      expect(result).toBe("expected")
    }).pipe(Effect.provide(MyService.testLayer))
  )
})
```

**Test layer pattern:**
```typescript
static readonly testLayer = Layer.sync(MyService, () => {
  // Mutable state is fine in tests - JS is single-threaded
  const store = new Map<string, Data>()
  
  return MyService.of({
    get: (key) => Effect.succeed(store.get(key)),
    set: (key, value) => Effect.sync(() => void store.set(key, value))
  })
})
```

## Layer Memoization

Layers are memoized by reference. Functions returning layers defeat memoization—each call creates a new object, causing duplicate construction, resource leaks, and inconsistent state.

```typescript
// ❌ Factory function - new reference each call
const makeDatabase = () => Layer.effect(Database, ...)
makeDatabase() === makeDatabase()  // false

// ✅ Module-level constant - single reference
export const DatabaseLive = Layer.effect(Database, ...)
```

For parameterized layers, call factory once and export the result:
```typescript
const createDbLayer = (url: string) => Layer.scoped(Database, ...)
export const ProductionDb = createDbLayer(process.env.DB_URL!)
```

## Common Patterns

**Generator vs Pipe**: Use `Effect.gen` for business logic with control flow; use `pipe()` for linear transformations.

**Service interfaces don't leak dependencies** - dependencies are resolved in the layer, not exposed in the service interface.

**Effect.fn for tracing**: Wrap service methods with `Effect.fn("ServiceName.methodName")` for automatic span creation.

---

# OpenTUI Reference

**TypeScript TUI library by SST** | Zig native backend | Yoga flexbox | React reconciler

⚠️ **NOT PRODUCTION READY** - active development, APIs may change

**Repo:** github.com/sst/opentui | **v0.1.57** (Dec 2025) | MIT License

## tsconfig.json

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@opentui/react",
    "moduleResolution": "bundler"
  }
}
```

## Minimal React App

```tsx
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

const renderer = await createCliRenderer()
createRoot(renderer).render(<text>Hello world</text>)
```

## Components & Props

### `<box>` - Container/Layout

```tsx
<box
  // Layout (Yoga flexbox)
  width={50}              // number (cells) | "50%" | "auto"
  height={20}
  minWidth={10}
  maxWidth={100}
  flexDirection="row"     // "row" | "column" | "row-reverse" | "column-reverse"
  flexGrow={1}
  flexShrink={0}
  flexBasis="auto"
  alignItems="center"     // "flex-start" | "center" | "flex-end" | "stretch"
  justifyContent="center" // "flex-start" | "center" | "flex-end" | "space-between" | "space-around"
  alignSelf="auto"
  gap={1}
  padding={1}             // number | {top, bottom, left, right}
  paddingTop={1}
  margin={1}
  position="relative"     // "relative" | "absolute"
  top={0} left={0}        // for absolute positioning
  zIndex={1}              // ⚠️ always set explicitly for overlays
  
  // Appearance
  backgroundColor="blue"  // color name | hex
  borderStyle="single"    // "single" | "double" | "rounded" | "heavy" | "none"
  borderColor="white"
  
  // Events
  onLayout={(layout) => {}} // {x, y, width, height}
/>
```

### `<text>` - Text Display

```tsx
<text
  content="Hello"         // or use children: <text>Hello</text>
  width={20}
  padding={1}
  fg="white"              // foreground color
  bg="black"              // background color
  bold={true}
  italic={true}
  underline={true}
  strikethrough={true}
  wrap="word"             // "word" | "char" | "none"
/>

// Inline modifiers
<text>
  <span fg="red">Red</span>
  <strong>Bold</strong>
  <em>Italic</em>
  <u>Underline</u>
  <b fg="blue">Bold blue</b>
  <i>Italic</i>
  <br/>
</text>
```

### `<scrollbox>` - Scrollable Container

```tsx
<scrollbox
  width={40}
  height={10}
  scrollX={true}          // enable horizontal scroll
  scrollY={true}          // enable vertical scroll (default)
  scrollPosition={0}      // controlled scroll position
  onScroll={(pos) => {}}  // scroll callback
  flexGrow={1}
  padding={1}
>
  {/* content taller than height scrolls */}
</scrollbox>
```

⚠️ **Gotcha:** Nested scrollboxes have clipping bugs (#388)

### `<input>` - Single-Line Text Input

```tsx
<input
  value={text}
  defaultValue="initial"
  placeholder="Type here..."
  focused={true}          // whether input has focus
  password={true}         // mask characters
  disabled={false}
  onChange={(value) => setValue(value)}
  onSubmit={(value) => handleSubmit(value)}  // Enter key
  onFocus={() => {}}
  onBlur={() => {}}
  width={30}
  fg="white"
  bg="black"
  cursorColor="white"
/>
```

### `<textarea>` - Multi-Line Text Input

```tsx
<textarea
  value={text}
  defaultValue="initial\nmultiline"
  placeholder="Enter text..."
  focused={true}
  disabled={false}
  onChange={(value) => setValue(value)}
  onFocus={() => {}}
  onBlur={() => {}}
  width={40}
  height={10}
  fg="white"
  bg="black"
/>
```

### `<select>` - Dropdown Selection

```tsx
<select
  options={[
    { label: "Option 1", value: "opt1" },
    { label: "Option 2", value: "opt2" },
  ]}
  value="opt1"            // controlled
  defaultValue="opt1"     // uncontrolled
  focused={true}
  disabled={false}
  open={false}            // dropdown open state
  onChange={(value) => setSelected(value)}
  onOpen={() => {}}
  onClose={() => {}}
  width={20}
  fg="white"
  bg="black"
/>
```

### `<code>` - Syntax Highlighted Code

```tsx
import { RGBA, SyntaxStyle } from "@opentui/core"

<code
  content={codeString}
  filetype="typescript"   // language for highlighting
  syntaxStyle={SyntaxStyle.fromStyles({
    keyword: { fg: RGBA.fromHex("#ff6b6b"), bold: true },
    string: { fg: RGBA.fromHex("#51cf66") },
    comment: { fg: RGBA.fromHex("#868e96"), italic: true },
    number: { fg: RGBA.fromHex("#fab005") },
    function: { fg: RGBA.fromHex("#339af0") },
    type: { fg: RGBA.fromHex("#be4bdb") },
    default: { fg: RGBA.fromHex("#ffffff") },
  })}
  width={60}
  height={20}
  showLineNumbers={true}
  lineNumberFg="gray"
/>
```

**Requires peer dep:** `web-tree-sitter`

### Common Style Props (all components)

```tsx
// Colors: name or hex
fg="white"
bg="#1a1a2e"
backgroundColor="blue"
borderColor="gray"

// Available color names:
// black, red, green, yellow, blue, magenta, cyan, white
// brightBlack, brightRed, brightGreen, brightYellow, 
// brightBlue, brightMagenta, brightCyan, brightWhite
```

### Common Layout Props (all components)

```tsx
width={number | string}
height={number | string}
minWidth / maxWidth / minHeight / maxHeight
padding / paddingTop / paddingBottom / paddingLeft / paddingRight
margin / marginTop / marginBottom / marginLeft / marginRight
flexDirection / flexGrow / flexShrink / flexBasis
alignItems / justifyContent / alignSelf
gap
position / top / left / right / bottom
zIndex
```

## React Hooks

```tsx
import { useKeyboard, useRenderer, useTerminalDimensions, useOnResize } from "@opentui/react"

// Keyboard
useKeyboard((key) => {
  if (key.name === "escape") process.exit(0)
})

// Terminal size
const { width, height } = useTerminalDimensions()

// Resize callback
useOnResize((w, h) => console.log(`${w}x${h}`))

// Renderer access
const renderer = useRenderer()
renderer.console.show() // enable console logging
```

## Examples

### Exit on ESC

```tsx
import { useKeyboard } from "@opentui/react"

function App() {
  useKeyboard((key) => {
    if (key.name === "escape") process.exit(0)
  })
  return <text>Press ESC to exit</text>
}
```

### Track Pressed Keys (release events)

```tsx
const [pressed, setPressed] = useState<Set<string>>(new Set())

useKeyboard((e) => {
  setPressed(keys => {
    const n = new Set(keys)
    e.eventType === "release" ? n.delete(e.name) : n.add(e.name)
    return n
  })
}, { release: true })
```

### Form with Tab Navigation

```tsx
function LoginForm() {
  const [user, setUser] = useState("")
  const [pass, setPass] = useState("")
  const [focus, setFocus] = useState<"user"|"pass">("user")

  useKeyboard((k) => {
    if (k.name === "tab") setFocus(f => f === "user" ? "pass" : "user")
  })

  return (
    <box flexDirection="column" gap={1}>
      <box border borderColor={focus === "user" ? "blue" : "gray"}>
        <input focused={focus === "user"} onInput={setUser} placeholder="Username" />
      </box>
      <box border borderColor={focus === "pass" ? "blue" : "gray"}>
        <input focused={focus === "pass"} onInput={setPass} password placeholder="Password" />
      </box>
    </box>
  )
}
```

### Select Dropdown

```tsx
<select
  focused
  onChange={(_, opt) => setChoice(opt?.value)}
  showScrollIndicator
  options={[
    { name: "Small", description: "Tiny font", value: "sm" },
    { name: "Medium", description: "Normal", value: "md" },
    { name: "Large", description: "Big font", value: "lg" },
  ]}
  style={{ flexGrow: 1 }}
/>
```

### Scrollbox with Content

```tsx
<scrollbox width={40} height={10} style={{ border: true }}>
  {items.map((item, i) => <text key={i}>{item}</text>)}
</scrollbox>
```

### Responsive Layout

```tsx
const { width, height } = useTerminalDimensions()

<box flexDirection={width > 80 ? "row" : "column"}>
  <box flexGrow={1}><text>Main</text></box>
  <box width={width > 80 ? 20 : "100%"}><text>Sidebar</text></box>
</box>
```

### Console Logging (Debug)

```tsx
const renderer = useRenderer()

useEffect(() => {
  renderer.console.show()  // enable console panel
  console.log("Debug message")
}, [])
```

### Code with Syntax Highlighting

```tsx
import { RGBA, SyntaxStyle } from "@opentui/core"

const syntax = SyntaxStyle.fromStyles({
  keyword: { fg: RGBA.fromHex("#ff6b6b"), bold: true },
  string: { fg: RGBA.fromHex("#51cf66") },
  comment: { fg: RGBA.fromHex("#868e96"), italic: true },
  number: { fg: RGBA.fromHex("#ffd43b") },
  default: { fg: RGBA.fromHex("#fff") },
})

<code content={codeStr} filetype="typescript" syntaxStyle={syntax} />
```

### Line Numbers with Diff Markers

```tsx
import type { LineNumberRenderable } from "@opentui/core"

const ref = useRef<LineNumberRenderable>(null)

useEffect(() => {
  ref.current?.setLineColor(1, "#1a4d1a")                    // green bg
  ref.current?.setLineSign(1, { after: " +", afterColor: "#22c55e" })  // + sign
  ref.current?.setLineSign(4, { before: "⚠️", beforeColor: "#f59e0b" }) // warning
}, [])

<line-number ref={ref} content={code} filetype="ts" syntaxStyle={syntax} />
```

### Diff Viewer

```tsx
<diff
  oldContent={oldCode}
  newContent={newCode}
  oldFilename="old.ts"
  newFilename="new.ts"
  viewMode="split"        // "unified"|"split"
  syntaxStyle={syntax}
  wrap={true}
/>
```

### Box with Border & Padding

```tsx
<box
  border
  borderStyle="rounded"   // "single"|"double"|"rounded"|"heavy"
  borderColor="cyan"
  padding={1}
  backgroundColor="#1a1a2e"
>
  <text>Content here</text>
</box>
```

### Flexbox Layouts

```tsx
// Horizontal split
<box flexDirection="row" width="100%" height="100%">
  <box width={20} border><text>Sidebar</text></box>
  <box flexGrow={1} border><text>Main</text></box>
</box>

// Vertical with flex
<box flexDirection="column" height="100%">
  <box height={3}><text>Header</text></box>
  <box flexGrow={1}><text>Content</text></box>
  <box height={3}><text>Footer</text></box>
</box>

// Centered
<box width="100%" height="100%" justifyContent="center" alignItems="center">
  <text>Centered content</text>
</box>

// Three column
<box flexDirection="row" gap={1}>
  <box flexGrow={1}><text>Left</text></box>
  <box flexGrow={2}><text>Center (2x)</text></box>
  <box flexGrow={1}><text>Right</text></box>
</box>
```

### Absolute Positioning (Overlay)

```tsx
<box width="100%" height="100%">
  <text>Background content</text>
  <box position="absolute" top={5} left={10} zIndex={10} border backgroundColor="black">
    <text>Modal overlay</text>
  </box>
</box>
```

⚠️ Always set `zIndex` explicitly for overlays

### Common Debug Keys Pattern

```tsx
useKeyboard((k) => {
  if (k.name === "escape") process.exit(0)
  if (k.ctrl && k.name === "c") process.exit(0)
  if (k.name === "d" && k.ctrl) renderer.console.toggle()  // toggle debug console
})
```

## ⚠️ Critical Gotchas

### Rendering Bugs (open issues)

- **CJK chars corrupt** (#255)
- **Emoji artifacts** (#336)
- **Nested scrollbox clips wrong** (#388)
- **zIndex ignored** → always set explicit `zIndex` for layers (#332)

### Terminal Compatibility

- **Kitty graphics leaks** into tmux pane title (#334) → detection disabled v0.1.50
- **tmux** → use v0.1.55+ for 3.6 native OSC4 support
- **Zellij** → theme console errors (#4017)

### Input Issues

- **shift+space** broken on WezTerm (#380)
- Ctrl+A/E fixed v0.1.51 (was jumping to buffer start/end)

### State/Session

- Console not restored on exit (#293)
- Suspend (Ctrl+Z) screen switch broken (#283) - partially fixed v0.1.49
- External editor return → UI doesn't re-render (#3311)

### Framework-Specific

- **Effect-TS** teardown hooks blocked by OpenTUI import
- Top-level await blocks bytecode compilation (#355)

## Version Fixes Quick Reference

| Ver | Key Fixes |
|-----|-----------|
| 0.1.57 | configurable exit signals |
| 0.1.55 | tmux 3.6 OSC4, input modifier fix |
| 0.1.52 | key repeat fix |
| 0.1.51 | Ctrl+A/E nav |
| 0.1.50 | integer overflow, Kitty detection disabled |

**Always use latest version**

## Architecture (4 layers)

1. **Framework** (React) → declarative
2. **Component** (TS) → Renderable tree, Yoga layout
3. **FFI Bridge** (Bun dlopen) → JS↔Zig
4. **Native** (Zig) → double-buffer, ANSI, Unicode

## Key Dependencies

| Dep | Purpose |
|-----|---------|
| `yoga-layout` | flexbox |
| `jimp` | image processing |
| `web-tree-sitter` | syntax parse (peer dep) |

## Links

- **Repo:** github.com/sst/opentui
- **npm core:** npmjs.com/package/@opentui/core
- **npm react:** npmjs.com/package/@opentui/react
- **DeepWiki docs:** deepwiki.com/sst/opentui (best docs)
- **Awesome list:** github.com/msmps/awesome-opentui

## Real-World Projects Using OpenTUI

- **OpenCode** (opencode.ai) - AI coding agent (main reference impl)
- **terminal.shop** - terminal shopping

---