import React, { useState, useCallback, useRef } from "react"
import { Text, Box, useInput } from "ink"
import { StreamingMarkdown } from "./streaming-markdown"

/**
 * Ouroboros CLI TUI — Ink application shell.
 *
 * Replaces the imperative readline-based CLI with a React/Ink component tree.
 * Provides: message list, input area, spinner, tool result display.
 *
 * Design: Ouroboros-themed (green serpent), NOT Claude/Anthropic design language.
 * Copy-paste integrity: no padding characters. Visual hierarchy via color/bold/dim only.
 */

// Ouroboros brand palette
const OURO_GREEN = "#2ecc40"
const OURO_TEAL = "#4ec9b0"
const OURO_DIM = true

// Snake-themed spinner frames: serpent eating its own tail
const SNAKE_FRAMES = [
  "\u{1F40D}\u2003",  // snake emoji
  "\u25E0\u2003",     // upper half circle
  "\u25D4\u2003",     // circle with upper right quadrant
  "\u25D1\u2003",     // circle with right half
  "\u25D5\u2003",     // circle with all but upper left quadrant
  "\u25E1\u2003",     // lower half circle
  "\u{1F40D}\u2003",  // snake emoji again
  "\u25CB\u2003",     // white circle (tail eaten)
]

export interface ToolResult {
  toolCallId: string
  name: string
  result: string
  success: boolean
}

export interface DisplayMessage {
  role: "user" | "assistant" | "system"
  content?: string | null
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
}

interface InkAppProps {
  /** Messages to display */
  readonly messages: readonly DisplayMessage[]
  /** Called when user submits input */
  readonly onSubmit?: (text: string) => void
  /** Show spinner with this text */
  readonly loading?: boolean
  /** Spinner message */
  readonly spinnerText?: string
  /** Tool execution results to display */
  readonly toolResults?: readonly ToolResult[]
  /** Terminal width override for testing */
  readonly columns?: number
}

function UserMessage({ content }: { readonly content: string }): React.ReactElement {
  return (
    <Box>
      <Text color={OURO_TEAL} bold>{") "}</Text>
      <Text>{content}</Text>
    </Box>
  )
}

function AssistantMessage({ content }: { readonly content: string }): React.ReactElement {
  return (
    <Box>
      <StreamingMarkdown text={content} />
    </Box>
  )
}

function ToolCallDisplay({ toolCall }: {
  readonly toolCall: { id: string; type: "function"; function: { name: string; arguments: string } }
}): React.ReactElement {
  let argSummary = ""
  try {
    const args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>
    const first = Object.values(args)[0]
    if (typeof first === "string") argSummary = first.length > 60 ? first.slice(0, 57) + "..." : first
  } catch {
    argSummary = toolCall.function.arguments.slice(0, 60)
  }
  return (
    <Box>
      <Text color={OURO_GREEN} bold>{toolCall.function.name}</Text>
      {argSummary ? <Text dimColor> {argSummary}</Text> : null}
    </Box>
  )
}

function ToolResultDisplay({ result }: { readonly result: ToolResult }): React.ReactElement {
  const color = result.success ? OURO_GREEN : "#e74c3c"
  const icon = result.success ? "\u2713" : "\u2717"
  const summary = result.result.length > 120
    ? result.result.slice(0, 117) + "..."
    : result.result
  return (
    <Box>
      <Text color={color}>{icon} {result.name}</Text>
      <Text dimColor> {summary.replace(/\n/g, " ")}</Text>
    </Box>
  )
}

function SpinnerComponent({ text, frame }: { readonly text: string; readonly frame: number }): React.ReactElement {
  const char = SNAKE_FRAMES[frame % SNAKE_FRAMES.length]
  return (
    <Box>
      <Text color={OURO_GREEN}>{char}</Text>
      <Text dimColor={OURO_DIM}>{text}...</Text>
    </Box>
  )
}

function InputArea({
  onSubmit,
}: {
  readonly onSubmit?: (text: string) => void
}): React.ReactElement {
  const [input, setInput] = useState("")
  // Ref tracks the latest input value so useInput callback always sees current state
  const inputRef = useRef("")

  useInput((inputChar, key) => {
    if (key.return) {
      if (inputRef.current.trim() && onSubmit) {
        onSubmit(inputRef.current)
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
    if (!key.ctrl && !key.meta && inputChar) {
      inputRef.current += inputChar
      setInput(inputRef.current)
    }
  })

  return (
    <Box>
      <Text color={OURO_TEAL} bold>{") "}</Text>
      <Text>{input}</Text>
    </Box>
  )
}

function MessageList({
  messages,
  toolResults,
}: {
  readonly messages: readonly DisplayMessage[]
  readonly toolResults?: readonly ToolResult[]
}): React.ReactElement {
  const toolResultMap = new Map<string, ToolResult>()
  if (toolResults) {
    for (const tr of toolResults) {
      toolResultMap.set(tr.toolCallId, tr)
    }
  }

  return (
    <Box flexDirection="column">
      {messages.map((msg, i) => {
        if (msg.role === "user" && msg.content) {
          return <UserMessage key={i} content={msg.content} />
        }
        if (msg.role === "assistant") {
          return (
            <Box key={i} flexDirection="column">
              {msg.content ? <AssistantMessage content={msg.content} /> : null}
              {msg.tool_calls?.map(tc => {
                const tr = toolResultMap.get(tc.id)
                return (
                  <Box key={tc.id} flexDirection="column">
                    <ToolCallDisplay toolCall={tc} />
                    {tr ? <ToolResultDisplay result={tr} /> : null}
                  </Box>
                )
              })}
            </Box>
          )
        }
        return null
      })}
    </Box>
  )
}

export function InkApp({
  messages,
  onSubmit,
  loading,
  spinnerText,
  toolResults,
}: InkAppProps): React.ReactElement {
  const [spinnerFrame, setSpinnerFrame] = useState(0)

  // Animate spinner
  React.useEffect(() => {
    if (!loading) return
    const iv = setInterval(() => {
      setSpinnerFrame(f => (f + 1) % SNAKE_FRAMES.length)
    }, 120)
    return () => clearInterval(iv)
  }, [loading])

  const handleSubmit = useCallback((text: string) => {
    onSubmit?.(text)
  }, [onSubmit])

  return (
    <Box flexDirection="column">
      <MessageList messages={messages} toolResults={toolResults} />
      {loading && spinnerText ? (
        <SpinnerComponent text={spinnerText} frame={spinnerFrame} />
      ) : null}
      <InputArea onSubmit={handleSubmit} />
    </Box>
  )
}
