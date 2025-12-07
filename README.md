CLI chat agent with persistent conversation contexts. Built with [Effect](https://effect.website/) and Bun.

## Quick Start

```bash
# Simple question
bun run mini-agent chat -m "What is 2+2?"

# Pipe content
echo "Explain this code" | bun run mini-agent chat

# Interactive mode (TTY)
bun run mini-agent chat

# Script mode (JSONL in/out)
cat examples/pirate.jsonl | bun run mini-agent chat --script
```

## Modes

| Mode | Trigger | Input | Output |
|------|---------|-------|--------|
| Single-turn | `-m "msg"` | CLI arg | Plain text |
| Pipe | piped stdin | Plain text | Plain text |
| Script | `--script` | JSONL events | JSONL events |
| Interactive | TTY stdin | Prompts | Plain text |

Add `--raw` for JSONL output. Add `-n name` to persist conversation.

## CLI Options

See [`src/cli/commands.ts`](src/cli/commands.ts) for full definitions.

| Option | Alias | Description |
|--------|-------|-------------|
| `--name` | `-n` | Context name (persists conversation) |
| `--message` | `-m` | Single message (non-interactive) |
| `--raw` | `-r` | Output as JSONL |
| `--script` | `-s` | JSONL in/out mode |
| `--show-ephemeral` | `-e` | Include streaming deltas |
| `--image` | `-i` | Attach image file or URL |
| `--config` | `-c` | YAML config file |
| `--cwd` | | Working directory |
| `--stdout-log-level` | | trace/debug/info/warn/error/none |
| `--llm` | | Provider:model (global, before subcommand) |

## LLM Configuration

Specify via `--llm` flag (before subcommand) or `LLM` env var. Format: `provider:model`

See [`src/llm-config.ts`](src/llm-config.ts) for provider definitions.

```bash
bun run mini-agent --llm openai:gpt-4.1-mini chat -m "Hello"
LLM=anthropic:claude-sonnet-4-5-20250929 bun run mini-agent chat
```

### Providers

| Provider | Env Var | Example Models |
|----------|---------|----------------|
| `openai` | `OPENAI_API_KEY` | `gpt-4.1-mini`, `gpt-4.1`, `o3`, `o4-mini` |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5-20250929`, `claude-opus-4-5-20251101` |
| `gemini` | `GEMINI_API_KEY` | `gemini-2.5-flash`, `gemini-2.5-pro` |
| `groq` | `GROQ_API_KEY` | `llama-3.3-70b-versatile`, `llama-3.1-8b-instant` |
| `cerebras` | `CEREBRAS_API_KEY` | `llama-3.3-70b`, `qwen-3-32b` |
| `openrouter` | `OPENROUTER_API_KEY` | `deepseek/deepseek-chat-v3.1`, `anthropic/claude-sonnet-4` |

Default: `openai:gpt-4.1-mini`

### Custom Endpoints

```bash
LLM='{"apiFormat":"openai-chat-completions","model":"my-model","baseUrl":"https://my-api.com/v1","apiKeyEnvVar":"MY_KEY"}'
```

`apiFormat`: `openai-responses` | `openai-chat-completions` | `anthropic` | `gemini`

## Event Types

See [`src/domain.ts`](src/domain.ts) for schema definitions.

**Input Events** (via stdin in script mode):
- `UserMessage` - User message content (output as `UserMessageEvent`)
- `SystemPrompt` - System behavior configuration (output as `SystemPromptEvent`)

**Output Events**:
- `TextDeltaEvent` - Streaming chunk (ephemeral)
- `AssistantMessageEvent` - Complete response (persisted)
- `AgentTurnStartedEvent` - LLM turn started
- `AgentTurnCompletedEvent` - LLM turn completed
- `AgentTurnInterruptedEvent` - Turn interrupted (partial response)

**Lifecycle Events** (persisted):
- `SessionStartedEvent` - Agent session started
- `SessionEndedEvent` - Agent session ended
- `SetLlmConfigEvent` - LLM configuration for context

## Script Mode

JSONL events on stdin, JSONL events on stdout. Useful for programmatic control.

```bash
# examples/pirate.jsonl
{"_tag":"SystemPrompt","content":"You are a pirate. Always respond in pirate speak."}
{"_tag":"UserMessage","content":"Hello, how are you?"}
```

```bash
cat examples/pirate.jsonl | bun run mini-agent chat --script -n pirate-demo
```

Output includes all events including streaming deltas by default.

### Interactive Named Pipe

```bash
# Terminal 1: create pipe and start agent
mkfifo /tmp/agent
while true; do cat /tmp/agent; done | bun run mini-agent chat --script -n live

# Terminal 2: send events
echo '{"_tag":"UserMessage","content":"Hello!"}' > /tmp/agent
```

## HTTP Server

```bash
bun run mini-agent serve --port 3000
```

Endpoints:
- `POST /context/:name` - Send JSONL body, receive SSE stream
- `GET /health` - Health check

See [`src/http.ts`](src/http.ts) for implementation.

## Configuration

Precedence: CLI args → Env vars → YAML config → Defaults

See [`src/config.ts`](src/config.ts) for all options.

```yaml
# mini-agent.config.yaml
llm: openai:gpt-4.1-mini
dataStorageDir: .mini-agent
stdoutLogLevel: warn
fileLogLevel: debug
port: 3000
host: 0.0.0.0
```

## Tracing

Multi-destination OTLP tracing to Honeycomb, Axiom, Sentry, Langfuse, and Traceloop.

See [`src/tracing.ts`](src/tracing.ts) for configuration. Set provider-specific env vars to enable.

## Architecture

See [`architecture/architecture.md`](architecture/architecture.md) for design overview and [`architecture/design.ts`](architecture/design.ts) for complete type definitions.

Core concept: A **Context** is a named, ordered list of events representing a conversation. Events reduce to state, state drives the agent.
