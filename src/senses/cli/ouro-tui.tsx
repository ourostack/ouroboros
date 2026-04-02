/**
 * Ouroboros TUI — full terminal interface using Ink v3 + Static.
 *
 * Architecture:
 *   <Static> renders completed messages ONCE — they scroll up naturally.
 *   Only the "live" area (current streaming + spinner + input) re-renders.
 *   This avoids the screen-clearing problem that broke the previous Ink attempt.
 *
 * Design language: ouroboros brand palette from ouroboros.bot / Outlook UI.
 * ZERO business logic here — pure rendering from CliStore state.
 */
import React, { useState, useRef, useEffect, useCallback } from "react"
import { Text, Box, Static, useInput } from "ink"
import { StreamingMarkdown } from "./streaming-markdown"

// ─── Ouroboros Brand Palette (ANSI RGB) ─────────────────────────────
// From packages/outlook-ui/src/style.css and ouroboros.bot
const OURO = {
  scale: "#2f8f4e",    // primary green
  teal: "#4ec9b0",     // tool/accent teal
  glow: "#74e08f",     // bright green (highlights)
  bone: "#eef2ea",     // light text
  mist: "#a5b8a8",     // dim text
  shadow: "#708373",   // very dim
  fang: "#d35f47",     // error red
  gold: "#d6b56f",     // warning amber
  moss: "#183325",     // subtle bg accent
  separator: "#3a5a40", // dim line separator
} as const

// ─── Ring Spinner (growing/shrinking) ───────────────────────────────
const RING_FRAMES = ["∙", "○", "◎", "●", "◎", "○"]

function ringColor(elapsedSec: number): string {
  if (elapsedSec >= 45) return OURO.fang
  if (elapsedSec >= 15) return OURO.gold
  return OURO.scale
}

// ─── Types ──────────────────────────────────────────────────────────

export interface CompletedMessage {
  id: string
  role: "user" | "assistant" | "system" | "tool"
  content: string
  toolCalls?: Array<{ name: string; argSummary: string; success?: boolean }>
}

export interface LiveState {
  streamingText: string
  loading: boolean
  spinnerPhrase: string
  spinnerPhrasePool: string[]
  activeTool: { name: string; args: Record<string, string> } | null
  errorMessage: string | null
  kickMessage: string | null
  inputSuppressed: boolean
}

export type CtrlCAction = "abort" | "clear" | "warn" | "exit"

export interface TuiProps {
  readonly agentName: string
  readonly model: string
  readonly completedMessages: CompletedMessage[]
  readonly inputHistory: readonly string[]
  readonly live: LiveState
  readonly elapsedSeconds: number
  readonly contextPercent: number
  readonly onSubmit: (text: string) => void
  readonly onCtrlC: (hasInput: boolean) => CtrlCAction
  readonly headerShown: boolean
  readonly cwd: string
}

// ─── Header ─────────────────────────────────────────────────────────

/** Safe terminal width: capped at 200, with 2-char margin */
function safeWidth(): number {
  return Math.min(process.stdout.columns || 80, 200) - 2
}

function Header({ agentName, model, contextPercent, cwd }: {
  readonly agentName: string
  readonly model: string
  readonly contextPercent: number
  readonly cwd: string
}): React.ReactElement {
  const showCtx = contextPercent > 0
  const info = [agentName, model, cwd, showCtx ? `ctx ${contextPercent}%` : ""].filter(Boolean).join(" · ")

  // 3-segment snake: TAIL (fixed) + MIDDLE (stretches) + HEAD (fixed)
  const HEAD1 = "     ____"
  const HEAD2 = "____/ O  \\___/"
  const HEAD3 = "_________/   \\"
  const TAIL1 = "   "
  const TAIL2 = " __"
  const TAIL3 = "<__"

  const fixedWidth = TAIL1.length + HEAD1.length
  const maxMiddle = safeWidth() - fixedWidth
  const middleLen = Math.max(Math.min(Math.max(info.length, 20), maxMiddle), 10)
  const textPad = Math.max(middleLen - info.length, 0)

  const line1 = TAIL1 + " ".repeat(middleLen) + HEAD1
  const line2 = TAIL2 + "_".repeat(middleLen) + HEAD2
  const line3text = (info.length > middleLen ? info.slice(0, middleLen) : info) + "_".repeat(textPad)

  return (
    <Box flexDirection="column">
      <Text color={OURO.scale}>{line1}</Text>
      <Text color={OURO.scale}>{line2}</Text>
      <Text color={OURO.scale}>{TAIL3}<Text color={OURO.glow}>{line3text}</Text><Text color={OURO.scale}>{HEAD3}</Text></Text>
    </Box>
  )
}

