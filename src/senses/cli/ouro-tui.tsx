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
import { processSubmitInput } from "./image-paste"
import { KillRing } from "./kill-ring"
import { handleKillToEnd, handleKillToStart, handleKillWordBack, handleYank, handleYankPop, handleCursorLeft, handleCursorRight, handleBackspace, handleForwardDelete, handleHome, handleEnd, classifyEscapeSequence } from "./input-keys"
import { imageRefEndingAt, imageRefStartingAt, deleteTokenBefore } from "./image-ref-navigation"

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
  readonly queuedInputs: readonly string[]
  readonly live: LiveState
  readonly elapsedSeconds: number
  readonly contextPercent: number
  readonly onSubmit: (text: string) => void
  readonly onCtrlC: (hasInput: boolean) => CtrlCAction
  readonly onPopQueue: () => string[]
  readonly headerShown: boolean
  readonly cwd: string
  readonly resumeInfo?: { messageCount: number; timeAgo: string }
  readonly onImageMap?: (images: Map<number, string>) => void
  readonly onHistoryAdd?: (text: string) => void
}

// ─── Header ─────────────────────────────────────────────────────────

/** Terminal width for content (capped at 200, with 2-char margin) */
function safeWidth(): number {
  return Math.min(process.stdout.columns || 80, 200) - 2
}

/** Full terminal width for edge-to-edge elements (separators) */
function termWidth(): number {
  return process.stdout.columns || 80
}

