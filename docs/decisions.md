Decisions that I think are good and we should keep

### LLM requests
- Tracing via OTEL following https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-events/ 
- Always use streaming
- Avoid vendor specific stuff - we just like user/assistant messages with strings that we parse into codemode
- @effect/ai takes care of tracking input/output tokens and model choice in OTEL spans