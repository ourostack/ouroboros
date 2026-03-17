function splitLongWord(word: string, width: number): string[] {
  const chunks: string[] = []
  for (let index = 0; index < word.length; index += width) {
    chunks.push(word.slice(index, index + width))
  }
  return chunks
}

export function wrapCliText(text: string, cols: number): string[] {
  const width = Math.max(cols, 1)
  const wrapped: string[] = []

  for (const rawLine of text.split("\n")) {
    if (rawLine.trim().length === 0) {
      wrapped.push("")
      continue
    }

    const words = rawLine.trim().split(/\s+/)
    let current = ""

    for (const word of words) {
      if (!current) {
        if (word.length <= width) {
          current = word
          continue
        }

        const chunks = splitLongWord(word, width)
        wrapped.push(...chunks.slice(0, -1))
        current = chunks[chunks.length - 1]
        continue
      }

      const candidate = `${current} ${word}`
      if (candidate.length <= width) {
        current = candidate
        continue
      }

      wrapped.push(current)
      if (word.length <= width) {
        current = word
        continue
      }

      const chunks = splitLongWord(word, width)
      wrapped.push(...chunks.slice(0, -1))
      current = chunks[chunks.length - 1]
    }

    wrapped.push(current)
  }

  return wrapped
}

function countEchoedInputRows(input: string, cols: number): number {
  const width = Math.max(cols, 1)
  return input.split("\n").reduce((sum, line, index) => {
    const promptWidth = index === 0 ? 2 : 0
    return sum + Math.max(1, Math.ceil((promptWidth + line.length) / width))
  }, 0)
}

export function formatEchoedInputSummary(input: string, cols: number): string {
  const inputLines = input.split("\n")
  const summary = `> ${inputLines[0]}${inputLines.length > 1 ? ` (+${inputLines.length - 1} lines)` : ""}`
  const wrappedSummary = wrapCliText(summary, cols)
  const echoRows = countEchoedInputRows(input, cols)

  let output = `\x1b[${echoRows}A`
  for (let i = 0; i < echoRows; i += 1) {
    output += "\r\x1b[K"
    if (i < echoRows - 1) {
      output += "\x1b[1B"
    }
  }
  if (echoRows > 1) {
    output += `\x1b[${echoRows - 1}A`
  }

  output += `\x1b[1m${wrappedSummary.join("\n")}\x1b[0m\n\n`
  return output
}
