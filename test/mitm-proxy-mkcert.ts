/**
 * MITM proxy using mkcert for certificate generation.
 *
 * This version uses mkcert instead of node-forge for cert generation,
 * which produces certs that Go's crypto/x509 accepts (proper serial numbers).
 */

import { Proxy as MitmProxy } from "http-mitm-proxy"
import { execSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"

export const INJECTED_HEADER = "X-Proxy-Injected"
export const INJECTED_HEADER_VALUE = "mitm-active"
export const RESPONSE_MARKER = "\n<!-- MITM_PROXY_MARKER -->"

const MKCERT_CAROOT = process.env.MKCERT_CAROOT || "/home/user/mini-agent/.mkcert-ca"
const CERTS_DIR = "/home/user/mini-agent/.mitm-mkcert-certs"

// Ensure CA exists
function ensureMkcertCa() {
  if (!existsSync(`${MKCERT_CAROOT}/rootCA.pem`)) {
    console.log("Creating mkcert CA...")
    execSync(`CAROOT=${MKCERT_CAROOT} mkcert -install`, { stdio: "inherit" })
  }
}

// Generate cert for hostname using mkcert
function generateCert(hostname: string): { keyFileData: string; certFileData: string } {
  mkdirSync(CERTS_DIR, { recursive: true })

  const keyFile = `${CERTS_DIR}/${hostname}-key.pem`
  const certFile = `${CERTS_DIR}/${hostname}.pem`

  // Check if cert already exists
  if (existsSync(keyFile) && existsSync(certFile)) {
    return {
      keyFileData: readFileSync(keyFile, "utf-8"),
      certFileData: readFileSync(certFile, "utf-8")
    }
  }

  // Generate new cert with mkcert
  const result = spawnSync(
    "mkcert",
    ["-key-file", keyFile, "-cert-file", certFile, hostname],
    {
      env: { ...process.env, CAROOT: MKCERT_CAROOT },
      encoding: "utf-8"
    }
  )

  if (result.status !== 0) {
    throw new Error(`mkcert failed for ${hostname}: ${result.stderr}`)
  }

  return {
    keyFileData: readFileSync(keyFile, "utf-8"),
    certFileData: readFileSync(certFile, "utf-8")
  }
}

export function createMitmProxyWithMkcert(port: number) {
  ensureMkcertCa()

  const proxy = new MitmProxy()

  proxy.onError((_ctx, err) => {
    console.error("[PROXY ERROR]", err?.message || err)
  })

  // Use mkcert for cert generation instead of node-forge
  proxy.onCertificateMissing = (ctx, _files, callback) => {
    console.log(`[PROXY] Generating cert for ${ctx.hostname}`)
    try {
      const { certFileData, keyFileData } = generateCert(ctx.hostname)
      callback(null, { keyFileData, certFileData })
    } catch (err) {
      console.error(`[PROXY] Cert generation failed:`, err)
      callback(err as Error)
    }
  }

  proxy.onRequest((ctx, callback) => {
    const host = ctx.clientToProxyRequest.headers.host || "unknown"
    const url = ctx.clientToProxyRequest.url || "/"
    console.log(`[PROXY] → ${ctx.clientToProxyRequest.method} ${host}${url}`)

    // Inject header on outgoing request
    if (ctx.proxyToServerRequestOptions?.headers) {
      ctx.proxyToServerRequestOptions.headers[INJECTED_HEADER] = INJECTED_HEADER_VALUE
    }

    // Track chunks for this specific request
    let pendingChunk: Buffer | null = null
    let shouldModifyResponse = false

    // Check content type to decide if we should modify response
    ctx.onResponse((ctx, callback) => {
      const contentType = ctx.serverToProxyResponse?.headers["content-type"] || ""
      const contentEncoding = ctx.serverToProxyResponse?.headers["content-encoding"]

      // Only modify uncompressed text responses
      shouldModifyResponse = !contentEncoding &&
        (contentType.includes("text/html") ||
          contentType.includes("text/plain") ||
          contentType.includes("application/json"))

      callback()
    })

    // Buffer chunks to append marker to the final one (only for text)
    ctx.onResponseData((_ctx, chunk, callback) => {
      if (!shouldModifyResponse) {
        callback(null, chunk)
        return
      }
      const toSend = pendingChunk
      pendingChunk = chunk
      callback(null, toSend ?? Buffer.alloc(0))
    })

    ctx.onResponseEnd((ctx, callback) => {
      if (shouldModifyResponse && pendingChunk) {
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
    caPath: `${MKCERT_CAROOT}/rootCA.pem`
  }
}

// Run standalone if executed directly
if (import.meta.main) {
  const PORT = Number(process.env.PROXY_PORT) || 8080
  const proxy = createMitmProxyWithMkcert(PORT)

  await proxy.start()
  console.log(`MITM proxy (mkcert) listening on port ${PORT}`)
  console.log(`CA cert: ${proxy.caPath}`)
  console.log("")
  console.log("Usage:")
  console.log(`  export https_proxy=http://localhost:${PORT}`)
  console.log(`  export SSL_CERT_FILE=${proxy.caPath}  # for Go`)
  console.log(`  curl https://httpbin.org/headers`)

  process.on("SIGINT", async () => {
    await proxy.stop()
    process.exit(0)
  })
}
