# Unified LLM Abstraction: Consolidating Voice + Text

## The Core Insight

Both HTTP-based chat completions and WebSocket-based voice APIs fundamentally do the same thing:
**Turn conversation context into assistant responses as a stream of events.**

The differences are:
- **Transport**: HTTP request/response vs WebSocket bidirectional
- **State location**: Client-held (HTTP) vs Server-held (WebSocket)
- **Modality**: Text only vs Text + Audio
- **Granularity**: Per-turn vs Per-chunk

## Current Architecture Analysis

### HTTP Path (openai-chat-completions-client.ts)
```
LanguageModel.streamText({ prompt })
  → Stream<Response.StreamPartEncoded>
    → text-delta, tool-call, finish, etc.
```

### Voice Path (voice/client.ts)
```
GrokVoiceClient.connect(config)
  → GrokVoiceConnection {
      send: audio → Effect<void>
      sendText: text → Effect<void>
      audioOutput: Stream<Buffer>
      transcripts: Stream<string>
      events: Stream<unknown>
    }
```

### Agent Loop (llm-turn.ts)
```
MiniAgentTurn.execute(ctx: ReducedContext)
  → Stream<ContextEvent>
    → TextDeltaEvent, AssistantMessageEvent
```

## The Gap

The voice client exposes raw streams (audio buffers, transcripts) but doesn't:
1. Implement `LanguageModel` interface
2. Emit domain events (`ContextEvent`)
3. Track conversation turns
4. Support tool calling flow

## Four Proposed Approaches

### Proposal 1: Event-Driven Session

Everything is an event. Both transports emit unified `SessionEvent` types.

```typescript
type SessionEvent =
  | TextInputEvent | AudioInputEvent
  | TextOutputEvent | AudioOutputEvent
  | ToolCallEvent | ToolResponseEvent
```

**Pros**: Clean abstraction, type-safe events, natural for streaming
**Cons**: Forces event model on HTTP, memory growth, semantic mismatch

### Proposal 2: Dual-Mode Interface

Separate interfaces for each pattern. Don't force unification.

```typescript
interface RequestResponseLlm {
  complete: (req) => Effect<Stream<Chunk>>
}

interface StreamingSessionLlm {
  connect: Effect<{ send: Sink, receive: Stream }>
}
```

**Pros**: Semantic clarity, efficient per-transport
**Cons**: Code duplication, can't swap transport

### Proposal 3: Layered Abstraction (RECOMMENDED)

High-level session wraps low-level transport. Session handles state for stateless transports.

```typescript
// Agent interacts with this
class ConversationSession {
  sendText: (text) => Effect<void>
  sendAudio: (chunk) => Effect<void>
  sendToolResult: (id, result) => Effect<void>
  events: Stream<ConversationEvent>
}

// Transport implementations
interface LlmTransport {
  mode: "stateless" | "stateful"
  send?: (context) => Effect<Stream<ResponseEvent>>
  connect?: Effect<{ input: Sink, output: Stream }>
}
```

**Pros**: Unified agent code, transport-optimized implementations, swappable
**Cons**: Extra abstraction layer, potential feature leakage

### Proposal 4: Multi-Modal Stream Processor

Pure stream processing - everything in, everything out.

```typescript
process(input: {
  text?: Stream<string>,
  audio?: Stream<Buffer>,
  tools?: Stream<ToolResult>
}) => Effect<{
  text: Stream<string>,
  audio: Stream<Buffer>,
  toolCalls: Stream<ToolCall>
}>
```

**Pros**: Stream-native, composable, backpressure-aware
**Cons**: HTTP buffering awkward, complex debugging

## Recommended Design: Proposal 3

### Core Types

