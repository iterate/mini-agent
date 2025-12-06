/**
 * Code Mode Core Types
 */
import type { Effect } from "effect"

import type { ExecutionError, TimeoutError, ValidationError, ValidationWarning } from "./errors.ts"

/**
 * Callbacks the parent provides to user code
 */
export type CallbackRecord = Record<string, (...args: Array<any>) => any>

/**
 * Context passed to user code
 */
export interface ParentContext<TCallbacks extends CallbackRecord, TData> {
  readonly callbacks: TCallbacks
  readonly data: TData
}

/**
 * Result of code execution
 */
export interface ExecutionResult<T> {
  readonly value: T
  readonly durationMs: number
}

/**
 * Validation result from security analysis
 */
export interface ValidationResult {
  readonly valid: boolean
  readonly errors: ReadonlyArray<ValidationError>
  readonly warnings: ReadonlyArray<ValidationWarning>
}

/**
 * Pre-compiled module for repeated execution
 */
export interface CompiledModule<TCallbacks extends CallbackRecord, TData> {
  readonly javascript: string
  readonly hash: string
  readonly execute: <TResult>(
    parentContext: ParentContext<TCallbacks, TData>
  ) => Effect.Effect<ExecutionResult<TResult>, ExecutionError | TimeoutError>
}

/**
 * Configuration
 */
export interface CodeModeConfig {
  readonly timeoutMs: number
  readonly allowedGlobals: ReadonlyArray<string>
  readonly forbiddenPatterns: ReadonlyArray<RegExp>
}

export const defaultConfig: CodeModeConfig = {
  timeoutMs: 5000,
  allowedGlobals: [
    // Safe built-ins
    "Object",
    "Array",
    "String",
    "Number",
    "Boolean",
    "Date",
    "Math",
    "JSON",
    "Promise",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "Symbol",
    "BigInt",
    "Proxy",
    "Reflect",
    // Errors
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "URIError",
    "EvalError",
    "ReferenceError",
    // Typed arrays
    "ArrayBuffer",
    "DataView",
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
    // Utilities
    "isNaN",
    "isFinite",
    "parseFloat",
    "parseInt",
    "encodeURI",
    "decodeURI",
    "encodeURIComponent",
    "decodeURIComponent",
    "atob",
    "btoa",
    "structuredClone",
    // Constants
    "NaN",
    "Infinity",
    "undefined"
  ],
  forbiddenPatterns: [
    /process\s*[.[\]]/,
    /require\s*\(/,
    /import\s*\(/,
    /import\s+.*from/,
    /eval\s*\(/,
    /Function\s*\(/,
    /globalThis/,
    /window\s*[.[\]]/,
    /global\s*[.[\]]/,
    /self\s*[.[\]]/,
    /Deno\s*[.[\]]/,
    /Bun\s*[.[\]]/
  ]
}