function Header({ agentName, model, contextPercent, cwd, resumeInfo }: {
  readonly agentName: string
  readonly model: string
  readonly contextPercent: number
  readonly cwd: string
  readonly resumeInfo?: { messageCount: number; timeAgo: string }
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
      {resumeInfo ? (
        <Text color={OURO.teal}>{"  resuming \u00b7 "}{resumeInfo.messageCount}{" messages \u00b7 last active "}{resumeInfo.timeAgo}</Text>
      ) : null}
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

// ─── Queued Messages ───────────────────────────────────────────────

export function QueuedMessages({ items }: {
  readonly items: readonly string[]
}): React.ReactElement {
  if (items.length === 0) return <Text>{""}</Text>
  return (
    <Box flexDirection="column">
      {items.map((text, i) => (
        <Text key={i}>
          <Text color={OURO.shadow}>{"\u231B queued: "}</Text>
          <Text color={OURO.mist}>{"\""}{text}{"\""}</Text>
        </Text>
      ))}
    </Box>
  )
}

// ─── Kill Ring (session-scoped) ─────────────────────────────────────
const killRing = new KillRing()

// ─── Input ──────────────────────────────────────────────────────────

function InputArea({ onSubmit, onCtrlC, history, queuedInputs, onPopQueue, agentName, model, onImageMap, onHistoryAdd }: {
  readonly onSubmit: (text: string) => void
  readonly onCtrlC: (hasInput: boolean) => CtrlCAction
  readonly history: readonly string[]
  readonly queuedInputs: readonly string[]
  readonly onPopQueue: () => string[]
  readonly agentName: string
  readonly model: string
  readonly onImageMap?: (images: Map<number, string>) => void
  readonly onHistoryAdd?: (text: string) => void
}): React.ReactElement {
  const [input, setInput] = useState("")
  const [cursorPos, setCursorPos] = useState(0) // cursor position within input
  const [tooltip, setTooltip] = useState("")
  const [cursorVisible, setCursorVisible] = useState(true)
  const inputRef = useRef("")
  const cursorRef = useRef(0)
  const historyIdx = useRef(-1)
  const savedInput = useRef("")

  // Deferred ESC handling: Ink 3.2 fires escape events for ESC prefix of arrow
  // keys (\x1b[D) and Alt+Enter (\x1b\r). We defer ESC actions by 80ms — if
  // another key arrives in that window, it was an escape sequence, not standalone ESC.
  const escTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastEscTime = useRef(0)
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current)
  }, [])

  // Helper: update input and cursor together
  const updateInput = (text: string, pos?: number) => {
    inputRef.current = text
    cursorRef.current = pos ?? text.length
    setInput(text)
    setCursorPos(cursorRef.current)
  }

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
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current)
      tooltipTimerRef.current = setTimeout(() => setTooltip(""), 3000)
    }
    // "abort" and "exit" are handled by the parent (cli.ts)
  }, [onCtrlC])

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === "c") {
      handleCtrlC()
      return
    }
    // Input is NEVER blocked — user can type while agent responds (TTFA)

    // Any non-Ctrl-C input clears tooltip
    setTooltip("")

    if (key.escape) {
      lastEscTime.current = Date.now()
      // Defer ESC action — if another key arrives within 80ms, this was an escape
      // sequence prefix (arrow key, Alt+Enter), not a standalone Escape press.
      if (escTimerRef.current) clearTimeout(escTimerRef.current)
      escTimerRef.current = setTimeout(() => {
        escTimerRef.current = null
        if (inputRef.current) {
          // Save to history before clearing (so Up arrow can retrieve it)
          if (onHistoryAdd) onHistoryAdd(inputRef.current)
          updateInput("")
          historyIdx.current = -1
          setTooltip("Esc again to clear")
          if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current)
          tooltipTimerRef.current = setTimeout(() => setTooltip(""), 2000)
        } else if (queuedInputs.length > 0) {
          const items = onPopQueue()
          updateInput(items.join("\n"))
          historyIdx.current = -1
        } else {
          setTooltip("")
        }
      }, 80)
      return
    }
    // Cancel pending ESC action — this key is part of an escape sequence
    if (escTimerRef.current) {
      clearTimeout(escTimerRef.current)
      escTimerRef.current = null
    }
    // PageUp/PageDown: suppress (no text insertion, no action)
    if (key.pageUp || key.pageDown) return
    if (key.return) {
      // Alt+Enter: detect via key.meta OR recent ESC (within 50ms — Ink splits \x1b\r)
      const recentEsc = (Date.now() - lastEscTime.current) < 50
      if (key.meta || key.shift || recentEsc) {
        lastEscTime.current = 0
        const before = inputRef.current.slice(0, cursorRef.current)
        const after = inputRef.current.slice(cursorRef.current)
        updateInput(before + "\n" + after, cursorRef.current + 1)
        return
      }
      // Backslash+Enter: insert newline (like Claude Code)
      if (cursorRef.current > 0 && inputRef.current[cursorRef.current - 1] === "\\") {
        const before = inputRef.current.slice(0, cursorRef.current - 1)
        const after = inputRef.current.slice(cursorRef.current)
        updateInput(before + "\n" + after, cursorRef.current)
        return
      }
      const text = inputRef.current
      if (text.trim()) {
        const { text: processedText, images } = processSubmitInput(text)
        if (images.size > 0 && onImageMap) {
          onImageMap(images)
        }
        onSubmit(images.size > 0 ? processedText : text)
      }
      updateInput("")
      historyIdx.current = -1
      return
    }
    // Backspace / Delete: Ink 3.2 maps \x7f (macOS backspace) to key.delete,
    // and \x08 to key.backspace. Both mean "delete backward" on macOS.
    // Only \x1b[3~ (fn+Backspace) is true forward-delete — but Ink also maps
    // it to key.delete. We treat key.backspace OR key.delete as backspace
    // (since \x7f is the common case), and handle forward-delete via Ctrl+D.
    if (key.backspace || key.delete) {
      if (cursorRef.current > 0) {
        // Token-aware: check for image ref chip before cursor
        const chip = deleteTokenBefore(inputRef.current, cursorRef.current)
        if (chip) {
          updateInput(chip.text, chip.pos)
        } else if (key.meta) {
          // Option+Backspace: delete word (also pushes to kill ring)
          const result = handleKillWordBack(inputRef.current, cursorRef.current, killRing)
          updateInput(result.text, result.cursorPos)
        } else {
          const result = handleBackspace(inputRef.current, cursorRef.current)
          updateInput(result.text, result.cursorPos)
        }
      }
      historyIdx.current = -1
      return
    }
    // Left/right arrow: move cursor (char by char, token-aware)
    // NOTE: Ink 3.2 bug — key.meta is ALWAYS true for arrow keys because all
    // arrows start with \x1b and Ink sets meta=true for any ESC-prefixed input.
    // Word-jump is handled via Meta+B/F (emacs bindings) instead.
    if (key.leftArrow) {
      const chipStart = imageRefEndingAt(inputRef.current, cursorRef.current)
      cursorRef.current = chipStart !== undefined ? chipStart : Math.max(0, cursorRef.current - 1)
      setCursorPos(cursorRef.current)
      return
    }
    if (key.rightArrow) {
      const chipEnd = imageRefStartingAt(inputRef.current, cursorRef.current)
      cursorRef.current = chipEnd !== undefined ? chipEnd : Math.min(inputRef.current.length, cursorRef.current + 1)
      setCursorPos(cursorRef.current)
      return
    }
    // Up/Down: queue pop takes priority over history
    if (key.upArrow) {
      // If not already browsing history and queue has items, pop queue into input
      if (historyIdx.current === -1 && queuedInputs.length > 0) {
        const items = onPopQueue()
        updateInput(items.join("\n"))
        return
      }
      // Otherwise, browse history
      if (history.length > 0) {
        if (historyIdx.current === -1) {
          savedInput.current = inputRef.current
          historyIdx.current = history.length - 1
        } else if (historyIdx.current > 0) {
          historyIdx.current--
        }
        updateInput(history[historyIdx.current])
      }
      return
    }
    if (key.downArrow) {
      if (historyIdx.current >= 0) {
        if (historyIdx.current < history.length - 1) {
          historyIdx.current++
          updateInput(history[historyIdx.current])
        } else {
          historyIdx.current = -1
          updateInput(savedInput.current)
        }
      }
      return
    }
    // Meta+B / Meta+F: word movement (emacs — Option+Arrow on macOS sends these)
    if (key.meta && inputChar === "b") {
      const before = inputRef.current.slice(0, cursorRef.current)
      const match = before.match(/(?:^|\s)\S+\s*$/)
      cursorRef.current = match ? Math.max(0, cursorRef.current - match[0].length + (match[0][0] === " " ? 1 : 0)) : 0
      setCursorPos(cursorRef.current)
      return
    }
    if (key.meta && inputChar === "f") {
      const after = inputRef.current.slice(cursorRef.current)
      const match = after.match(/^\s*\S+/)
      cursorRef.current = match ? Math.min(inputRef.current.length, cursorRef.current + match[0].length) : inputRef.current.length
      setCursorPos(cursorRef.current)
      return
    }
    // Meta+D: delete word forward
    if (key.meta && inputChar === "d") {
      const after = inputRef.current.slice(cursorRef.current)
      const match = after.match(/^\s*\S+/)
      if (match) {
        const before = inputRef.current.slice(0, cursorRef.current)
        const rest = after.slice(match[0].length)
        updateInput(before + rest, cursorRef.current)
      }
      return
    }
    // Ctrl+A / Ctrl+E: home / end
    if (key.ctrl && inputChar === "a") {
      cursorRef.current = 0
      setCursorPos(0)
      return
    }
    if (key.ctrl && inputChar === "e") {
      cursorRef.current = inputRef.current.length
      setCursorPos(inputRef.current.length)
      return
    }
    // ─── Emacs Navigation ─────────────────────────────────────────
    // Ctrl+B: cursor left
    if (key.ctrl && inputChar === "b") {
      cursorRef.current = handleCursorLeft(inputRef.current, cursorRef.current)
      setCursorPos(cursorRef.current)
      return
    }
    // Ctrl+F: cursor right
    if (key.ctrl && inputChar === "f") {
      cursorRef.current = handleCursorRight(inputRef.current, cursorRef.current)
      setCursorPos(cursorRef.current)
      return
    }
    // Ctrl+P: history up (same as up arrow)
    if (key.ctrl && inputChar === "p") {
      if (historyIdx.current === -1 && queuedInputs.length > 0) {
        const items = onPopQueue()
        updateInput(items.join("\n"))
        return
      }
      if (history.length > 0) {
        if (historyIdx.current === -1) {
          savedInput.current = inputRef.current
          historyIdx.current = history.length - 1
        } else if (historyIdx.current > 0) {
          historyIdx.current--
        }
        updateInput(history[historyIdx.current])
      }
      return
    }
    // Ctrl+N: history down (same as down arrow)
    if (key.ctrl && inputChar === "n") {
      if (historyIdx.current >= 0) {
        if (historyIdx.current < history.length - 1) {
          historyIdx.current++
          updateInput(history[historyIdx.current])
        } else {
          historyIdx.current = -1
          updateInput(savedInput.current)
        }
      }
      return
    }
    // Ctrl+H: token-aware backspace
    if (key.ctrl && inputChar === "h") {
      const chip = deleteTokenBefore(inputRef.current, cursorRef.current)
      if (chip) {
        updateInput(chip.text, chip.pos)
      } else {
        const result = handleBackspace(inputRef.current, cursorRef.current)
        updateInput(result.text, result.cursorPos)
      }
      historyIdx.current = -1
      return
    }
    // Ctrl+D: forward-delete when input present, exit when empty
    if (key.ctrl && inputChar === "d") {
      if (inputRef.current.length === 0) {
        handleCtrlC()
      } else {
        const result = handleForwardDelete(inputRef.current, cursorRef.current)
        updateInput(result.text, result.cursorPos)
      }
      return
    }
    // ─── Kill Ring Keybindings ─────────────────────────────────────
    // Ctrl+K: kill from cursor to end of line
    if (key.ctrl && inputChar === "k") {
      const result = handleKillToEnd(inputRef.current, cursorRef.current, killRing)
      updateInput(result.text, result.cursorPos)
      return
    }
    // Ctrl+U: kill from start to cursor
    if (key.ctrl && inputChar === "u") {
      const result = handleKillToStart(inputRef.current, cursorRef.current, killRing)
      updateInput(result.text, result.cursorPos)
      return
    }
    // Ctrl+W: kill word before cursor (token-aware)
    if (key.ctrl && inputChar === "w") {
      const chip = deleteTokenBefore(inputRef.current, cursorRef.current)
      if (chip) {
        updateInput(chip.text, chip.pos)
      } else {
        const result = handleKillWordBack(inputRef.current, cursorRef.current, killRing)
        updateInput(result.text, result.cursorPos)
      }
      return
    }
    // Ctrl+Y: yank from kill ring
    if (key.ctrl && inputChar === "y") {
      const result = handleYank(inputRef.current, cursorRef.current, killRing)
      if (result) updateInput(result.text, result.cursorPos)
      return
    }
    // Alt+Y: yank-pop (cycle kill ring)
    if (key.meta && inputChar === "y") {
      const result = handleYankPop(inputRef.current, cursorRef.current, killRing)
      if (result) updateInput(result.text, result.cursorPos)
      return
    }
    // ─── Non-kill/non-yank keystroke resets ────────────────────────
    killRing.resetAccumulation()
    killRing.resetYankState()
    // Detect raw escape sequences — Ink 3.2 strips \x1b prefix and sets key.meta,
    // so we re-prepend it for classification when meta is set and inputChar starts with [
    const escInput = key.meta && inputChar.startsWith("[") ? "\x1b" + inputChar : inputChar
    const escClass = classifyEscapeSequence(escInput)
    if (escClass === "home") {
      cursorRef.current = handleHome(inputRef.current, cursorRef.current)
      setCursorPos(cursorRef.current)
      return
    }
    if (escClass === "end") {
      cursorRef.current = handleEnd(inputRef.current, cursorRef.current)
      setCursorPos(cursorRef.current)
      return
    }
    if (escClass === "word-left") {
      const before = inputRef.current.slice(0, cursorRef.current)
      const match = before.match(/(?:^|\s)\S+\s*$/)
      cursorRef.current = match ? Math.max(0, cursorRef.current - match[0].length + (match[0].startsWith(" ") ? 1 : 0)) : 0
      setCursorPos(cursorRef.current)
      return
    }
    if (escClass === "word-right") {
      const after = inputRef.current.slice(cursorRef.current)
      const match = after.match(/^\s*\S+/)
      cursorRef.current = match ? Math.min(inputRef.current.length, cursorRef.current + match[0].length) : inputRef.current.length
      setCursorPos(cursorRef.current)
      return
    }
    if (escClass === "ignore") return
    // Regular character: insert at cursor position
    if (!key.ctrl && !key.meta && inputChar) {
      const before = inputRef.current.slice(0, cursorRef.current)
      const after = inputRef.current.slice(cursorRef.current)
      updateInput(before + inputChar + after, cursorRef.current + inputChar.length)
      historyIdx.current = -1
    }
  })



  const isMultiline = input.includes("\n")
  const inputLines = input.split("\n")

  return (
    <Box flexDirection="column">
      {/* Top separator — full terminal width (no margin) */}
      <Text dimColor>{"─".repeat(termWidth())}</Text>
      {/* Input prompt — multi-line shows each line with continuation marker */}
      {isMultiline ? (
        <Box flexDirection="column">
          {inputLines.map((line, i) => (
            <Box key={i}>
              <Text color={OURO.teal} bold>{i === 0 ? ") " : "· "}</Text>
              <Text color={OURO.bone}>{line}</Text>
              {i === inputLines.length - 1 ? (
                cursorVisible ? <Text backgroundColor={OURO.scale} color="#000000">{" "}</Text> : <Text>{" "}</Text>
              ) : null}
            </Box>
          ))}
        </Box>
      ) : (
        <Box>
          <Text wrap="wrap">{(() => {
            const prompt = `\x1b[1m\x1b[38;2;78;201;176m) \x1b[0m`
            if (!input && queuedInputs.length > 0) {
              return `${prompt}\x1b[38;2;112;131;115mPress up to edit queued messages\x1b[0m`
            }
            const beforeCursor = `\x1b[38;2;238;242;234m${input.slice(0, cursorPos)}\x1b[0m`
            const cursorChar = input[cursorPos] ?? " "
            const cursor = cursorVisible
              ? `\x1b[48;2;47;143;78m\x1b[38;2;0;0;0m${cursorChar}\x1b[0m`
              : `\x1b[38;2;238;242;234m${cursorChar}\x1b[0m`
            const afterCursor = `\x1b[38;2;238;242;234m${input.slice(cursorPos + 1)}\x1b[0m`
            return `${prompt}${beforeCursor}${cursor}${afterCursor}`
          })()}</Text>
        </Box>
      )}
      {/* Bottom separator — full terminal width (no margin) */}
      <Text dimColor>{"─".repeat(termWidth())}</Text>
      {/* Status + hints + tooltip — BELOW the box */}
      <Box>
        <Text dimColor>{"  "}{agentName}{model ? ` · ${model}` : ""} · /help</Text>
        <Box flexGrow={1} />
        {tooltip ? <Text dimColor>{tooltip}</Text> : <Text dimColor>{"opt+enter for newline"}</Text>}
      </Box>
    </Box>
  )
}