```typescript
// Unified conversation events
type ConversationEvent =
  | { _tag: "TextDelta"; delta: string }
  | { _tag: "TextComplete"; content: string }
  | { _tag: "AudioDelta"; chunk: Buffer }
  | { _tag: "AudioComplete" }
  | { _tag: "ToolCall"; id: string; name: string; params: unknown }
  | { _tag: "TurnComplete"; usage?: Usage }
  | { _tag: "Error"; error: Error }

// Conversation state
interface ConversationContext {
  messages: Prompt.Message[]
  config: LlmConfig
  turnNumber: number
}

// Transport interface
interface LlmTransport {
  readonly _tag: "stateless" | "stateful"
}

interface StatelessTransport extends LlmTransport {
  _tag: "stateless"
  complete: (ctx: ConversationContext, input: TurnInput)
    => Effect<Stream<ConversationEvent>>
}

interface StatefulTransport extends LlmTransport {
  _tag: "stateful"
  connect: Effect<StatefulConnection>
}

interface StatefulConnection {
  sendText: (text: string) => Effect<void>
  sendAudio: (chunk: Buffer) => Effect<void>
  sendToolResult: (id: string, result: unknown) => Effect<void>
  events: Stream<ConversationEvent>
  close: Effect<void>
}
```

### Session Layer

```typescript
class UnifiedSession extends Effect.Service<UnifiedSession>()(
  "@app/UnifiedSession",
  {
    effect: Effect.gen(function*() {
      const transport = yield* LlmTransport
      const state = yield* Ref.make<ConversationContext>(initialContext)
      const eventQueue = yield* Queue.unbounded<ConversationEvent>()

      // For stateful: establish connection once
      const connectionRef = transport._tag === "stateful"
        ? yield* transport.connect.pipe(Effect.map(Option.some), Ref.make)
        : yield* Ref.make<Option<StatefulConnection>>(Option.none())

      return {
        sendText: (text: string) => Effect.gen(function*() {
          if (transport._tag === "stateless") {
            // Add to context, send full context
            yield* state.update((ctx) => ({
              ...ctx,
              messages: [...ctx.messages, Prompt.userMessage(text)]
            }))
            const ctx = yield* state.get
            const stream = yield* transport.complete(ctx, { type: "text", text })
            yield* stream.pipe(
              Stream.runForEach((event) => Queue.offer(eventQueue, event))
            )
          } else {
            // Send text directly
            const conn = yield* connectionRef.get.pipe(Effect.flatMap(Option.getOrThrow))
            yield* conn.sendText(text)
          }
        }),

        sendAudio: (chunk: Buffer) => Effect.gen(function*() {
          if (transport._tag === "stateless") {
            // Buffer audio, send when turn complete (or batch)
            yield* Effect.fail(new Error("Audio batching not implemented"))
          } else {
            const conn = yield* connectionRef.get.pipe(Effect.flatMap(Option.getOrThrow))
            yield* conn.sendAudio(chunk)
          }
        }),

        events: Stream.fromQueue(eventQueue)
      }
    })
  }
) {}
```

### Transport Implementations

**HTTP Transport (adapts existing OpenAiChatClient):**

```typescript
class HttpLlmTransport extends Effect.Service<HttpLlmTransport>()(
  "@app/HttpLlmTransport",
  {
    effect: Effect.gen(function*() {
      const client = yield* OpenAiChatClient

      return LlmTransport.of({
        _tag: "stateless",
        complete: (ctx, input) => Effect.gen(function*() {
          const request = buildChatRequest(ctx, input)
          return client.createChatCompletionStream(request).pipe(
            Stream.mapEffect(translateToConversationEvent)
          )
        })
      })
    })
  }
) {}
```

**WebSocket Transport (adapts GrokVoiceClient):**

```typescript
class WebSocketLlmTransport extends Effect.Service<WebSocketLlmTransport>()(
  "@app/WebSocketLlmTransport",
  {
    effect: Effect.gen(function*() {
      const voice = yield* GrokVoiceClient

      return LlmTransport.of({
        _tag: "stateful",
        connect: Effect.gen(function*() {
          const config = yield* VoiceConfig
          const conn = yield* voice.connect(config)
          yield* conn.waitForReady

          // Merge all voice streams into ConversationEvent
          const events = Stream.mergeAll([
            conn.transcripts.pipe(
              Stream.map((delta) => ({ _tag: "TextDelta" as const, delta }))
            ),
            conn.audioOutput.pipe(
              Stream.map((chunk) => ({ _tag: "AudioDelta" as const, chunk }))
            ),
            conn.events.pipe(
              Stream.filter(isToolCallEvent),
              Stream.map(translateToolCallEvent)
            )
          ])

          return {
            sendText: conn.sendText,
            sendAudio: conn.send,
            sendToolResult: (id, result) => conn.sendText(JSON.stringify({ id, result })),
            events,
            close: conn.close
          }
        })
      })
    })
  }
) {}
```

