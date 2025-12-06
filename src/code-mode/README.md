# Code Mode

Executes untrusted TypeScript with controlled access to parent capabilities.

## Why It Exists

The agent needs to run LLM-generated code safely. Code mode provides:

1. **Capability injection** - Parent passes callbacks (e.g., `writeFile`, `runCommand`) that code can invoke
2. **Security boundaries** - Code cannot access filesystem, network, or process directly
3. **Timeout enforcement** - Runaway code gets terminated

## Architecture

```
TypeScript → Transpiler → JavaScript → Validator → Executor → Result
                                          ↓
                                    Security check
```

### Services

| Service | Purpose |
|---------|---------|
| `Transpiler` | TS→JS conversion (uses Bun's transpiler) |
| `Validator` | Static security analysis (blocks dangerous patterns) |
| `Executor` | Runs validated JS with injected context |
| `CodeMode` | Composite: transpile → validate → execute |

### Validator (Security Analysis)

The validator exists for SECURITY, not type-checking. TypeScript type-checks won't catch:

```typescript
// All of these type-check fine but are dangerous:
eval("process.exit(1)")
import('fs').then(fs => fs.rmSync('/'))
({}).__proto__.constructor('return process')().exit()
```

The validator blocks:

| Pattern | Why |
|---------|-----|
| `import`/`require` | No filesystem/network access |
| `eval`/`new Function()` | No sandbox escape |
| `__proto__`, `.constructor` | No prototype chain attacks |
| Undeclared globals | No `process`, `Bun`, `globalThis` access |

**Globals allowlist**: Only safe builtins like `Object`, `Array`, `Math`, `JSON`, `Promise` are accessible. Code trying to access `process` or `Bun` fails validation.

### Executor

Runs validated JavaScript with an injected `ctx` object:

```typescript
// User code receives:
ctx.callbacks  // Functions provided by parent (async, cross-boundary)
ctx.data       // Read-only data from parent
```

The unsafe executor uses `eval()` in the same V8 context. Security comes from the validator blocking dangerous constructs, not from process isolation.

## Usage

```typescript
import { CodeMode, CodeModeLive } from "./code-mode"

const result = yield* CodeMode.run<typeof callbacks, typeof data, string>(
  `export default async (ctx) => {
    const content = await ctx.callbacks.readFile("config.json")
    return JSON.parse(content).name
  }`,
  {
    callbacks: { readFile: (path) => fs.readFile(path, "utf-8") },
    data: { userId: "123" }
  }
)
```

## Files

```
code-mode/
├── README.md           # This file
├── index.ts            # Public exports
├── services.ts         # Service interfaces (Transpiler, Validator, Executor, CodeMode)
├── types.ts            # ParentContext, ExecutionResult, Config
├── errors.ts           # ValidationError, ExecutionError, TimeoutError
├── composite.ts        # CodeMode implementation (orchestrates pipeline)
└── implementations/
    ├── transpiler-bun.ts      # Uses Bun.Transpiler
    └── validator-acorn.ts     # AST-based security analysis
    └── executor-unsafe.ts     # eval()-based execution
```
