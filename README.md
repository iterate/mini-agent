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

Use `--llm` (global option, before subcommand) or `LLM` env var:

```bash
# Via --llm flag (must come before subcommand)
bun run mini-agent --llm openai:gpt-4.1-mini chat -m "Hello"
bun run mini-agent --llm anthropic:claude-sonnet-4-5-20250929 chat

# Via env var
LLM=groq:llama-3.3-70b-versatile bun run mini-agent chat -m "Hello"
```

### Supported Providers & Models

**OpenAI** (`OPENAI_API_KEY`)
```
openai:gpt-4.1              # Latest GPT-4.1 (1M context)
openai:gpt-4.1-mini         # Default - fast and affordable
openai:gpt-4.1-nano         # Smallest/fastest
openai:gpt-4o               # Multimodal flagship
openai:gpt-4o-mini          # Lighter multimodal
openai:o3                   # Deep reasoning
openai:o4-mini              # Fast reasoning
openai:o1                   # Original reasoning model
```

**Anthropic** (`ANTHROPIC_API_KEY`)
```
anthropic:claude-opus-4-5-20251101      # Most capable
anthropic:claude-sonnet-4-5-20250929    # Best balance
anthropic:claude-haiku-4-5-20251001     # Fast and cheap
```

**Google Gemini** (`GEMINI_API_KEY`)
```
gemini:gemini-2.5-flash       # Best price-performance
gemini:gemini-2.5-flash-lite  # Fastest/cheapest
gemini:gemini-2.5-pro         # Advanced reasoning
gemini:gemini-2.0-flash       # 1M context workhorse
gemini:gemini-3-pro-preview   # Latest preview
```

**Groq** (`GROQ_API_KEY`) — Ultra-fast inference
```
groq:llama-3.3-70b-versatile  # Best Llama on Groq
groq:llama-3.1-8b-instant     # Fastest
groq:qwen/qwen3-32b           # Qwen 3 (preview)
```

**Cerebras** (`CEREBRAS_API_KEY`) — Fast inference
```
cerebras:llama-3.3-70b        # Llama 3.3
cerebras:llama-3.1-8b         # Fast Llama
cerebras:qwen-3-32b           # Qwen 3 hybrid reasoning
```

**OpenRouter** (`OPENROUTER_API_KEY`) — Multi-provider gateway
```
openrouter:deepseek/deepseek-chat-v3.1      # DeepSeek V3.1
openrouter:deepseek/deepseek-r1             # DeepSeek R1 reasoning
openrouter:anthropic/claude-sonnet-4        # Claude via OpenRouter
openrouter:google/gemini-2.5-pro-preview    # Gemini via OpenRouter
openrouter:qwen/qwen3-235b                  # Qwen 3 235B
```
Full list: https://openrouter.ai/models

### Custom Configuration

For unlisted models or custom endpoints, pass JSON:
```bash
LLM='{"apiFormat":"openai-responses","model":"my-model","baseUrl":"https://my-api.com/v1","apiKeyEnvVar":"MY_KEY"}'
```

`apiFormat` options: `openai-responses`, `anthropic`, `gemini`

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
