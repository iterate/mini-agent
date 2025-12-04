/**
 * Type declarations for OpenTUI
 * Workaround for module resolution issues
 */

declare module "@opentui/core" {
  export interface CliRendererConfig {
    stdin?: NodeJS.ReadStream
    stdout?: NodeJS.WriteStream
    exitOnCtrlC?: boolean
    useAlternateScreen?: boolean
    useMouse?: boolean
    backgroundColor?: string
  }

  export interface RenderContext {
    readonly cols: number
    readonly rows: number
  }

  export class CliRenderer {
    start(): void
    stop(): void
    readonly cols: number
    readonly rows: number
  }

  export function createCliRenderer(config?: CliRendererConfig): Promise<CliRenderer>

  export class KeyEvent {
    name: string
    ctrl: boolean
    meta: boolean
    shift: boolean
    sequence: string
  }

  export const TextAttributes: {
    NONE: number
    BOLD: number
    DIM: number
    ITALIC: number
    UNDERLINE: number
    BLINK: number
    INVERSE: number
    HIDDEN: number
    STRIKETHROUGH: number
  }
}

declare module "@opentui/react" {
  import type { KeyEvent } from "@opentui/core"

  export function useKeyboard(handler: (key: KeyEvent) => void, options?: { release?: boolean }): void
  export function useRenderer(): unknown
  export function useTerminalDimensions(): { cols: number; rows: number }
}

declare module "@opentui/react/renderer" {
  import type { ReactNode } from "react"
  import type { CliRenderer } from "@opentui/core"

  export interface Root {
    render(node: ReactNode): void
    unmount(): void
  }

  export function createRoot(renderer: CliRenderer): Root
}
