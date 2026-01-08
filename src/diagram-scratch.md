# Architecture Diagram Scratch Pad

## Attempt 7 - Simplified bidirectional

```
                                              External events
                                              (slack:webhook-received, github:webhook-received)
                                                            │
                                                            ▼
┌───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                                                                                                   │
│                                            AGENT STREAM (per agent)                                               │
│                                                                                                                   │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                        │                      ▲                                       │                      ▲
                        │                      │                                       │                      │
               subscribe│                      │publish                       subscribe│                      │publish
                        │                      │action events                          │                      │control events
                        │                      │(prompt-requested,                     │                      │(prompt-requested)
                        │                      │ session-create-requested)             │                      │
                        │                      │wrapped harness events                 │                      │
                        │                      │(opencode:event-received)              │                      │
                        ▼                      │                                       ▼                      │
┌──────────────────────────────────────────────────────────────────────┐    ┌─────────────────────────────────────┐
│                                                                      │    │                                     │
│                         HARNESS SUBSCRIBERS                          │    │             RENDERERS               │
│                            (our code)                                │    │                                     │
│                                                                      │    │          Web UI    CLI/TUI          │
│              OpenCode    Claude    Pi    Iterate                     │    │                                     │
│                                                                      │    │   Subscribe to stream, display      │
│   Subscribe to stream, emit action events,                           │    │   events. User types message →      │
│   call harness APIs, wrap harness output                             │    │   publish control event.            │
│                                                                      │    │                                     │
└──────────────────────────────────────────────────────────────────────┘    └─────────────────────────────────────┘
                        │                      ▲
                        │                      │
                call API│                      │subscribe to
                        │                      │harness events
                        ▼                      │
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│                          HARNESS RUNTIMES                            │
│                           (their code)                               │
│                                                                      │
│              OpenCode Server    Claude SDK    Pi Process    mini-agent
│                                                                      │
│   Native agent runtimes. Emit their own events.                      │
│   We subscribe to these and wrap them.                               │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

**The pattern:**
- External events → Agent Stream (only external input)
- Harness Subscribers ←→ Agent Stream (subscribe + publish action events + wrapped harness events)
- Renderers ←→ Agent Stream (subscribe + publish control events)
- Harness Subscribers ←→ Harness Runtimes (call API + subscribe to their events)
- Harness Runtimes do NOT touch Agent Stream directly
