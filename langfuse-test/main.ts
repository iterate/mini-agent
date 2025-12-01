// Must be the first import to set up OpenTelemetry before anything else
import "./instrumentation";

import { startActiveObservation } from "@langfuse/tracing";
import { observeOpenAI } from "@langfuse/openai";
import OpenAI from "openai";

// Create an OpenAI client wrapped with Langfuse tracing
const openai = observeOpenAI(new OpenAI());

async function main() {
  console.log("Starting Langfuse tracing test...");
  console.log("LANGFUSE_BASE_URL:", process.env.LANGFUSE_BASE_URL);
  console.log("LANGFUSE_PUBLIC_KEY:", process.env.LANGFUSE_PUBLIC_KEY?.slice(0, 10) + "...");

  // Create a trace with a span that includes an LLM call
  await startActiveObservation(
    "langfuse-test-trace",
    async (span) => {
      span.update({
        input: "Testing Langfuse tracing with OpenAI",
        metadata: {
          purpose: "understand trace structure for Effect app",
          timestamp: new Date().toISOString(),
        },
      });

      // Make an actual OpenAI call - this will be automatically traced
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are a helpful assistant. Keep responses very brief.",
          },
          {
            role: "user",
            content: "What is 2 + 2? Answer in one word.",
          },
        ],
        max_tokens: 10,
      });

      const response = completion.choices[0]?.message?.content ?? "No response";
      console.log("OpenAI response:", response);

      span.update({
        output: response,
      });

      return response;
    },
    {
      // Additional trace attributes
      userId: "test-user-123",
      sessionId: "test-session-456",
      tags: ["test", "langfuse-exploration"],
    }
  );

  console.log("Trace sent to Langfuse!");
}

main()
  .then(async () => {
    // Explicitly shutdown to flush all traces
    console.log("Shutting down SDK to flush traces...");
    const { sdk } = await import("./instrumentation");
    await sdk.shutdown();
    console.log("SDK shutdown complete. Check Langfuse UI for the trace.");
  })
  .catch(console.error);

