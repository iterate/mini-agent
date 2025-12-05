/**
 * LayerCode Webhook Signature Verification
 *
 * Verifies HMAC-SHA256 signatures on LayerCode webhook requests.
 * The signature header format is: "t=timestamp,v1=signature"
 */
import { Effect, Option, Redacted, Schema } from "effect"

const SIGNATURE_TOLERANCE_SECONDS = 300 // 5 minutes

export class SignatureError extends Schema.TaggedError<SignatureError>()(
  "SignatureError",
  { message: Schema.String }
) {}

/** Parse the layercode-signature header */
const parseSignatureHeader = (header: string) =>
  Effect.gen(function*() {
    const parts = header.split(",")
    let timestamp: string | undefined
    let signature: string | undefined

    for (const part of parts) {
      const [key, value] = part.split("=")
      if (key === "t") timestamp = value
      if (key === "v1") signature = value
    }

    if (!timestamp || !signature) {
      return yield* Effect.fail(
        new SignatureError({ message: "Invalid signature header format" })
      )
    }

    return { timestamp, signature }
  })

/** Compute HMAC-SHA256 signature */
const computeSignature = (secret: string, payload: string) =>
  Effect.tryPromise({
    try: async () => {
      const encoder = new TextEncoder()
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      )
      const signatureBuffer = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(payload)
      )
      // Convert to hex string
      return Array.from(new Uint8Array(signatureBuffer))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
    },
    catch: () => new SignatureError({ message: "Failed to compute signature" })
  })

/** Constant-time string comparison to prevent timing attacks */
const constantTimeCompare = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

/**
 * Verify a LayerCode webhook signature.
 *
 * @param secret - The webhook secret from LayerCode dashboard
 * @param signatureHeader - The "layercode-signature" header value
 * @param body - The raw request body
 */
export const verifySignature = (
  secret: Redacted.Redacted,
  signatureHeader: string,
  body: string
) =>
  Effect.gen(function*() {
    const { signature, timestamp } = yield* parseSignatureHeader(signatureHeader)

    // Check timestamp freshness
    const timestampNum = parseInt(timestamp, 10)
    const now = Math.floor(Date.now() / 1000)

    if (isNaN(timestampNum) || Math.abs(now - timestampNum) > SIGNATURE_TOLERANCE_SECONDS) {
      return yield* Effect.fail(
        new SignatureError({ message: "Signature timestamp expired or invalid" })
      )
    }

    // Compute expected signature
    const payload = `${timestamp}.${body}`
    const expectedSignature = yield* computeSignature(Redacted.value(secret), payload)

    // Constant-time comparison
    if (!constantTimeCompare(signature, expectedSignature)) {
      return yield* Effect.fail(
        new SignatureError({ message: "Signature mismatch" })
      )
    }
  })

/**
 * Optionally verify signature if secret is provided.
 * If no secret, skip verification (for local dev).
 */
export const maybeVerifySignature = (
  secret: Option.Option<Redacted.Redacted>,
  signatureHeader: string | undefined,
  body: string
) =>
  Option.match(secret, {
    onNone: () => Effect.void, // No secret configured, skip verification
    onSome: (s) => {
      if (!signatureHeader) {
        return Effect.fail(
          new SignatureError({ message: "Missing layercode-signature header" })
        )
      }
      return verifySignature(s, signatureHeader, body)
    }
  })
