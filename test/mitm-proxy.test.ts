/**
 * Integration tests for MITM proxy.
 *
 * Tests header injection and response modification across multiple HTTP clients.
 */

import { execSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { ProxyAgent } from "undici"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createMitmProxy, INJECTED_HEADER, INJECTED_HEADER_VALUE, RESPONSE_MARKER } from "./mitm-proxy.ts"

const PORT = 18080
let proxy: ReturnType<typeof createMitmProxy> | null = null
let caCertPath: string

describe("MITM Proxy", () => {
  beforeAll(async () => {
    proxy = createMitmProxy(PORT)
    await proxy.start()
    caCertPath = proxy.caPath

    // Wait for CA cert to be generated
    let attempts = 0
    while (!existsSync(caCertPath) && attempts < 10) {
      await new Promise((r) => setTimeout(r, 500))
      attempts++
    }

    if (!existsSync(caCertPath)) {
      throw new Error(`CA cert not generated at ${caCertPath}`)
    }
  }, 30000)

  afterAll(async () => {
    if (proxy) {
      await proxy.stop()
    }
  })

  describe("curl", () => {
    it("injects header on outgoing request", () => {
      const result = execSync(
        `https_proxy=http://localhost:${PORT} curl -s --cacert "${caCertPath}" https://httpbin.org/headers`,
        { encoding: "utf-8", timeout: 30000 }
      )
      // Response includes our marker after JSON
      const parts = result.split(RESPONSE_MARKER.trim())
      const json = parts[0] ?? ""
      const data = JSON.parse(json)
      expect(data.headers[INJECTED_HEADER]).toBe(INJECTED_HEADER_VALUE)
    })

    it("appends marker to text/html response", () => {
      const result = execSync(
        `https_proxy=http://localhost:${PORT} curl -s --cacert "${caCertPath}" https://httpbin.org/html`,
        { encoding: "utf-8", timeout: 30000 }
      )
      expect(result).toContain(RESPONSE_MARKER.trim())
    })
  })

  describe("wget", () => {
    it("injects header on outgoing request", () => {
      const result = execSync(
        `HTTPS_PROXY=http://localhost:${PORT} wget -q --ca-certificate="${caCertPath}" -O - https://httpbin.org/headers`,
        { encoding: "utf-8", timeout: 30000 }
      )
      const parts = result.split(RESPONSE_MARKER.trim())
      const json = parts[0] ?? ""
      const data = JSON.parse(json)
      expect(data.headers[INJECTED_HEADER]).toBe(INJECTED_HEADER_VALUE)
    })
  })

  describe("python urllib", () => {
    it("injects header and modifies response", () => {
      const result = execSync(`python3 test/mitm-scripts/test-python.py ${PORT} "${caCertPath}"`, {
        encoding: "utf-8",
        timeout: 30000
      })
      expect(result).toContain("Header injection working")
      expect(result).toContain("Response modification working")
    })
  })

  describe("node/bun undici", () => {
    it("injects header via ProxyAgent", async () => {
      const ca = readFileSync(caCertPath)
      const dispatcher = new ProxyAgent({
        uri: `http://localhost:${PORT}`,
        requestTls: { ca }
      })

      const res = await fetch("https://httpbin.org/headers", {
        dispatcher
      } as unknown as RequestInit)
      const text = await res.text()
      const parts = text.split(RESPONSE_MARKER.trim())
      const json = parts[0] ?? ""
      const data = JSON.parse(json) as { headers: Record<string, string> }
      expect(data.headers[INJECTED_HEADER]).toBe(INJECTED_HEADER_VALUE)
    })

    it("appends marker to response", async () => {
      const ca = readFileSync(caCertPath)
      const dispatcher = new ProxyAgent({
        uri: `http://localhost:${PORT}`,
        requestTls: { ca }
      })

      const res = await fetch("https://httpbin.org/html", {
        dispatcher
      } as unknown as RequestInit)
      const text = await res.text()
      expect(text).toContain(RESPONSE_MARKER.trim())
    })
  })

  describe("gzip responses", () => {
    it("decompresses and modifies gzip responses", async () => {
      const ca = readFileSync(caCertPath)
      const dispatcher = new ProxyAgent({
        uri: `http://localhost:${PORT}`,
        requestTls: { ca }
      })

      const res = await fetch("https://httpbin.org/gzip", {
        dispatcher,
        headers: { "Accept-Encoding": "gzip" }
      } as unknown as RequestInit)
      const text = await res.text()

      // Response was originally gzipped (check the gzipped field)
      expect(text).toContain("\"gzipped\": true")
      // Marker was appended after decompression
      expect(text).toContain(RESPONSE_MARKER.trim())
    })
  })
})
