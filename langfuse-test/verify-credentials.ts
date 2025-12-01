/**
 * Simple test to verify Langfuse credentials work
 */
import { Langfuse } from "langfuse";

const langfuse = new Langfuse({
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  baseUrl: process.env.LANGFUSE_BASE_URL,
});

// Enable debug logging
langfuse.debug();

async function main() {
  console.log("Testing Langfuse credentials...");
  console.log("Base URL:", process.env.LANGFUSE_BASE_URL);
  console.log("Public Key:", process.env.LANGFUSE_PUBLIC_KEY);
  console.log("Secret Key:", process.env.LANGFUSE_SECRET_KEY?.slice(0, 15) + "...");

  // Create a simple trace using the low-level API
  const trace = langfuse.trace({
    name: "credential-test-trace",
    userId: "test-user",
    metadata: { test: true },
    input: "Hello from credential test",
  });

  trace.update({
    output: "Test complete",
  });

  console.log("Trace created with ID:", trace.id);
  console.log("Flushing...");
  
  await langfuse.flushAsync();
  
  console.log("Flush complete!");
  await langfuse.shutdownAsync();
  console.log("Done!");
}

main().catch(console.error);

