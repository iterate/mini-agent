/**
 * TypeScript Type Checker
 *
 * Uses the TypeScript compiler API to perform type checking on user code.
 * The preamble allows injecting type definitions (e.g., ctx interface)
 * that are checked but not included in the transpiled output.
 */
import { Effect, Layer } from "effect"
import ts from "typescript"

import { TypeCheckError } from "../errors.ts"
import { TypeChecker } from "../services.ts"
import type { TypeCheckConfig, TypeCheckResult } from "../types.ts"

const LIB_SOURCE = `
declare var NaN: number;
declare var Infinity: number;
declare function parseInt(s: string, radix?: number): number;
declare function parseFloat(string: string): number;
declare function isNaN(number: number): boolean;
declare function isFinite(number: number): boolean;
declare function encodeURI(uri: string): string;
declare function decodeURI(encodedURI: string): string;
declare function encodeURIComponent(uriComponent: string): string;
declare function decodeURIComponent(encodedURIComponent: string): string;
declare function atob(data: string): string;
declare function btoa(data: string): string;

interface ObjectConstructor {
  keys(o: object): string[];
  values<T>(o: { [s: string]: T } | ArrayLike<T>): T[];
  entries<T>(o: { [s: string]: T } | ArrayLike<T>): [string, T][];
  assign<T extends {}, U>(target: T, source: U): T & U;
  fromEntries<T = any>(entries: Iterable<readonly [PropertyKey, T]>): { [k: string]: T };
}
declare var Object: ObjectConstructor;

interface Array<T> {
  length: number;
  push(...items: T[]): number;
  pop(): T | undefined;
  map<U>(callbackfn: (value: T, index: number, array: T[]) => U): U[];
  filter(predicate: (value: T, index: number, array: T[]) => unknown): T[];
  reduce<U>(callbackfn: (previousValue: U, currentValue: T) => U, initialValue: U): U;
  find(predicate: (value: T, index: number) => boolean): T | undefined;
  findIndex(predicate: (value: T, index: number) => boolean): number;
  includes(searchElement: T): boolean;
  indexOf(searchElement: T): number;
  join(separator?: string): string;
  slice(start?: number, end?: number): T[];
  concat(...items: (T | T[])[]): T[];
  forEach(callbackfn: (value: T, index: number, array: T[]) => void): void;
  some(predicate: (value: T, index: number) => boolean): boolean;
  every(predicate: (value: T, index: number) => boolean): boolean;
  sort(compareFn?: (a: T, b: T) => number): this;
  reverse(): T[];
  fill(value: T, start?: number, end?: number): this;
  flat<D extends number = 1>(depth?: D): T[];
}
interface ArrayConstructor {
  new <T>(...items: T[]): T[];
  isArray(arg: any): arg is any[];
  from<T>(arrayLike: ArrayLike<T>): T[];
}
declare var Array: ArrayConstructor;

interface String {
  length: number;
  charAt(pos: number): string;
  charCodeAt(index: number): number;
  concat(...strings: string[]): string;
  indexOf(searchString: string, position?: number): number;
  slice(start?: number, end?: number): string;
  substring(start: number, end?: number): string;
  toLowerCase(): string;
  toUpperCase(): string;
  trim(): string;
  split(separator: string | RegExp, limit?: number): string[];
  replace(searchValue: string | RegExp, replaceValue: string): string;
  match(regexp: string | RegExp): RegExpMatchArray | null;
  includes(searchString: string, position?: number): boolean;
  startsWith(searchString: string, position?: number): boolean;
  endsWith(searchString: string, endPosition?: number): boolean;
  padStart(maxLength: number, fillString?: string): string;
  padEnd(maxLength: number, fillString?: string): string;
  repeat(count: number): string;
}
interface StringConstructor {
  new (value?: any): String;
  (value?: any): string;
  fromCharCode(...codes: number[]): string;
}
declare var String: StringConstructor;

interface Number {
  toString(radix?: number): string;
  toFixed(fractionDigits?: number): string;
  toExponential(fractionDigits?: number): string;
  toPrecision(precision?: number): string;
}
interface NumberConstructor {
  new (value?: any): Number;
  (value?: any): number;
  isNaN(number: unknown): boolean;
  isFinite(number: unknown): boolean;
  isInteger(number: unknown): boolean;
  parseInt(string: string, radix?: number): number;
  parseFloat(string: string): number;
  MAX_VALUE: number;
  MIN_VALUE: number;
  MAX_SAFE_INTEGER: number;
  MIN_SAFE_INTEGER: number;
}
declare var Number: NumberConstructor;

interface Boolean {}
interface BooleanConstructor {
  new (value?: any): Boolean;
  (value?: any): boolean;
}
declare var Boolean: BooleanConstructor;

interface Date {
  getTime(): number;
  getFullYear(): number;
  getMonth(): number;
  getDate(): number;
  getDay(): number;
  getHours(): number;
  getMinutes(): number;
  getSeconds(): number;
  getMilliseconds(): number;
  toISOString(): string;
  toJSON(): string;
}
interface DateConstructor {
  new (): Date;
  new (value: number | string): Date;
  now(): number;
  parse(s: string): number;
}
declare var Date: DateConstructor;

interface RegExp {
  test(string: string): boolean;
  exec(string: string): RegExpExecArray | null;
}
interface RegExpMatchArray extends Array<string> {
  index?: number;
  input?: string;
}
interface RegExpExecArray extends Array<string> {
  index: number;
  input: string;
}
interface RegExpConstructor {
  new (pattern: string, flags?: string): RegExp;
  (pattern: string, flags?: string): RegExp;
}
declare var RegExp: RegExpConstructor;

interface JSON {
  parse(text: string): any;
  stringify(value: any, replacer?: any, space?: string | number): string;
}
declare var JSON: JSON;

interface Math {
  abs(x: number): number;
  ceil(x: number): number;
  floor(x: number): number;
  round(x: number): number;
  max(...values: number[]): number;
  min(...values: number[]): number;
  pow(x: number, y: number): number;
  sqrt(x: number): number;
  random(): number;
  sin(x: number): number;
  cos(x: number): number;
  tan(x: number): number;
  log(x: number): number;
  exp(x: number): number;
  PI: number;
  E: number;
}
declare var Math: Math;

interface PromiseLike<T> {
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2>;
}
interface Promise<T> {
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2>;
  catch<TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null
  ): Promise<T | TResult>;
  finally(onfinally?: (() => void) | null): Promise<T>;
}
interface PromiseConstructor {
  new <T>(executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void): Promise<T>;
  resolve<T>(value: T | PromiseLike<T>): Promise<T>;
  resolve(): Promise<void>;
  reject<T = never>(reason?: any): Promise<T>;
  all<T extends readonly unknown[]>(values: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }>;
  race<T extends readonly unknown[]>(values: T): Promise<Awaited<T[number]>>;
}
declare var Promise: PromiseConstructor;
type Awaited<T> = T extends PromiseLike<infer U> ? Awaited<U> : T;

interface Map<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): this;
  has(key: K): boolean;
  delete(key: K): boolean;
  clear(): void;
  size: number;
  forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void): void;
  keys(): IterableIterator<K>;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[K, V]>;
}
interface MapConstructor {
  new <K, V>(entries?: readonly (readonly [K, V])[] | null): Map<K, V>;
}
declare var Map: MapConstructor;

interface Set<T> {
  add(value: T): this;
  has(value: T): boolean;
  delete(value: T): boolean;
  clear(): void;
  size: number;
  forEach(callbackfn: (value: T, value2: T, set: Set<T>) => void): void;
  keys(): IterableIterator<T>;
  values(): IterableIterator<T>;
  entries(): IterableIterator<[T, T]>;
}
interface SetConstructor {
  new <T>(values?: readonly T[] | null): Set<T>;
}
declare var Set: SetConstructor;

interface WeakMap<K extends object, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): this;
  has(key: K): boolean;
  delete(key: K): boolean;
}
interface WeakMapConstructor {
  new <K extends object, V>(entries?: readonly (readonly [K, V])[] | null): WeakMap<K, V>;
}
declare var WeakMap: WeakMapConstructor;

interface WeakSet<T extends object> {
  add(value: T): this;
  has(value: T): boolean;
  delete(value: T): boolean;
}
interface WeakSetConstructor {
  new <T extends object>(values?: readonly T[] | null): WeakSet<T>;
}
declare var WeakSet: WeakSetConstructor;

interface SymbolConstructor {
  (description?: string): symbol;
  for(key: string): symbol;
  keyFor(sym: symbol): string | undefined;
  readonly iterator: unique symbol;
}
declare var Symbol: SymbolConstructor;

interface BigInt {
  toString(radix?: number): string;
}
interface BigIntConstructor {
  (value: bigint | boolean | number | string): bigint;
}
declare var BigInt: BigIntConstructor;

interface Error {
  name: string;
  message: string;
  stack?: string;
}
interface ErrorConstructor {
  new (message?: string): Error;
  (message?: string): Error;
}
declare var Error: ErrorConstructor;
declare var TypeError: ErrorConstructor;
declare var RangeError: ErrorConstructor;
declare var SyntaxError: ErrorConstructor;
declare var URIError: ErrorConstructor;
declare var EvalError: ErrorConstructor;
declare var ReferenceError: ErrorConstructor;

interface ArrayBuffer {
  readonly byteLength: number;
  slice(begin: number, end?: number): ArrayBuffer;
}
interface ArrayBufferConstructor {
  new (byteLength: number): ArrayBuffer;
}
declare var ArrayBuffer: ArrayBufferConstructor;

interface DataView {
  getInt8(byteOffset: number): number;
  getUint8(byteOffset: number): number;
  getInt16(byteOffset: number, littleEndian?: boolean): number;
  getUint16(byteOffset: number, littleEndian?: boolean): number;
  getInt32(byteOffset: number, littleEndian?: boolean): number;
  getUint32(byteOffset: number, littleEndian?: boolean): number;
  getFloat32(byteOffset: number, littleEndian?: boolean): number;
  getFloat64(byteOffset: number, littleEndian?: boolean): number;
  setInt8(byteOffset: number, value: number): void;
  setUint8(byteOffset: number, value: number): void;
}
interface DataViewConstructor {
  new (buffer: ArrayBuffer, byteOffset?: number, byteLength?: number): DataView;
}
declare var DataView: DataViewConstructor;

interface TypedArray<T> {
  readonly length: number;
  readonly byteLength: number;
  readonly byteOffset: number;
  [index: number]: T;
}
interface Int8Array extends TypedArray<number> {}
interface Uint8Array extends TypedArray<number> {}
interface Uint8ClampedArray extends TypedArray<number> {}
interface Int16Array extends TypedArray<number> {}
interface Uint16Array extends TypedArray<number> {}
interface Int32Array extends TypedArray<number> {}
interface Uint32Array extends TypedArray<number> {}
interface Float32Array extends TypedArray<number> {}
interface Float64Array extends TypedArray<number> {}
interface BigInt64Array extends TypedArray<bigint> {}
interface BigUint64Array extends TypedArray<bigint> {}

interface TypedArrayConstructor<T> {
  new (length: number): T;
  new (array: ArrayLike<number>): T;
  new (buffer: ArrayBuffer, byteOffset?: number, length?: number): T;
}
declare var Int8Array: TypedArrayConstructor<Int8Array>;
declare var Uint8Array: TypedArrayConstructor<Uint8Array>;
declare var Uint8ClampedArray: TypedArrayConstructor<Uint8ClampedArray>;
declare var Int16Array: TypedArrayConstructor<Int16Array>;
declare var Uint16Array: TypedArrayConstructor<Uint16Array>;
declare var Int32Array: TypedArrayConstructor<Int32Array>;
declare var Uint32Array: TypedArrayConstructor<Uint32Array>;
declare var Float32Array: TypedArrayConstructor<Float32Array>;
declare var Float64Array: TypedArrayConstructor<Float64Array>;
declare var BigInt64Array: TypedArrayConstructor<BigInt64Array>;
declare var BigUint64Array: TypedArrayConstructor<BigUint64Array>;

declare function structuredClone<T>(value: T): T;

interface ProxyHandler<T extends object> {
  get?(target: T, p: string | symbol, receiver: any): any;
  set?(target: T, p: string | symbol, value: any, receiver: any): boolean;
  has?(target: T, p: string | symbol): boolean;
  deleteProperty?(target: T, p: string | symbol): boolean;
  apply?(target: T, thisArg: any, argArray: any[]): any;
  construct?(target: T, argArray: any[], newTarget: Function): object;
}
interface ProxyConstructor {
  new <T extends object>(target: T, handler: ProxyHandler<T>): T;
  revocable<T extends object>(target: T, handler: ProxyHandler<T>): { proxy: T; revoke: () => void };
}
declare var Proxy: ProxyConstructor;

interface Reflect {
  get<T extends object>(target: T, propertyKey: PropertyKey): any;
  set<T extends object>(target: T, propertyKey: PropertyKey, value: any): boolean;
  has<T extends object>(target: T, propertyKey: PropertyKey): boolean;
  deleteProperty<T extends object>(target: T, propertyKey: PropertyKey): boolean;
  ownKeys<T extends object>(target: T): (string | symbol)[];
}
declare var Reflect: Reflect;

type PropertyKey = string | number | symbol;
interface IterableIterator<T> {
  next(): { value: T; done: boolean };
  [Symbol.iterator](): IterableIterator<T>;
}
interface ArrayLike<T> {
  readonly length: number;
  readonly [n: number]: T;
}
`

