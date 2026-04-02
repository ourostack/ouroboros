/**
 * Ambient type declarations for ink v4 (ESM-only package used from CJS via dynamic import).
 *
 * The real ink types require moduleResolution: "node16" or "bundler", which is
 * incompatible with this project's "module": "commonjs" setup. These declarations
 * provide enough surface area for our CLI TUI components while keeping the
 * existing tsconfig intact.
 *
 * At runtime, ink is loaded via dynamic import(): `const { render, Box, Text } = await import("ink")`
 */
declare module "ink" {
  import type { FC, ReactNode, ReactElement, Key } from "react"

  // -- Layout --
  export interface BoxProps {
    readonly children?: ReactNode
    readonly flexDirection?: "row" | "column" | "row-reverse" | "column-reverse"
    readonly flexGrow?: number
    readonly flexShrink?: number
    readonly flexBasis?: number | string
    readonly flexWrap?: "nowrap" | "wrap" | "wrap-reverse"
    readonly alignItems?: "flex-start" | "center" | "flex-end" | "stretch"
    readonly alignSelf?: "auto" | "flex-start" | "center" | "flex-end" | "stretch"
    readonly justifyContent?: "flex-start" | "center" | "flex-end" | "space-between" | "space-around" | "space-evenly"
    readonly width?: number | string
    readonly height?: number | string
    readonly minWidth?: number
    readonly minHeight?: number
    readonly padding?: number
    readonly paddingTop?: number
    readonly paddingBottom?: number
    readonly paddingLeft?: number
    readonly paddingRight?: number
    readonly margin?: number
    readonly marginTop?: number
    readonly marginBottom?: number
    readonly marginLeft?: number
    readonly marginRight?: number
    readonly gap?: number
    readonly borderStyle?: "single" | "double" | "round" | "bold" | "singleDouble" | "doubleSingle" | "classic" | "arrow"
    readonly borderColor?: string
    readonly borderTop?: boolean
    readonly borderBottom?: boolean
    readonly borderLeft?: boolean
    readonly borderRight?: boolean
    readonly overflow?: "visible" | "hidden"
    readonly key?: Key
    readonly display?: "flex" | "none"
  }
  export const Box: FC<BoxProps>

  // -- Text --
  export interface TextProps {
    readonly children?: ReactNode
    readonly color?: string
    readonly backgroundColor?: string
    readonly bold?: boolean
    readonly italic?: boolean
    readonly underline?: boolean
    readonly strikethrough?: boolean
    readonly inverse?: boolean
    readonly dimColor?: boolean
    readonly wrap?: "wrap" | "truncate" | "truncate-start" | "truncate-middle" | "truncate-end"
  }
  export const Text: FC<TextProps>

  // -- Other components --
  export const Newline: FC
  export const Spacer: FC
  export interface StaticProps<T> {
    readonly items: readonly T[]
    readonly children: (item: T, index: number) => ReactElement
    readonly style?: BoxProps
  }
  export function Static<T>(props: StaticProps<T>): ReactElement
  export interface TransformProps {
    readonly children?: ReactNode
    readonly transform: (children: string, index: number) => string
  }
  export const Transform: FC<TransformProps>

  // -- Hooks --
  export function useInput(
    handler: (input: string, key: KeyInput) => void,
    options?: { isActive?: boolean },
  ): void
  export interface KeyInput {
    readonly upArrow: boolean
    readonly downArrow: boolean
    readonly leftArrow: boolean
    readonly rightArrow: boolean
    readonly pageDown: boolean
    readonly pageUp: boolean
    readonly return: boolean
    readonly escape: boolean
    readonly ctrl: boolean
    readonly shift: boolean
    readonly tab: boolean
    readonly backspace: boolean
    readonly delete: boolean
    readonly meta: boolean
  }
  export function useApp(): { exit: (error?: Error) => void }
  export function useStdin(): {
    stdin: NodeJS.ReadStream | undefined
    isRawModeSupported: boolean
    setRawMode: (mode: boolean) => void
  }
  export function useStdout(): {
    stdout: NodeJS.WriteStream | undefined
    write: (data: string) => void
  }
  export function useStderr(): {
    stderr: NodeJS.WriteStream | undefined
    write: (data: string) => void
  }
  export function useFocus(options?: { autoFocus?: boolean; isActive?: boolean; id?: string }): {
    isFocused: boolean
  }
  export function useFocusManager(): {
    enableFocus: () => void
    disableFocus: () => void
    focusNext: () => void
    focusPrevious: () => void
    focus: (id: string) => void
  }
  export function measureElement(ref: { current: unknown }): {
    width: number
    height: number
  }

  // -- render --
  export interface RenderInstance {
    rerender: (tree: ReactElement) => void
    unmount: () => void
    waitUntilExit: () => Promise<void>
    cleanup: () => void
    clear: () => void
  }
  export interface RenderOptions {
    stdout?: NodeJS.WriteStream
    stderr?: NodeJS.WriteStream
    stdin?: NodeJS.ReadStream
    debug?: boolean
    exitOnCtrlC?: boolean
    patchConsole?: boolean
  }
  export function render(tree: ReactElement, options?: RenderOptions): RenderInstance
}

declare module "ink-testing-library" {
  import type { ReactElement } from "react"

  export interface RenderResult {
    readonly lastFrame: () => string | null
    readonly frames: readonly string[]
    readonly stdin: {
      write: (data: string) => void
    }
    readonly unmount: () => void
    readonly rerender: (tree: ReactElement) => void
    readonly cleanup: () => void
  }
  export function render(tree: ReactElement): RenderResult
  export function cleanup(): void
}
