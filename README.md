CLI chat agent with persistent conversation contexts. Multiple named conversations, each keeping full history.

# Quick Start

```bash
# 1. Simple question
doppler run -- bun src/main.ts chat -m "What is 2+2?"

# 2. Pipe content
echo "Explain this" | doppler run -- bun src/main.ts chat

# 3. Interactive mode
doppler run -- bun src/main.ts chat

# 4. Script mode (JSONL events)
cat examples/pirate.jsonl | doppler run -- bun src/main.ts chat --script
```

# Script Mode Demo

Script mode accepts JSONL events on stdin. Example files in `examples/`:

```bash
# examples/pirate.jsonl
{"_tag":"SystemPrompt","content":"You are a pirate. Always respond in pirate speak."}
{"_tag":"UserMessage","content":"Hello, how are you?"}
```

Run it:
```bash
cat examples/pirate.jsonl | doppler run -- bun src/main.ts chat --script -n pirate-demo
```

Output (JSONL with streaming):
```json
{"_tag":"SystemPrompt","content":"You are a pirate..."}
{"_tag":"UserMessage","content":"Hello, how are you?"}
{"_tag":"TextDelta","delta":"Ahoy"}
{"_tag":"TextDelta","delta":" there"}
{"_tag":"TextDelta","delta":", matey!"}
...
{"_tag":"AssistantMessage","content":"Ahoy there, matey! I be doin' just fine..."}
```

### Interactive demo with named pipe

Keep a process running and send events from another terminal:

```bash
# Terminal 1: create pipe and start agent (loop keeps pipe alive)
mkfifo /tmp/agent
while true; do cat /tmp/agent; done | doppler run -- bun src/main.ts chat --script -n live-demo

# Terminal 2: send events one at a time
echo '{"_tag":"UserMessage","content":"Hello!"}' > /tmp/agent
# (watch Terminal 1 for response)
echo '{"_tag":"UserMessage","content":"What did I just say?"}' > /tmp/agent

# Cleanup: Ctrl+C in Terminal 1, then:
rm /tmp/agent
```

# Modes Overview

| Mode | Trigger | Input | Output |
|------|---------|-------|--------|
| Single-turn | `-m "msg"` | CLI arg | Plain text |
| Pipe | piped stdin | Plain text | Plain text |
| Script | `--script` | JSONL events | JSONL events |
| Interactive | TTY stdin | Prompts | Plain text |

Add `--raw` to any mode for JSONL output. Add `-n name` to persist context.

# Options

| Option | Alias | Description |
|--------|-------|-------------|
| `--name` | `-n` | Context name (persists conversation) |
| `--message` | `-m` | Single message (non-interactive) |
| `--raw` | `-r` | Output as JSONL |
| `--script` | `-s` | JSONL in/out |
| `--show-ephemeral` | `-e` | Include streaming deltas |
| `--image` | `-i` | Attach image file or URL |
| `--config` | `-c` | YAML config file |
| `--cwd` | | Working directory |
| `--stdout-log-level` | | trace/debug/info/warn/error/none |

# Event Types

Input:
- `{"_tag":"UserMessage","content":"..."}` - user says something
- `{"_tag":"SystemPrompt","content":"..."}` - set system behavior

Output:
- `UserMessage`, `SystemPrompt` - echoed input
- `TextDelta` - streaming chunks (included by default in script mode)
- `AssistantMessage` - final response

## LLM Configuration

Set `LLM` env var to one of the named presets:

```bash
LLM=gpt-4.1-mini        # OpenAI (default)
LLM=claude-haiku-4-5    # Anthropic
LLM=gemini-2.5-flash    # Google
```

Or pass JSON for custom config:
```bash
LLM='{"apiFormat":"openai-responses","model":"my-model","baseUrl":"https://my-api.com/v1","apiKeyEnvVar":"MY_KEY"}'
```

Requires `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GEMINI_API_KEY` depending on provider.

# Side quests (so far)

- Exploring different OTEL tracing providers - and learned about OTEL gen [AI conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events/)




I have a few high level goals

- Learn a few new tools (effect, beads, various otel and LLM tracing providers,etc)
- Experiment with some simplified abstractions for our agentic harness
- Make a system that is independent of any one LLM provider's high level abstractions ("just strings" would be ideal)

So I'm incrementally building a chat agent. Initially just a CLI that runs an agent loop, but I want to then add embryonic versions of everything we care about at iterate

- Different channels (voice, text message, etc)
- Codemode instead of tool calling (LLM responds with typescript code)
- Serialize agent state in file system
- Evals (agent evaling agent)
- Human in the loop approvals
- Event sourced agent design
- "Context rules are all you need" / iterate.config.ts / i18n style approach
- Multi-user MCP client
- Hide secrets from LLM agents (via secret proxy)
- Deploy to cloudflare containers
- sub-agents
- agents in long single threaded contexts (like whatsapp convo)
- client / non-confidential server / confidential server architecture where we can run the servers locally or on durable objects when deployed
- interruption and turn-taking behaviours
- tracing
- codemode that produces workflow code (for async tool calls and human in the loop approval)
- agents sending other agents messages
- bricking / disposing of broken contents with broken events
