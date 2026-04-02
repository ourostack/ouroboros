import React, { useState, useRef, useEffect } from "react"
import { Text, Box, useInput, useApp } from "ink"
import { StreamingMarkdown } from "./streaming-markdown"
import { EnhancedSpinner } from "./spinner"
import { ToolBadge, ToolParams } from "./tool-render"
import type { ChannelCallbacks } from "../../heart/core"
import { pickPhrase, getPhrases } from "../../mind/phrases"
import { formatKick, formatError } from "../../mind/format"
import { emitNervesEvent } from "../../nerves/runtime"

/**
 * Ink CLI Adapter — bridges RunCliSessionOptions with Ink/React rendering.
 *
 * Architecture:
 * - CliStore: mutable external state, updated by callbacks
 * - InkCliApp: reads from store via subscription, renders Ink components
 * - createInkCallbacks: returns ChannelCallbacks that update the store
 *
 * The business logic (runAgent, pipeline, commands) stays unchanged.
 * Only the rendering layer is replaced: readline -> Ink.
 */

// Ouroboros brand palette
const OURO_GREEN = "#2ecc40"
const OURO_TEAL = "#4ec9b0"

// ─── External Store ────────────────────────────────────────────────

export interface ActiveTool {
  name: string
  args: Record<string, string>
}

export interface ToolResultEntry {
  name: string
  argSummary: string
  success: boolean
}

export interface CliStoreState {
  /** Accumulated text from the current assistant response */
  streamingText: string
  /** Whether the model is currently generating */
  loading: boolean
  /** Spinner phrase */
  spinnerPhrase: string
  /** Current tool being executed */
  activeTool: ActiveTool | null
  /** Completed tool results for current turn */
  toolResults: ToolResultEntry[]
  /** Error message to show */
  errorMessage: string | null
  /** Kick message */
  kickMessage: string | null
  /** Whether input is suppressed (model running) */
  inputSuppressed: boolean
  /** Banner lines to show above input */
  bannerLines: string[]
}

type Listener = () => void

/**
 * Mutable external store. Callbacks mutate state; React subscribes via
 * useSyncExternalStore pattern (simplified: we use a version counter +
 * forceUpdate in the component).
 */
export class CliStore {
  private state: CliStoreState = {
    streamingText: "",
    loading: false,
    spinnerPhrase: "",
    activeTool: null,
    toolResults: [],
    errorMessage: null,
    kickMessage: null,
    inputSuppressed: false,
    bannerLines: [],
  }
  private listeners: Set<Listener> = new Set()
  private spinnerStartTime = 0
  private hadToolRun = false

  getState(): Readonly<CliStoreState> {
    return this.state
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    for (const fn of this.listeners) fn()
  }

  // ─── Mutation methods called by callbacks ───

  modelStart(): void {
    const phrases = getPhrases()
    const pool = this.hadToolRun ? phrases.followup : phrases.thinking
    const first = pickPhrase(pool)
    this.state = {
      ...this.state,
      loading: true,
      spinnerPhrase: first,
      streamingText: "",
      activeTool: null,
      toolResults: [],
      errorMessage: null,
      kickMessage: null,
    }
    this.spinnerStartTime = Date.now()
    this.notify()
  }

  clearText(): void {
    this.state = { ...this.state, streamingText: "" }
    this.notify()
  }

  appendText(text: string): void {
    this.state = {
      ...this.state,
      loading: false,
      streamingText: this.state.streamingText + text,
    }
    this.notify()
  }

  toolStart(name: string, args: Record<string, string>): void {
    this.hadToolRun = true
    this.state = {
      ...this.state,
      loading: true,
      activeTool: { name, args },
      spinnerPhrase: pickPhrase(getPhrases().tool),
    }
    this.spinnerStartTime = Date.now()
    this.notify()
  }

  toolEnd(name: string, argSummary: string, success: boolean): void {
    this.state = {
      ...this.state,
      loading: false,
      activeTool: null,
      toolResults: [...this.state.toolResults, { name, argSummary, success }],
    }
    this.notify()
  }

  setError(message: string): void {
    this.state = { ...this.state, loading: false, errorMessage: message }
    this.notify()
  }

  setKick(): void {
    this.state = { ...this.state, loading: false, kickMessage: formatKick() }
    this.notify()
  }

  suppressInput(): void {
    this.state = { ...this.state, inputSuppressed: true }
    this.notify()
  }

  restoreInput(): void {
    this.state = { ...this.state, inputSuppressed: false }
    this.notify()
  }

  /** Flush streaming state at end of turn */
  endTurn(): void {
    this.state = {
      ...this.state,
      loading: false,
      activeTool: null,
      errorMessage: null,
      kickMessage: null,
    }
    this.notify()
  }

  setBanner(lines: string[]): void {
    this.state = { ...this.state, bannerLines: lines }
    this.notify()
  }

  getElapsedSeconds(): number {
    if (!this.state.loading) return 0
    return Math.floor((Date.now() - this.spinnerStartTime) / 1000)
  }
}

// ─── Callbacks factory ─────────────────────────────────────────────

