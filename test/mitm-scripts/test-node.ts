#!/usr/bin/env bun
/**
 * Test MITM proxy with Node/Bun fetch.
 * Uses undici ProxyAgent for explicit proxy control.
 */

import { readFileSync } from "node:fs"
import { ProxyAgent } from "undici"

const proxyPort = process.argv[2] || "8080"
const caCert = process.argv[3] || ".http-mitm-proxy/certs/ca.pem"

const ca = readFileSync(caCert)

// Create proxy agent with custom CA
const dispatcher = new ProxyAgent({
  uri: `http://localhost:${proxyPort}`,
  requestTls: { ca }
})

// Test 1: Header injection
const headersRes = await fetch("https://httpbin.org/headers", {
  dispatcher
} as unknown as RequestInit)
const headersData = (await headersRes.json()) as { headers: Record<string, string> }

if (headersData.headers["X-Proxy-Injected"]) {
  console.log("✓ Header injection working")
} else {
  console.log("✗ Header injection failed")
  console.log(headersData)
  process.exit(1)
}

// Test 2: Response modification
const exampleRes = await fetch("https://example.com", {
  dispatcher
} as unknown as RequestInit)
const body = await exampleRes.text()

if (body.includes("MITM_PROXY_MARKER")) {
  console.log("✓ Response modification working")
} else {
  console.log("✗ Response modification failed")
  process.exit(1)
}

console.log("Node/Bun tests passed")
