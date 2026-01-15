/**
 * Test script for http-mitm-proxy
 *
 * This sets up a MITM proxy that:
 * 1. Intercepts HTTPS requests
 * 2. Adds a custom header
 * 3. Logs request details
 */

import { Proxy as MitmProxy } from "http-mitm-proxy"

const proxy = new MitmProxy()

proxy.onError((ctx, err) => {
  console.error("Proxy error:", err)
})

proxy.onRequest((ctx, callback) => {
  const host = ctx.clientToProxyRequest.headers.host || "unknown"
  const url = ctx.clientToProxyRequest.url || "/"
  console.log(`[PROXY] ${ctx.clientToProxyRequest.method} ${host}${url}`)

  // Inject custom header
  if (ctx.proxyToServerRequestOptions?.headers) {
    ctx.proxyToServerRequestOptions.headers["X-Injected-By-Proxy"] = "mitm-test"
  }

  callback()
})

proxy.onResponse((ctx, callback) => {
  console.log(`[PROXY] Response: ${ctx.serverToProxyResponse?.statusCode}`)
  callback()
})

const PORT = 8080

proxy.listen({ port: PORT }, () => {
  console.log(`MITM proxy listening on port ${PORT}`)
  console.log(`CA cert will be at: ${process.cwd()}/.http-mitm-proxy/certs/ca.pem`)
  console.log("")
  console.log("To test:")
  console.log(`  export NODE_EXTRA_CA_CERTS=${process.cwd()}/.http-mitm-proxy/certs/ca.pem`)
  console.log(`  export https_proxy=http://localhost:${PORT}`)
  console.log(`  curl -v https://httpbin.org/headers`)
})