## Minimal Proof of Concept Plan

### Phase 1: Core Types (src/unified/domain.ts)
- `ConversationEvent` union type
- `LlmTransport` interface (stateless | stateful)
- `ConversationContext` state type

### Phase 2: HTTP Adapter (src/unified/http-transport.ts)
- Wrap `OpenAiChatClient` or direct to LanguageModel
- Translate `Response.StreamPartEncoded` → `ConversationEvent`
- Implement `StatelessTransport`

### Phase 3: WebSocket Adapter (src/unified/ws-transport.ts)
- Wrap `GrokVoiceClient`
- Merge voice streams into `ConversationEvent`
- Implement `StatefulTransport`

### Phase 4: Unified Session (src/unified/session.ts)
- `UnifiedSession` service
- State management for stateless transport
- Event routing for stateful transport

### Phase 5: Demo CLI (src/unified/demo.ts)
- Simple REPL that:
  - Accepts `--mode=http` or `--mode=voice`
  - Sends text via `session.sendText()`
  - Handles events via `session.events`
  - For voice: sends audio from mic, plays audio output

## Key Implementation Details

### Event Translation

```typescript
// HTTP Response.StreamPartEncoded → ConversationEvent
const translateHttpPart = (part: Response.StreamPartEncoded): Option<ConversationEvent> =>
  match(part)
    .with({ type: "text-delta" }, (p) => Option.some({ _tag: "TextDelta", delta: p.delta }))
    .with({ type: "tool-call" }, (p) => Option.some({ _tag: "ToolCall", id: p.id, name: p.name, params: p.params }))
    .with({ type: "finish" }, (p) => Option.some({ _tag: "TurnComplete", usage: p.usage }))
    .otherwise(() => Option.none())

// Voice events → ConversationEvent
const translateVoiceEvent = (event: unknown): Option<ConversationEvent> =>
  match(event)
    .with({ type: "response.output_audio_transcript.delta" }, (e) =>
      Option.some({ _tag: "TextDelta", delta: e.delta }))
    .with({ type: "response.done" }, () =>
      Option.some({ _tag: "TurnComplete" }))
    .otherwise(() => Option.none())
```

### Tool Calling Flow

For voice mode, tool calling would need:
1. Parse tool call from transcript or dedicated event
2. Execute tool
3. Send result via `sendToolResult()` or `sendText()`
4. Server continues response

This is where voice differs - currently Grok voice doesn't have native tool calling, so we'd need to:
- Detect tool call patterns in text
- Execute tools client-side
- Inject results as user messages

### Audio I/O Integration

The demo needs to handle:
- **Mic capture**: `AudioCapture.stream` → `session.sendAudio(chunk)`
- **Speaker playback**: `session.events.filter(isAudioDelta)` → `AudioPlayback.play(chunk)`
- **PTT vs VAD**: Push-to-talk (manual) or voice activity detection (server-side for Grok)

## File Structure

```
src/unified/
  domain.ts        # Core types
  http-transport.ts # HTTP/stateless adapter
  ws-transport.ts   # WebSocket/stateful adapter
  session.ts        # UnifiedSession service
  demo.ts          # Demo CLI
  index.ts         # Exports
```

## Open Questions

1. **Tool calling in voice mode**: How to handle? Text patterns? Dedicated event type?
2. **Audio batching for HTTP**: Some APIs support audio input - batch or not supported?
3. **Interruption**: WebSocket can interrupt mid-response - how to surface?
4. **Config switching**: Can you change model/voice mid-session?
5. **Error recovery**: HTTP retries vs WebSocket reconnect?

## Next Steps

1. Create `src/unified/` directory structure
2. Define core types in `domain.ts`
3. Implement HTTP transport first (simpler, can test with existing chat)
4. Implement WebSocket transport (build on existing voice client)
5. Build demo CLI that works in both modes
6. Test with real APIs
