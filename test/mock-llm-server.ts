/**
 * Mock LLM HTTP Server for E2E Tests
 *
 * Provides fast, predictable streaming responses for testing.
 * Mimics OpenAI's responses API format with all required schema fields.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "http"

export interface MockLlmServer {
  readonly url: string
  readonly port: number
  readonly close: () => Promise<void>
}

/** Start a mock LLM server on a random port */
export const startMockLlmServer = (): Promise<MockLlmServer> => {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/responses" && req.method === "POST") {
        handleResponsesEndpoint(req, res)
      } else {
        res.writeHead(404)
        res.end("Not found")
      }
    })

    server.on("error", reject)

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" ? addr?.port ?? 0 : 0

      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise((r) => server.close(() => r()))
      })
    })
  })
}

/** Handle OpenAI-style /responses endpoint */
const handleResponsesEndpoint = (req: IncomingMessage, res: ServerResponse) => {
  let body = ""
  req.on("data", (chunk) => {
    body += chunk.toString()
  })
  req.on("end", () => {
    try {
      const request = JSON.parse(body)
      const userPrompt = extractUserPrompt(request)
      const response = generateResponse(userPrompt)
      streamResponse(res, response)
    } catch (e) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: String(e) }))
    }
  })
}

/** Extract last user message from request */
const extractUserPrompt = (request: Record<string, unknown>): string => {
  const input = request.input
  if (typeof input === "string") return input
  if (Array.isArray(input)) {
    for (let i = input.length - 1; i >= 0; i--) {
      const msg = input[i] as Record<string, unknown>
      if (msg?.role === "user") {
        const content = msg.content
        if (typeof content === "string") return content
        if (Array.isArray(content)) {
          const textPart = content.find(
            (p: Record<string, unknown>) => p.type === "input_text" || p.type === "text"
          ) as Record<string, unknown> | undefined
          if (textPart?.text) return String(textPart.text)
        }
      }
    }
  }
  return ""
}

interface GeneratedResponse {
  text: string
  chunkDelay: number
}

/** Generate response based on prompt patterns */
const generateResponse = (prompt: string): GeneratedResponse => {
  const lower = prompt.toLowerCase()

  const exactMatch = prompt.match(/say exactly[:\s]+(.+?)(?:\.|$)/i)
  if (exactMatch) return { text: exactMatch[1]!.trim(), chunkDelay: 5 }

  if (lower.includes("tuistory_test_ok")) return { text: "TUISTORY_TEST_OK", chunkDelay: 5 }
  if (lower.includes("test_response_123")) return { text: "TEST_RESPONSE_123", chunkDelay: 5 }
  if (lower.includes("hello_server")) return { text: "HELLO_SERVER", chunkDelay: 5 }
  if (lower.includes("hello_layercode")) return { text: "HELLO_LAYERCODE", chunkDelay: 5 }
  if (lower.includes("script_test")) return { text: "SCRIPT_TEST", chunkDelay: 5 }
  if (lower.includes("raw_test")) return { text: "RAW_TEST", chunkDelay: 5 }
  if (lower.includes("pipe_test")) return { text: "PIPE_TEST", chunkDelay: 5 }
  if (lower.includes("pirate")) return { text: "PIRATE_RESPONSE", chunkDelay: 5 }

  if (lower.includes("dragon") || lower.includes("story")) {
    return {
      text:
        "Once upon a time in a land far away, there lived mighty dragons who soared through crystal skies. These magnificent creatures breathed fire that could melt mountains and ice that could freeze oceans. The dragons were ancient beings, wise beyond measure, who had witnessed the rise and fall of countless civilizations.",
      chunkDelay: 150
    }
  }

  if (lower.includes("favorite color") && lower.includes("what")) return { text: "blue", chunkDelay: 5 }
  if (lower.includes("secret code") && lower.includes("what")) return { text: "XYZ789", chunkDelay: 5 }
  if (lower.includes("letter") && lower.includes("image")) return { text: "i", chunkDelay: 5 }

  return { text: "Mock response from test server", chunkDelay: 5 }
}