// ─── Message Rendering ──────────────────────────────────────────────

// Flow control tools are invisible to the user — they are internal agent mechanics
const FLOW_CONTROL_TOOLS = new Set(["settle", "ponder", "observe", "rest"])

function ToolResultLine({ tc }: { readonly tc: { name: string; argSummary: string; success?: boolean } }): React.ReactElement {
  const icon = tc.success !== false ? "✓" : "✗"
  const iconColor = tc.success !== false ? OURO.scale : OURO.fang
  const argColor = tc.success === false ? OURO.fang : OURO.shadow
  return (
    <Text>
      <Text color={iconColor}>{icon}</Text>{" "}
      <Text color={OURO.teal}>{tc.name}</Text>{" "}
      <Text color={argColor}>{tc.argSummary}</Text>
    </Text>
  )
}

function MessageBlock({ msg }: { readonly msg: CompletedMessage }): React.ReactElement {
  if (msg.role === "tool") {
    const visibleCalls = msg.toolCalls?.filter(tc => !FLOW_CONTROL_TOOLS.has(tc.name))
    // Flow control tools produce no visible output at all
    if (!visibleCalls || visibleCalls.length === 0) return <Text>{""}</Text>
    return (
      <Box flexDirection="column">
        {visibleCalls.map((tc, i) => <ToolResultLine key={i} tc={tc} />)}
      </Box>
    )
  }

  if (msg.role === "user") {
    return (
      <Box flexDirection="column" marginTop={1}>
        {msg.content ? <Text color={OURO.bone} bold>{msg.content}</Text> : null}
        <Box marginBottom={1}><Text>{""}</Text></Box>
      </Box>
    )
  }

  if (msg.role === "assistant") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        {msg.content ? <StreamingMarkdown text={msg.content} maxWidth={safeWidth()} /> : null}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={OURO.shadow}>{msg.content}</Text>
      <Box marginBottom={1}><Text>{""}</Text></Box>
    </Box>
  )
}

// ─── Live Area (re-renders) ─────────────────────────────────────────

function Spinner({ phrasePool, elapsed }: {
  readonly phrasePool: string[]
  readonly elapsed: number
}): React.ReactElement {
  const [frame, setFrame] = useState(0)
  const [currentPhrase, setCurrentPhrase] = useState(() =>
    phrasePool.length > 0 ? phrasePool[Math.floor(Math.random() * phrasePool.length)] : ""
  )

  // Animate ring frames
  useEffect(() => {
    const iv = setInterval(() => setFrame(f => (f + 1) % RING_FRAMES.length), 120)
    return () => clearInterval(iv)
  }, [])

  // Rotate phrases every 3 seconds
  useEffect(() => {
    if (phrasePool.length <= 1) return
    const iv = setInterval(() => {
      setCurrentPhrase(phrasePool[Math.floor(Math.random() * phrasePool.length)])
    }, 3000)
    return () => clearInterval(iv)
  }, [phrasePool])

  const color = ringColor(elapsed)
  const timeStr = elapsed > 0 ? `${elapsed}s` : ""

  return (
    <Text color={color}>
      {RING_FRAMES[frame]} {timeStr ? <Text color={OURO.shadow}>{timeStr} · </Text> : ""}{currentPhrase}
    </Text>
  )
}

function formatActiveToolArgs(name: string, args: Record<string, string>): string {
  switch (name) {
    case "shell":
      return `$ ${args.command ?? "?"}`
    case "read_file":
      return `path=${args.path ?? "?"}`
    case "write_file":
      return `path=${args.path ?? "?"}`
    case "edit_file":
      return args.path ?? "?"
    case "glob":
      return `pattern=${args.pattern ?? "?"}`
    case "grep":
      return `pattern=${args.pattern ?? "?"} ${args.path ? `path=${args.path}` : ""}`.trim()
    default: {
      // Show first 2 key=value pairs
      const entries = Object.entries(args).slice(0, 2)
      return entries.map(([k, v]) => `${k}=${String(v).slice(0, 50)}`).join(" ")
    }
  }
}