export function createInkCallbacks(store: CliStore): ChannelCallbacks & { flushMarkdown(): void } {
  emitNervesEvent({
    component: "senses",
    event: "senses.cli_callbacks_created",
    message: "ink cli callbacks created",
    meta: {},
  })

  return {
    onModelStart: () => { store.modelStart() },
    onModelStreamStart: () => { /* no-op: content callbacks handle spinner */ },
    onClearText: () => { store.clearText() },
    onTextChunk: (text: string) => { store.appendText(text) },
    onReasoningChunk: (_text: string) => { /* reasoning stays private */ },
    onToolStart: (name: string, args: Record<string, string>) => { store.toolStart(name, args) },
    onToolEnd: (name: string, argSummary: string, success: boolean) => { store.toolEnd(name, argSummary, success) },
    onError: (error: Error, severity: "transient" | "terminal") => {
      if (severity === "transient") {
        store.setError(error.message)
      } else {
        store.setError(formatError(error))
      }
    },
    onKick: () => { store.setKick() },
    flushMarkdown: () => { store.endTurn() },
  }
}

// ─── Input Area ────────────────────────────────────────────────────

function InputArea({
  onSubmit,
  suppressed,
}: {
  readonly onSubmit: (text: string) => void
  readonly suppressed: boolean
}): React.ReactElement {
  const [input, setInput] = useState("")
  const inputRef = useRef("")
  const [history, setHistory] = useState<string[]>([])
  const historyIdx = useRef(-1)

  useInput((inputChar, key) => {
    if (suppressed) return

    if (key.return) {
      const text = inputRef.current
      if (text.trim()) {
        onSubmit(text)
        setHistory(prev => {
          const next = [...prev, text]
          return next
        })
        historyIdx.current = -1
      }
      inputRef.current = ""
      setInput("")
      return
    }

    if (key.backspace || key.delete) {
      inputRef.current = inputRef.current.slice(0, -1)
      setInput(inputRef.current)
      return
    }

    // History navigation
    if (key.upArrow) {
      if (history.length > 0) {
        const idx = historyIdx.current < 0 ? history.length - 1 : Math.max(0, historyIdx.current - 1)
        historyIdx.current = idx
        inputRef.current = history[idx]
        setInput(history[idx])
      }
      return
    }
    if (key.downArrow) {
      if (historyIdx.current >= 0) {
        const idx = historyIdx.current + 1
        if (idx >= history.length) {
          historyIdx.current = -1
          inputRef.current = ""
          setInput("")
        } else {
          historyIdx.current = idx
          inputRef.current = history[idx]
          setInput(history[idx])
        }
      }
      return
    }

    if (!key.ctrl && !key.meta && inputChar) {
      inputRef.current += inputChar
      setInput(inputRef.current)
    }
  })

  if (suppressed) {
    return <Text>{""}</Text>
  }

  return (
    <Box>
      <Text color={OURO_TEAL} bold>{") "}</Text>
      <Text>{input}</Text>
    </Box>
  )
}

// ─── Main Ink CLI App ──────────────────────────────────────────────

export interface InkCliAppProps {
  readonly store: CliStore
  readonly onSubmit: (text: string) => void
  readonly onExit?: () => void
}

export function InkCliApp({ store, onSubmit, onExit }: InkCliAppProps): React.ReactElement {
  const { exit } = useApp()
  const [, forceUpdate] = useState(0)
  const [elapsed, setElapsed] = useState(0)

  // Subscribe to store changes
  useEffect(() => {
    return store.subscribe(() => {
      forceUpdate(n => n + 1)
    })
  }, [store])

  // Elapsed timer for spinner
  useEffect(() => {
    const iv = setInterval(() => {
      setElapsed(store.getElapsedSeconds())
    }, 1000)
    return () => clearInterval(iv)
  }, [store])

  // Ctrl-C handling
  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      if (onExit) {
        onExit()
      } else {
        exit()
      }
    }
  })

  const state = store.getState()

  return (
    <Box flexDirection="column">
      {/* Banner */}
      {state.bannerLines.length > 0 ? (
        <Box flexDirection="column">
          {state.bannerLines.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      ) : null}

      {/* Streaming assistant text */}
      {state.streamingText ? (
        <StreamingMarkdown text={state.streamingText} />
      ) : null}

      {/* Tool results */}
      {state.toolResults.map((tr, i) => {
        const color = tr.success ? OURO_GREEN : "#e74c3c"
        const icon = tr.success ? "\u2713" : "\u2717"
        return (
          <Box key={i}>
            <Text color={color}>{icon} </Text>
            <Text color={OURO_TEAL} bold>{tr.name}</Text>
            <Text dimColor> {tr.argSummary}</Text>
          </Box>
        )
      })}

      {/* Active tool */}
      {state.activeTool ? (
        <Box>
          <ToolBadge name={state.activeTool.name} />
          <ToolParams name={state.activeTool.name} args={state.activeTool.args} />
        </Box>
      ) : null}

      {/* Spinner */}
      {state.loading ? (
        <EnhancedSpinner
          elapsedSeconds={elapsed}
          phrase={state.spinnerPhrase}
        />
      ) : null}

      {/* Error */}
      {state.errorMessage ? (
        <Text color="#e74c3c">{state.errorMessage}</Text>
      ) : null}

      {/* Kick */}
      {state.kickMessage ? (
        <Text color="#f39c12">{state.kickMessage}</Text>
      ) : null}

      {/* Input */}
      <InputArea onSubmit={onSubmit} suppressed={state.inputSuppressed} />
    </Box>
  )
}
