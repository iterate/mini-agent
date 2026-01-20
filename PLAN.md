# Grok Voice CLI Implementation Plan

## Goal
Create a CLI that connects to Grok's realtime voice API via WebSocket, captures microphone audio, sends it to Grok, and plays the AI's audio responses through speakers.

## Research Summary

### XAI Realtime Voice API (from xai-cookbook)
- **WebSocket URL**: `wss://api.x.ai/v1/realtime`
- **Authentication**: `Authorization: Bearer ${XAI_API_KEY}` header on WebSocket connect
- **Audio Formats**:
  - PCM 16-bit: `audio/pcm` with configurable sample rate (8kHz-48kHz, default 24kHz)
  - μ-law: `audio/pcmu` (for telephony)
- **Audio Encoding**: Base64 encoded in JSON messages

### WebSocket Protocol
1. On connect, receive `conversation.created` event
2. Send `session.update` to configure voice, audio format, VAD, instructions
3. Wait for `session.updated` confirmation
4. Send audio via `input_audio_buffer.append` with base64 audio
5. Receive `response.output_audio.delta` with base64 audio chunks
6. Server VAD detects speech end, triggers `response.create`

### Message Types
```typescript
// Outbound
{ type: "session.update", session: { voice, audio: { input/output: { format: { type, rate } } }, turn_detection, instructions } }
{ type: "input_audio_buffer.append", audio: "<base64>" }
{ type: "input_audio_buffer.commit" }
{ type: "conversation.item.create", item: { type: "message", role, content } }
{ type: "response.create" }

// Inbound
{ type: "conversation.created" }
{ type: "session.updated" }
{ type: "response.created" }
{ type: "response.output_audio.delta", delta: "<base64>" }
{ type: "response.output_audio_transcript.delta", delta: "<text>" }
{ type: "conversation.item.input_audio_transcription.completed", transcript: "<text>" }
{ type: "input_audio_buffer.speech_started" }
{ type: "response.done" }
{ type: "error", error: { message } }
```

## Architecture

### Services
1. **GrokVoiceClient** - WebSocket connection to XAI API
   - Connect with auth header
   - Send/receive JSON messages
   - Handle session lifecycle
   - Emit audio events as Effect Stream

2. **AudioCapture** - Microphone input
   - Use `sox` CLI for cross-platform compatibility (requires brew install sox)
   - Capture PCM 16-bit mono at 24kHz
   - Stream audio chunks as Buffers

3. **AudioPlayback** - Speaker output
   - Use `sox` CLI (play command) for playback
   - Accept PCM 16-bit mono at 24kHz stream
   - Buffer and play audio chunks

4. **VoiceSession** - Orchestrates the voice chat
   - Coordinates capture → Grok → playback
   - Handles VAD events (speech start/end)
   - Logs transcripts

### File Structure
```
src/voice/
  cli.ts           # CLI command definition
  client.ts        # GrokVoiceClient service
  audio-capture.ts # Microphone capture via sox
  audio-playback.ts # Speaker playback via sox
  domain.ts        # Voice-specific types
  index.ts         # Export barrel
```

## Implementation Steps

### Step 1: Dependencies
Add to package.json:
- `ws` - WebSocket client (standard, Bun compatible)

No native audio packages needed - use sox CLI which is more reliable.

### Step 2: Domain Types (domain.ts)
```typescript
export const VoiceConfig = Schema.Struct({
  voice: Schema.optional(Schema.String),
  sampleRate: Schema.optional(Schema.Number),
  instructions: Schema.optional(Schema.String)
})

export type XaiMessage =
  | { type: "session.update"; session: SessionConfig }
  | { type: "input_audio_buffer.append"; audio: string }
  | { type: "response.output_audio.delta"; delta: string }
  // ... etc
```

### Step 3: GrokVoiceClient (client.ts)
Effect.Service that:
- Creates WebSocket connection
- Handles authentication
- Provides `send(message)` and `receive` Stream
- Manages session configuration

### Step 4: AudioCapture (audio-capture.ts)
Effect.Service that:
- Spawns `sox -d -t raw -r 24000 -e signed -b 16 -c 1 -`
- Streams stdout as audio chunks
- Chunks into ~50ms frames for WebSocket sending

### Step 5: AudioPlayback (audio-playback.ts)
Effect.Service that:
- Spawns `sox -t raw -r 24000 -e signed -b 16 -c 1 - -d`
- Writes audio chunks to stdin
- Handles buffering for smooth playback

### Step 6: Voice CLI (cli.ts)
Command that:
- Accepts --voice, --instructions options
- Reads XAI_API_KEY from env
- Starts capture/playback
- Connects to Grok
- Runs until Ctrl+C

### Step 7: Integration
- Add `voiceCommand` to commands.ts subcommands
- Test with `bun run mini-agent voice`

## Audio Format Details
- Sample rate: 24000 Hz
- Bit depth: 16-bit signed
- Channels: 1 (mono)
- Encoding: PCM (linear)
- Chunk size: ~2048 bytes (512 samples, ~21ms)
- WebSocket transport: Base64 encoded JSON

## Progress Tracking
- [x] Research XAI voice API (from xai-cookbook)
- [x] Research audio handling approaches
- [x] Design architecture
- [x] Implement domain types
- [x] Implement GrokVoiceClient
- [x] Implement AudioCapture
- [x] Implement AudioPlayback
- [x] Implement CLI command
- [x] Wire up to main CLI
- [ ] Test end-to-end

## Usage

```bash
# Voice mode (requires sox: brew install sox)
bun run mini-agent voice --voice ara

# Text mode (type messages instead of speaking)
bun run mini-agent voice --text

# With custom instructions
bun run mini-agent voice --instructions "You are a pirate. Respond in pirate speak."

# Help
bun run mini-agent voice --help
```

Requires `XAI_API_KEY` environment variable to be set.