function ActiveToolLine({ tool }: {
  readonly tool: { name: string; args: Record<string, string> }
}): React.ReactElement {
  // Hide flow control tools from in-progress display
  if (FLOW_CONTROL_TOOLS.has(tool.name)) return <Text>{""}</Text>
  const argStr = formatActiveToolArgs(tool.name, tool.args)
  return (
    <Text>
      <Text color={OURO.shadow}>{"∙"}</Text>{" "}
      <Text color={OURO.teal}>{tool.name}</Text>{" "}
      <Text color={OURO.shadow}>{argStr}</Text>
    </Text>
  )
}

function LiveArea({ live, elapsed }: {
  readonly live: LiveState
  readonly elapsed: number
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      {/* Streaming assistant text — only shown if there IS streaming text */}
      {live.streamingText ? (
        <StreamingMarkdown text={live.streamingText} maxWidth={safeWidth()} />
      ) : null}

      {live.activeTool ? (
        <ActiveToolLine tool={live.activeTool} />
      ) : null}

      {live.loading ? (
        <Spinner phrasePool={live.spinnerPhrasePool} elapsed={elapsed} />
      ) : null}

      {live.errorMessage ? (
        <Text color={OURO.fang}>{"✗ "}{live.errorMessage}</Text>
      ) : null}

      {live.kickMessage ? (
        <Text color={OURO.gold}>{"↻ "}{live.kickMessage}</Text>
      ) : null}
    </Box>
  )
}

// ─── Input ──────────────────────────────────────────────────────────

function InputArea({ onSubmit, suppressed, onCtrlC, agentName, model, history }: {
  readonly onSubmit: (text: string) => void
  readonly suppressed: boolean
  readonly onCtrlC: (hasInput: boolean) => CtrlCAction
  readonly agentName: string
  readonly model: string
  readonly history: readonly string[]
}): React.ReactElement {
  const [input, setInput] = useState("")
  const [tooltip, setTooltip] = useState("")
  const [cursorVisible, setCursorVisible] = useState(true)
  const inputRef = useRef("")
  const historyIdx = useRef(-1) // -1 = not browsing history
  const savedInput = useRef("") // saves current input when entering history

  // Blinking cursor
  useEffect(() => {
    const iv = setInterval(() => setCursorVisible(v => !v), 530)
    return () => clearInterval(iv)
  }, [])

  const handleCtrlC = useCallback(() => {
    const action = onCtrlC(inputRef.current.length > 0)
    if (action === "clear") {
      inputRef.current = ""
      setInput("")
      setTooltip("")
      setTooltip("")
    } else if (action === "warn") {
      // tooltip handled below
      setTooltip("Ctrl-C again to exit")
      setTimeout(() => setTooltip(""), 3000)
    }
    // "abort" and "exit" are handled by the parent (cli.ts)
  }, [onCtrlC])

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === "c") {
      handleCtrlC()
      return
    }
    if (suppressed) return

    // Any non-Ctrl-C input clears tooltip
    setTooltip("")

    if (key.escape) {
      if (inputRef.current) {
        inputRef.current = ""
        setInput("")
        historyIdx.current = -1
        setTooltip("Esc again to clear")
        setTimeout(() => setTooltip(""), 2000)
      } else {
        setTooltip("")
      }
      return
    }
    if (key.return) {
      // Alt+Enter: insert newline instead of submitting
      if (key.meta) {
        inputRef.current += "\n"
        setInput(inputRef.current)
        return
      }
      const text = inputRef.current
      if (text.trim()) onSubmit(text)
      inputRef.current = ""
      setInput("")
      historyIdx.current = -1
      return
    }
    if (key.backspace || key.delete) {
      inputRef.current = inputRef.current.slice(0, -1)
      setInput(inputRef.current)
      historyIdx.current = -1
      return
    }
    // Up arrow: browse history (newest first)
    if (key.upArrow && history.length > 0) {
      if (historyIdx.current === -1) {
        // Entering history — save current input
        savedInput.current = inputRef.current
        historyIdx.current = history.length - 1
      } else if (historyIdx.current > 0) {
        historyIdx.current--
      }
      inputRef.current = history[historyIdx.current]
      setInput(inputRef.current)
      return
    }
    // Down arrow: browse forward or restore saved input
    if (key.downArrow) {
      if (historyIdx.current >= 0) {
        if (historyIdx.current < history.length - 1) {
          historyIdx.current++
          inputRef.current = history[historyIdx.current]
        } else {
          // Past end of history — restore saved input
          historyIdx.current = -1
          inputRef.current = savedInput.current
        }
        setInput(inputRef.current)
      }
      return
    }
    if (!key.ctrl && !key.meta && inputChar) {
      inputRef.current += inputChar
      setInput(inputRef.current)
      historyIdx.current = -1 // typing resets history browsing
    }
  })

  // Get terminal width (capped for sanity)
  const cols = safeWidth()

  if (suppressed) {
    // During model generation: show status bar but no input
    return (
      <Box flexDirection="column">
        <Text dimColor>{"─".repeat(cols)}</Text>
        <Text dimColor>{agentName}{model ? ` · ${model}` : ""}</Text>
        <Text dimColor>{"─".repeat(cols)}</Text>
      </Box>
    )
  }

  const isMultiline = input.includes("\n")
  const inputLines = input.split("\n")

  return (
    <Box flexDirection="column">
      {/* Top separator */}
      <Text dimColor>{"─".repeat(cols)}</Text>
      {/* Input prompt — multi-line shows each line with continuation marker */}
      {isMultiline ? (
        <Box flexDirection="column">
          {inputLines.map((line, i) => (
            <Box key={i}>
              <Text color={OURO.teal} bold>{i === 0 ? ") " : "· "}</Text>
              <Text color={OURO.bone}>{line}</Text>
              {i === inputLines.length - 1 ? (
                cursorVisible ? <Text color={OURO.scale}>{"█"}</Text> : <Text>{" "}</Text>
              ) : null}
            </Box>
          ))}
        </Box>
      ) : (
        <Box>
          <Text color={OURO.teal} bold>{") "}</Text>
          <Text color={OURO.bone}>{input}</Text>
          {cursorVisible ? <Text color={OURO.scale}>{"█"}</Text> : <Text>{" "}</Text>}
        </Box>
      )}
      {/* Status bar with right-aligned tooltip */}
      <Box>
        <Text dimColor>{agentName}{model ? ` · ${model}` : ""}</Text>
        <Box flexGrow={1} />
        {tooltip ? <Text dimColor>{tooltip}</Text> : null}
        {isMultiline ? <Text dimColor>{" (multi-line)"}</Text> : null}
      </Box>
      {/* Bottom separator */}
      <Text dimColor>{"─".repeat(cols)}</Text>
    </Box>
  )
}

