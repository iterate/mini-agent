

## Attempt 6 - Cleaner, shows harness implementation pattern

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                                 │
│                                    AGENT STREAM (per agent)                                     │
│                                                                                                 │
└───────▲─────────────────────────▲─────────────────────────▲─────────────────────────▲───────────┘
        │                         │                         │                         │
        │                         │                         │                         │
   slack:webhook-received    iterate:agent:harness:    iterate:agent:harness:    iterate:agent:harness:
   github:webhook-received     opencode:action:          opencode:action:          opencode:event-received
                               session-create-requested  prompt-requested          opencode:event-received
                                                                                   opencode:event-received
        │                         │                         │                         │
        │                         │                         │                         │
   from external             from harness              from Web/TUI              from harness
   (Slack, GitHub)           subscribers               (user sends message)      runtimes
                                                                                 (tool-call, assistant-msg,
                                                                                  streaming-chunk)
                                         │
                                         │ subscribe
                                         ▼
        ┌────────────────────────────────────────────────────────────────────────────────────────┐
        │                                                                                        │
        │                              HARNESS SUBSCRIBERS                                       │
        │                                                                                        │
        │           OpenCode          Claude           Pi            Iterate                     │
        │                                                                                        │
        │   A harness subscriber:                                                                │
        │   • Sees events on the stream                                                          │
        │   • Emits action events (e.g. prompt-requested) to control the harness                 │
        │   • Calls harness APIs when it sees action events                                      │
        │                                                                                        │
        └────────────────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         │ call harness API
                                         ▼
        ┌────────────────────────────────────────────────────────────────────────────────────────┐
        │                                                                                        │
        │                               HARNESS RUNTIMES                                         │
        │                                                                                        │
        │        OpenCode Server      Claude SDK/CLI      Pi Process       mini-agent            │
        │                                                                                        │
        │   Harness runtimes emit native events.                                                 │
        │   Subscribers wrap these as iterate:agent:harness:{name}:event-received                │
        │   and append back to stream.                                                           │
        │                                                                                        │
        └────────────────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         │ wrapped harness events
                                         │ (append to stream)
                                         │
                                         └──────────────────────────────────────────────────────►┐
                                                                                                 │
        ┌────────────────────────────────────────────────────────────────────────────────────────┤
        │                                                                                        │
        │                                    RENDERERS                                           │
        │                                                                                        │
        │                        CLI / TUI                      Web UI                           │
        │                                                                                        │
        │   Renderers subscribe to the stream and display events.                                │
        │   They can also append action events (e.g. user types a message).                      │
        │                                                                                        │
        └────────────────────────────────────────────────────────────────────────────────────────┘
                                         │
                                         │ control events (user sends message)
                                         │ iterate:agent:harness:opencode:action:prompt-requested
                                         │
                                         └──────────────────────────────────────────────────────►┘
                                                          (append to stream)
```

**Key insight**: A harness implementation is just a subscriber that:
1. Reacts to events by emitting action events (control the harness)
2. Calls harness APIs when it sees action events
3. Wraps harness output and appends back to stream