// ─── Main TUI Component ─────────────────────────────────────────────

export function OuroTui({
  agentName,
  model,
  completedMessages,
  inputHistory,
  queuedInputs,
  live,
  elapsedSeconds,
  contextPercent,
  onSubmit,
  onCtrlC,
  onPopQueue,
  cwd,
  resumeInfo,
  onImageMap,
  onHistoryAdd,
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
                <Header agentName={agentName} model={model} contextPercent={contextPercent} cwd={cwd} resumeInfo={resumeInfo} />
                <Text color={OURO.shadow} dimColor>{"  Ctrl-C twice to exit \u00b7 \u2191\u2193 history \u00b7 Esc clear \u00b7 opt+Enter newline"}</Text>
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

      {/* Queued messages — between live area and input */}
      {queuedInputs.length > 0 ? <QueuedMessages items={queuedInputs} /> : null}

      {/* Input */}
      <Box marginTop={1}><Text>{""}</Text></Box>
      <InputArea
        onSubmit={onSubmit}
        onCtrlC={onCtrlC}
        history={inputHistory}
        queuedInputs={queuedInputs}
        onPopQueue={onPopQueue}
        agentName={agentName}
        model={model}
        onImageMap={onImageMap}
        onHistoryAdd={onHistoryAdd}
      />
    </Box>
  )
}
