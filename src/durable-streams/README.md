# Durable Streams

Pure event streams with append/subscribe semantics. No LLM logic, no agent behavior - just ordered, persistent event logs.

## Design Philosophy

**Streams are named, ordered event logs.** Each stream:
- Has a unique name
- Contains events with monotonically increasing offsets
- Supports append (write) and subscribe (read)
- Provides fan-out to multiple subscribers

**CLI wraps HTTP.** The CLI doesn't talk to streams directly - it talks to an HTTP server. This decouples client from storage and enables remote operation.

**Auto-daemon for local use.** Stream commands auto-start a local server if none running. No manual server management needed for simple use cases.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         CLI Layer                          │
│  stream subscribe/append → HTTP client → server            │
│  server run/start/stop   → daemon management               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        HTTP Layer                          │
│  POST /streams/:name   → append event                      │
│  GET  /streams/:name   → subscribe (SSE)                   │
│  GET  /streams         → list streams                      │
│  DELETE /streams/:name → delete stream                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    StreamManager (Layer 1)                  │
│  getStream() → lazy init + cache                           │
│  append/subscribe/list/delete                              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    DurableStream (Layer 0)                  │
│  Per-stream state: offset counter, PubSub                  │
│  append() → increment offset, store, broadcast             │
│  subscribe() → historical catchup + live PubSub            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                        Storage                              │
│  InMemory (default) | FileSystem (future)                  │
└─────────────────────────────────────────────────────────────┘
```

## CLI Reference

### Server Commands

```bash
# Run server in foreground (blocks)
npx tsx src/durable-streams/main.ts server run --port 3000

# Start daemonized server (returns immediately)
npx tsx src/durable-streams/main.ts server start --port 3000

# Stop daemon
npx tsx src/durable-streams/main.ts server stop

# Restart daemon
npx tsx src/durable-streams/main.ts server restart --port 3000

# Check daemon status
npx tsx src/durable-streams/main.ts server status
```

### Stream Commands

```bash
# Subscribe to stream (outputs JSON lines)
npx tsx src/durable-streams/main.ts stream subscribe my-stream

# Subscribe from beginning (offset -1)
npx tsx src/durable-streams/main.ts stream subscribe my-stream --offset -1

# Append message (auto-wraps as {type:"message",text:"..."})
npx tsx src/durable-streams/main.ts stream append my-stream -m "hello world"

# Append raw JSON
npx tsx src/durable-streams/main.ts stream append my-stream -e '{"custom":"data"}'

# List all streams
npx tsx src/durable-streams/main.ts stream list

# Delete stream
npx tsx src/durable-streams/main.ts stream delete my-stream
```

### Environment Variables

- `DURABLE_STREAMS_URL` - Server URL (skips auto-daemon)

### Files Created

When using daemon mode:
- `daemon.pid` - Process ID of running daemon
- `daemon.port` - Port the daemon is listening on
- `daemon.log` - Server stdout/stderr

## Testing with tmux

Multi-window setup for interactive testing:

```bash
# Create tmux session with 3 panes
tmux new-session -d -s ds
tmux split-window -h -t ds
tmux split-window -v -t ds:0.1

# Pane 0: Server
tmux send-keys -t ds:0.0 'npx tsx src/durable-streams/main.ts server run' Enter

# Pane 1: Subscriber (wait for server to start)
tmux send-keys -t ds:0.1 'sleep 1 && npx tsx src/durable-streams/main.ts stream subscribe test' Enter

# Pane 2: Publisher
tmux send-keys -t ds:0.2 'sleep 2' Enter

# Attach to session
tmux attach -t ds
```

Then in pane 2, send messages:
```bash
npx tsx src/durable-streams/main.ts stream append test -m "first message"
npx tsx src/durable-streams/main.ts stream append test -m "second message"
npx tsx src/durable-streams/main.ts stream append test -e '{"type":"custom","payload":123}'
```

Watch them appear in pane 1 (subscriber).

## HTTP API Examples

### Append Event

```bash
curl -X POST http://localhost:3000/streams/my-stream \
  -H "Content-Type: application/json" \
  -d '{"data": {"type": "message", "text": "hello"}}'
```

Response:
```json
{"offset":"0000000000000000","data":{"type":"message","text":"hello"},"timestamp":1704672000000}
```

### Subscribe (SSE)

```bash
# Subscribe from current position
curl -N http://localhost:3000/streams/my-stream

# Subscribe from beginning
curl -N http://localhost:3000/streams/my-stream?offset=-1

# Subscribe from specific offset
curl -N http://localhost:3000/streams/my-stream?offset=0000000000000005
```

Output (SSE format):
```
data: {"offset":"0000000000000000","data":{"type":"message","text":"hello"},"timestamp":1704672000000}

data: {"offset":"0000000000000001","data":{"type":"message","text":"world"},"timestamp":1704672001000}
```

### List Streams

```bash
curl http://localhost:3000/streams
```

Response:
```json
{"streams":["my-stream","another-stream"]}
```

### Delete Stream

```bash
curl -X DELETE http://localhost:3000/streams/my-stream
```

## Event Structure

```typescript
interface StreamEvent {
  offset: string    // Zero-padded 16-char number ("0000000000000042")
  data: unknown     // Your payload
  timestamp: number // Unix millis
}
```

Offsets are lexicographically sortable strings. Special offset `-1` means "start from beginning".

## Key Files

| File | Purpose |
|------|---------|
| `cli.ts` | CLI command definitions |
| `main.ts` | Entry point |
| `daemon.ts` | Daemon management (start/stop/status) |
| `client.ts` | HTTP client with auto-daemon |
| `http-routes.ts` | HTTP route handlers |
| `stream-manager.ts` | Stream lifecycle management |
| `stream.ts` | Core DurableStream implementation |
| `storage.ts` | Storage backend interface |
| `types.ts` | Type definitions |
