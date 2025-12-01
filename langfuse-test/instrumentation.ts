import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

const spanProcessor = new LangfuseSpanProcessor({
  debug: true, // Enable debug logging
});

const sdk = new NodeSDK({
  spanProcessors: [spanProcessor],
});

sdk.start();

console.log("OpenTelemetry SDK started with Langfuse span processor");

// Export for explicit shutdown
export { sdk, spanProcessor };

