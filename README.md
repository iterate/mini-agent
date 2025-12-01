# What is this?

I have a few high level goals

- Learn a few new tools (effect, beads, various otel and LLM tracing providers,etc)
- Experiment with some simplified abstractions for our agentic harness

So I'm incrementally building a chat agent. Initially just a CLI that runs an agent loop, but I want to then add embryonic versions of everything we care about at iterate

- Different channels (voice, text message, etc)
- Codemode instead of tool calling (LLM responds with typescript code)
- Serialize agent state in file system
- Evals (agent evaling agent)
- Human in the loop approvals
- Event sourced agent design
- "Context rules are all you need" / iterate.config.ts
- Multi-user MCP client
- Hide secrets from LLM agents (via secret proxy)
- Deploy to cloudflare containers
