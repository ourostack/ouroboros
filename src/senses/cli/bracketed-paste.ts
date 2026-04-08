/**
 * Bracketed paste mode handler for the TUI.
 *
 * Detects \x1b[200~ (paste start) and \x1b[201~ (paste end) markers in
 * raw stdin data. Buffers paste content between markers and emits it as
 * a single "paste" event. Non-paste data is emitted as "data" unchanged.
 *
 * Works alongside Ink's stdin handling by intercepting raw data events.
 */
import { EventEmitter } from "events"

const PASTE_START = "\x1b[200~"
const PASTE_END = "\x1b[201~"

export class BracketedPasteHandler extends EventEmitter {
  private pasting = false
  private buffer = ""
  private readonly dataHandler: (chunk: Buffer) => void

  constructor(
    private readonly stdin: NodeJS.ReadStream,
    private readonly stdout: NodeJS.WriteStream,
  ) {
    super()

    // Enable bracketed paste mode
    stdout.write("\x1b[?2004h")

    this.dataHandler = (chunk: Buffer) => {
      this.processChunk(chunk.toString())
    }

    stdin.prependListener("data", this.dataHandler)
  }

  private processChunk(data: string): void {
    let remaining = data

    while (remaining.length > 0) {
      if (this.pasting) {
        // Look for end marker in buffer + remaining
        const combined = this.buffer + remaining
        const endIdx = combined.indexOf(PASTE_END)

        if (endIdx !== -1) {
          // Found end marker -- emit paste content
          const pasteContent = combined.slice(0, endIdx)
          this.emit("paste", pasteContent)
          this.buffer = ""
          this.pasting = false

          // Process remaining data after end marker
          remaining = combined.slice(endIdx + PASTE_END.length)
          continue
        }

        // No end marker yet -- buffer everything so far
        this.buffer = combined
        return
      }

      // Not pasting -- look for start marker
      const startIdx = remaining.indexOf(PASTE_START)

      if (startIdx !== -1) {
        // Emit any data before the start marker
        const before = remaining.slice(0, startIdx)
        if (before.length > 0) {
          this.emit("data", before)
        }

        // Enter paste mode
        this.pasting = true
        this.buffer = ""
        remaining = remaining.slice(startIdx + PASTE_START.length)
        continue
      }

      // No start marker -- emit as regular data
      this.emit("data", remaining)
      return
    }
  }

  /** Disable bracketed paste mode and remove listeners. */
  destroy(): void {
    this.stdout.write("\x1b[?2004l")
    this.stdin.removeListener("data", this.dataHandler)
    this.removeAllListeners()
  }
}