export const TypeCheckerLive = Layer.succeed(
  TypeChecker,
  TypeChecker.of({
    check: (typescript: string, config: TypeCheckConfig) =>
      Effect.gen(function*() {
        if (!config.enabled) {
          return { valid: true, diagnostics: [] } satisfies TypeCheckResult
        }

        const fullSource = config.preamble + "\n" + typescript
        const preambleLines = config.preamble.split("\n").length

        const compilerOptions: ts.CompilerOptions = {
          target: ts.ScriptTarget.ESNext,
          module: ts.ModuleKind.ESNext,
          ...config.compilerOptions,
          noEmit: true
        }

        const sourceFile = ts.createSourceFile(
          "code.ts",
          fullSource,
          ts.ScriptTarget.ESNext,
          true
        )

        const libFile = ts.createSourceFile(
          "lib.d.ts",
          LIB_SOURCE,
          ts.ScriptTarget.ESNext,
          true
        )

        const files = new Map<string, ts.SourceFile>([
          ["code.ts", sourceFile],
          ["lib.d.ts", libFile]
        ])

        const host: ts.CompilerHost = {
          getSourceFile: (name) => files.get(name),
          writeFile: () => {},
          getDefaultLibFileName: () => "lib.d.ts",
          useCaseSensitiveFileNames: () => true,
          getCanonicalFileName: (f) => f,
          getCurrentDirectory: () => "/",
          getNewLine: () => "\n",
          fileExists: (name) => files.has(name),
          readFile: () => undefined,
          directoryExists: () => true,
          getDirectories: () => []
        }

        const program = ts.createProgram(["code.ts"], compilerOptions, host)
        const allDiagnostics = [
          ...program.getSyntacticDiagnostics(sourceFile),
          ...program.getSemanticDiagnostics(sourceFile)
        ]

        const diagnostics = allDiagnostics
          .map((d) => {
            const message = ts.flattenDiagnosticMessageText(d.messageText, "\n")
            if (d.file && d.start !== undefined) {
              const { character, line } = d.file.getLineAndCharacterOfPosition(d.start)
              const adjustedLine = line - preambleLines
              if (adjustedLine < 0) {
                return null
              }
              return {
                message,
                line: adjustedLine + 1,
                column: character + 1,
                code: d.code
              }
            }
            return { message, code: d.code }
          })
          .filter((d): d is NonNullable<typeof d> => d !== null)

        if (diagnostics.length > 0) {
          return yield* Effect.fail(new TypeCheckError({ diagnostics }))
        }

        return { valid: true, diagnostics: [] } satisfies TypeCheckResult
      })
  })
)
