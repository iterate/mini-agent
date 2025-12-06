/**
 * Code Mode Core Types
 */
import type { Effect } from "effect"
import type { CompilerOptions } from "typescript"

import type { ExecutionError, TimeoutError, TypeCheckDiagnostic, ValidationError, ValidationWarning } from "./errors.ts"

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
 * Result of type checking
 */
export interface TypeCheckResult {
  readonly valid: boolean
  readonly diagnostics: ReadonlyArray<TypeCheckDiagnostic>
}

/**
 * Pre-compiled module for repeated execution
 */
export interface CompiledModule<TCtx extends object> {
  readonly javascript: string
  readonly hash: string
  readonly execute: <TResult>(
    ctx: TCtx
  ) => Effect.Effect<ExecutionResult<TResult>, ExecutionError | TimeoutError>
}

/**
 * Type checking configuration
 */
export interface TypeCheckConfig {
  /** Enable type checking (default: false) */
  readonly enabled: boolean
  /** TypeScript compiler options */
  readonly compilerOptions: CompilerOptions
  /** Type definitions prepended to user code for type checking only */
  readonly preamble: string
}

/**
 * Configuration
 */
export interface CodeModeConfig {
  readonly timeoutMs: number
  readonly allowedGlobals: ReadonlyArray<string>
  readonly forbiddenPatterns: ReadonlyArray<RegExp>
  readonly typeCheck: TypeCheckConfig
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
  ],
  typeCheck: {
    enabled: false,
    compilerOptions: {
      strict: true,
      noEmit: true,
      skipLibCheck: true
    },
    preamble: ""
  }
}

export const defaultTypeCheckConfig: TypeCheckConfig = {
  enabled: false,
  compilerOptions: {
    strict: true,
    noEmit: true,
    skipLibCheck: true
  },
  preamble: ""
}
