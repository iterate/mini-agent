This project serves three goals:

1. I want to learn effect and evaluate it for use in [iterate](https://iterate.com)
2. I want to experiment with some ideas I've had about building agents
3. I am on parental leave, want to code but don't have enough time to do real work, so I do this

# What is this?


This is a CLI for chat agent that maintains persistent conversation contexts. You can have multiple named conversations, and each one keeps its full history.

**Interactive mode** (runs an agent loop until you Ctrl+C):

## LLM Configuration

Set the `LLM` environment variable to choose your model:

```bash
# Provider:model format
LLM=openai:gpt-4o-mini bun src/main.ts chat -n myconvo -m "Hello"
LLM=anthropic:claude-sonnet-4-20250514 bun src/main.ts chat -n myconvo -m "Hello"
LLM=gemini:gemini-1.5-flash bun src/main.ts chat -n myconvo -m "Hello"

# OpenAI-compatible providers
LLM=openrouter:openai/gpt-4o bun src/main.ts chat -n myconvo -m "Hello"
LLM=groq:llama-3.1-70b-versatile bun src/main.ts chat -n myconvo -m "Hello"

# Just model name (defaults to openai)
LLM=gpt-4o bun src/main.ts chat -n myconvo -m "Hello"
```

**Required API keys:**

| Provider | Env Var |
|----------|---------|
| openai | `OPENAI_API_KEY` |
| anthropic | `ANTHROPIC_API_KEY` |
| gemini | `GEMINI_API_KEY` |
| openrouter | `OPENROUTER_API_KEY` |
| groq | `GROQ_API_KEY` |

For custom endpoints, pass a JSON config:
```bash
LLM='{"apiFormat":"openai-responses","model":"my-model","baseUrl":"https://my-api.com/v1","apiKeyEnvVar":"MY_KEY"}'
```

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