// ─── Main TUI Component ─────────────────────────────────────────────

export function OuroTui({
  agentName,
  model,
  completedMessages,
  inputHistory,
  live,
  elapsedSeconds,
  contextPercent,
  onSubmit,
  onCtrlC,
  cwd,
}: TuiProps): React.ReactElement {
  return (
    <Box flexDirection="column">
      {/* Header — always visible, rendered once via Static with a sentinel item */}
      <Static items={[{ id: "__header__" }, ...completedMessages] as any[]}>
        {(item: any, index: number) => {
          if (index === 0) {
            return (
              <Box key="header" flexDirection="column" marginBottom={2}>
                <Box marginTop={1}><Text>{""}</Text></Box>
                <Header agentName={agentName} model={model} contextPercent={contextPercent} cwd={cwd} />
                <Text color={OURO.shadow} dimColor>{"  Ctrl-C twice to exit \u00b7 \u2191\u2193 history \u00b7 Esc clear \u00b7 Alt+Enter newline"}</Text>
              </Box>
            )
          }
          return <MessageBlock key={item.id} msg={item} />
        }}
      </Static>

      {/* Live area — re-renders on every state change */}
      {(live.loading || live.streamingText || live.activeTool) ? <Box marginTop={1}><Text>{""}</Text></Box> : null}
      <LiveArea live={live} elapsed={elapsedSeconds} />
      {(live.loading || live.streamingText || live.activeTool) ? <Box marginBottom={1}><Text>{""}</Text></Box> : null}

      {/* Input */}
      <Box marginTop={1}><Text>{""}</Text></Box>
      <InputArea
        onSubmit={onSubmit}
        suppressed={live.inputSuppressed}
        onCtrlC={onCtrlC}
        agentName={agentName}
        model={model}
        history={inputHistory}
      />
    </Box>
  )
}
