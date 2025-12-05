/**
 * LayerCode Integration Module
 *
 * Provides LayerCode voice integration for the agent:
 * - LayerCode-specific CLI commands
 * - Webhook adapter for LayerCode format translation
 * - Signature verification for webhook security
 */

export { layercodeCommand } from "./cli.ts"
export { makeLayerCodeRouter } from "./layercode.adapter.ts"
export { maybeVerifySignature, SignatureError, verifySignature } from "./signature.ts"
