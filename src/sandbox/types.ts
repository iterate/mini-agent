/**
 * TypeScript Sandbox Core Types
 *
 * Types for the sandbox system that executes untrusted TypeScript in isolation.
 */
import type { Effect } from "effect"

import type { ExecutionError, TimeoutError, ValidationError, ValidationWarning } from "./errors.ts"

/**
 * Base type for callbacks - any function that can be called
 */

export type CallbackRecord = Record<string, (...args: Array<any>) => any>

/**
 * Parent context passed to user code.
 * @template TCallbacks - Record of callback functions user can invoke
 * @template TData - Read-only data the user can access
 */
export interface ParentContext<
  TCallbacks extends CallbackRecord,
  TData
> {
  readonly callbacks: TCallbacks
  readonly data: TData
}

/**
 * Result of executing user code
 */
export interface ExecutionResult<T> {
  readonly value: T
  readonly durationMs: number
  readonly metadata: Record<string, unknown>
}

/**
 * Validation result from static analysis
 */
export interface ValidationResult {
  readonly valid: boolean
  readonly errors: ReadonlyArray<ValidationError>
  readonly warnings: ReadonlyArray<ValidationWarning>
}

/**
 * Pre-compiled module for repeated execution (compile-once pattern)
 */
export interface CompiledModule<
  TCallbacks extends CallbackRecord,
  TData
> {
  readonly javascript: string
  readonly hash: string
  readonly execute: <TResult>(
    parentContext: ParentContext<TCallbacks, TData>
  ) => Effect.Effect<ExecutionResult<TResult>, ExecutionError | TimeoutError>
}

/**
 * Sandbox configuration
 */
export interface SandboxConfig {
  /** Maximum execution time in milliseconds */
  readonly timeoutMs: number
  /** Maximum memory in MB (not enforced by all executors) */
  readonly maxMemoryMb?: number
  /** Globals the user code IS allowed to access */
  readonly allowedGlobals: ReadonlyArray<string>
  /** Regex patterns that are forbidden in code */
  readonly forbiddenPatterns: ReadonlyArray<RegExp>
}

export const defaultSandboxConfig: SandboxConfig = {
  timeoutMs: 5000,
  maxMemoryMb: 128,
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
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "URIError",
    "EvalError",
    "ReferenceError",
    // Iterators
    "Iterator",
    "AsyncIterator",
    // Typed arrays
    "ArrayBuffer",
    "SharedArrayBuffer",
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
    // Other safe globals
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
    // structuredClone for deep copying
    "structuredClone",
    // NaN and Infinity are globals
    "NaN",
    "Infinity"
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