/** Create a full Response object with all required fields */
const makeResponseObject = (
  id: string,
  status: "in_progress" | "completed",
  output: Array<Record<string, unknown>>
) => ({
  id,
  object: "response" as const,
  status,
  created_at: Math.floor(Date.now() / 1000),
  error: null,
  incomplete_details: null,
  output,
  instructions: null,
  parallel_tool_calls: true,
  model: "mock-model",
  temperature: 1,
  max_output_tokens: null,
  top_p: 1,
  truncation: "disabled",
  tools: [] as Array<Record<string, unknown>>,
  tool_choice: "auto" as const,
  metadata: {}
})

/** Create an OutputMessage item with all required fields */
const makeOutputMessage = (msgId: string, status: "in_progress" | "completed", text: string) => ({
  id: msgId,
  type: "message" as const,
  role: "assistant" as const,
  status,
  content: text ? [{ type: "output_text" as const, text, annotations: [] }] : []
})

/** Create an OutputTextContent part with all required fields */
const makeOutputTextContent = (text: string) => ({
  type: "output_text" as const,
  text,
  annotations: []
})

/** Stream SSE response with text deltas */
const streamResponse = (res: ServerResponse, response: GeneratedResponse) => {
  const { chunkDelay, text } = response

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  })

  const responseId = `resp_${Date.now()}`
  const messageId = `msg_${Date.now()}`
  let seq = 0

  // 1. response.created
  res.write(
    `event: response.created\ndata: ${
      JSON.stringify({
        type: "response.created",
        sequence_number: seq++,
        response: makeResponseObject(responseId, "in_progress", [])
      })
    }\n\n`
  )

  // 2. response.output_item.added
  res.write(
    `event: response.output_item.added\ndata: ${
      JSON.stringify({
        type: "response.output_item.added",
        sequence_number: seq++,
        output_index: 0,
        item: makeOutputMessage(messageId, "in_progress", "")
      })
    }\n\n`
  )

  // 3. response.content_part.added
  res.write(
    `event: response.content_part.added\ndata: ${
      JSON.stringify({
        type: "response.content_part.added",
        sequence_number: seq++,
        output_index: 0,
        content_index: 0,
        item_id: messageId,
        part: makeOutputTextContent("")
      })
    }\n\n`
  )

  // Stream text chunks
  const numChunks = chunkDelay > 50 ? 8 : 3
  const chunkSize = Math.ceil(text.length / numChunks)
  const chunks: Array<string> = []
  for (let i = 0; i < numChunks; i++) {
    const start = i * chunkSize
    const end = Math.min(start + chunkSize, text.length)
    if (start < text.length) chunks.push(text.slice(start, end))
  }

  let chunkIndex = 0

  const sendChunk = () => {
    if (chunkIndex >= chunks.length) {
      // 4. response.content_part.done
      res.write(
        `event: response.content_part.done\ndata: ${
          JSON.stringify({
            type: "response.content_part.done",
            sequence_number: seq++,
            output_index: 0,
            content_index: 0,
            item_id: messageId,
            part: makeOutputTextContent(text)
          })
        }\n\n`
      )

      // 5. response.output_item.done
      res.write(
        `event: response.output_item.done\ndata: ${
          JSON.stringify({
            type: "response.output_item.done",
            sequence_number: seq++,
            output_index: 0,
            item: makeOutputMessage(messageId, "completed", text)
          })
        }\n\n`
      )

      // 6. response.completed
      res.write(
        `event: response.completed\ndata: ${
          JSON.stringify({
            type: "response.completed",
            sequence_number: seq++,
            response: makeResponseObject(responseId, "completed", [makeOutputMessage(messageId, "completed", text)])
          })
        }\n\n`
      )

      res.end()
      return
    }

    // response.output_text.delta
    res.write(
      `event: response.output_text.delta\ndata: ${
        JSON.stringify({
          type: "response.output_text.delta",
          sequence_number: seq++,
          output_index: 0,
          content_index: 0,
          item_id: messageId,
          delta: chunks[chunkIndex]!
        })
      }\n\n`
    )

    chunkIndex++
    setTimeout(sendChunk, chunkDelay)
  }

  sendChunk()
}
