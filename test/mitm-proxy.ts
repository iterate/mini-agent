/**
 * MITM proxy for testing HTTPS interception.
 *
 * Uses Proxy.gunzip to automatically handle compressed responses.
 */

import { Proxy as MitmProxy } from "http-mitm-proxy"

export const INJECTED_HEADER = "X-Proxy-Injected"
export const INJECTED_HEADER_VALUE = "mitm-active"
export const RESPONSE_MARKER = "\n<!-- MITM_PROXY_MARKER -->"

export function createMitmProxy(port: number) {
  const proxy = new MitmProxy()

  proxy.onError((_ctx, err) => {
    console.error("[PROXY ERROR]", err?.message || err)
  })

  proxy.onRequest((ctx, callback) => {
    const host = ctx.clientToProxyRequest.headers.host || "unknown"
    const url = ctx.clientToProxyRequest.url || "/"
    console.log(`[PROXY] → ${ctx.clientToProxyRequest.method} ${host}${url}`)

    // Inject header on outgoing request
    if (ctx.proxyToServerRequestOptions?.headers) {
      ctx.proxyToServerRequestOptions.headers[INJECTED_HEADER] = INJECTED_HEADER_VALUE
    }

    // Auto-decompress gzip/deflate responses, modify, then re-compress
    ctx.use(MitmProxy.gunzip)

    // Check if we should modify this response
    let shouldModify = false
    ctx.onResponse((_ctx, callback) => {
      const contentType = ctx.serverToProxyResponse?.headers["content-type"] || ""
      shouldModify = contentType.includes("text/html") ||
        contentType.includes("text/plain") ||
        contentType.includes("application/json")
      callback()
    })

    // Buffer to append marker at end
    let pendingChunk: Buffer | null = null

    ctx.onResponseData((_ctx, chunk, callback) => {
      if (!shouldModify) {
        callback(null, chunk)
        return
      }
      const toSend = pendingChunk
      pendingChunk = chunk
      callback(null, toSend ?? Buffer.alloc(0))
    })

    ctx.onResponseEnd((ctx, callback) => {
      if (shouldModify && pendingChunk) {
        const withMarker = Buffer.concat([pendingChunk, Buffer.from(RESPONSE_MARKER)])
        ctx.proxyToClientResponse.write(withMarker)
      }
      callback()
    })

    callback()
  })

  proxy.onResponse((ctx, callback) => {
    const status = ctx.serverToProxyResponse?.statusCode
    console.log(`[PROXY] ← ${status}`)
    callback()
  })

  return {
    start: () =>
      new Promise<void>((resolve, reject) => {
        proxy.listen({ port }, (err: Error | null | undefined) => {
          if (err) reject(err)
          else resolve()
        })
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        proxy.close()
        resolve()
      }),
    port,
    caPath: `${process.cwd()}/.http-mitm-proxy/certs/ca.pem`
  }
}

// Run standalone if executed directly
if (import.meta.main) {
  const PORT = Number(process.env.PROXY_PORT) || 8080
  const proxy = createMitmProxy(PORT)

  await proxy.start()
  console.log(`MITM proxy listening on port ${PORT}`)
  console.log(`CA cert: ${proxy.caPath}`)
  console.log("")
  console.log("Usage:")
  console.log(`  export https_proxy=http://localhost:${PORT}`)
  console.log(`  curl https://httpbin.org/headers`)

  process.on("SIGINT", async () => {
    await proxy.stop()
    process.exit(0)
  })
}
