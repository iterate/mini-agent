/**
 * LayerCode Integration Module
 *
 * Provides HTTP server capabilities for the agent, including:
 * - Generic HTTP server with /context/:name endpoint
 * - LayerCode voice integration with webhook handler
 */

export { layercodeCommand, serveCommand } from "./cli.ts"
export { makeRouter, runServer } from "./http.ts"
export { makeLayerCodeRouter } from "./layercode.adapter.ts"
export { AgentServer, ScriptInputEvent } from "./server.service.ts"
export { maybeVerifySignature, SignatureError, verifySignature } from "./signature.ts"
