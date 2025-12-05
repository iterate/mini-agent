/**
 * Tools interface for codemode execution
 *
 * Two output channels:
 * - sendMessage: writes to stderr -> user sees, agent does NOT
 * - console.log: writes to stdout -> agent sees, triggers continuation
 */

/** Response from fetch tool */
export interface FetchResponse {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  text: string
}

/** Options for fetch tool */
export interface FetchOptions {
  url: string
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD"
  headers?: Record<string, string>
  body?: string
}

/** Tools available to codemode blocks */
export interface Tools {
  /** Send a message to the user (user sees, agent does NOT) */
  sendMessage: (text: string) => Promise<void>

  /** Fetch content from a URL with full response info */
  fetch: (opts: FetchOptions) => Promise<FetchResponse>

  /** Perform a complex mathematical calculation (simulated delay) */
  calculate: (expression: string) => Promise<{ result: number; steps: Array<string> }>

  /** Get the current timestamp */
  now: () => Promise<string>

  /** Sleep for specified milliseconds */
  sleep: (ms: number) => Promise<void>
}

/** Template for types.ts written to each response directory */
export const TOOLS_TEMPLATE = `/** Response from fetch tool */
export interface FetchResponse {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  text: string
}

/** Options for fetch tool */
export interface FetchOptions {
  url: string
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD"
  headers?: Record<string, string>
  body?: string
}

/** Tools available to codemode blocks */
export interface Tools {
  /** Send a message to the user (user sees, agent does NOT) */
  sendMessage: (text: string) => Promise<void>

  /** Fetch content from a URL with full response info */
  fetch: (opts: FetchOptions) => Promise<FetchResponse>

  /** Perform a complex mathematical calculation (simulated delay) */
  calculate: (expression: string) => Promise<{ result: number; steps: Array<string> }>

  /** Get the current timestamp */
  now: () => Promise<string>

  /** Sleep for specified milliseconds */
  sleep: (ms: number) => Promise<void>
}
`

/** Template for tsconfig.json written to each response directory */
export const TSCONFIG_TEMPLATE = `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "verbatimModuleSyntax": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["*.ts"]
}
`

/**
 * Header prepended to each block file.
 * Provides the tools implementation.
 * sendMessage writes to stderr (user sees), console.log goes to stdout (agent sees).
 */
export const BLOCK_HEADER = `import type { Tools, FetchOptions, FetchResponse } from "./types.ts"

// Minimal process type for stderr.write - works in Bun and Node
declare const process: { stderr: { write: (s: string) => void } }

const tools: Tools = {
  sendMessage: async (text: string) => {
    process.stderr.write(text + "\\n")
  },

  fetch: async (opts: FetchOptions): Promise<FetchResponse> => {
    const response = await fetch(opts.url, {
      method: opts.method ?? "GET",
      headers: opts.headers,
      body: opts.body
    })
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => { headers[key] = value })
    const text = await response.text()
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers,
      text
    }
  },

  calculate: async (expression: string) => {
    // Simulate complex calculation with delay
    await new Promise(r => setTimeout(r, 500))
    const steps: Array<string> = []
    steps.push(\`Parsing expression: \${expression}\`)
    steps.push("Evaluating...")
    // Simple eval for demo (in production, use a proper math parser)
    const result = Function(\`"use strict"; return (\${expression})\`)() as number
    steps.push(\`Result: \${result}\`)
    return { result, steps }
  },

  now: async () => {
    return new Date().toISOString()
  },

  sleep: async (ms: number) => {
    await new Promise(r => setTimeout(r, ms))
  }
}

// Execute the block
const __executeBlock = async (): Promise<void> => {
`

/**
 * Footer appended to each block file.
 * Outputs a marker to signal block completion (for parsing stdout).
 */
export const BLOCK_FOOTER = `
}

// Run and output completion marker
await __executeBlock()
console.log("\\n__CODEMODE_RESULT__")
`
