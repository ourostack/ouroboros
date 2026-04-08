import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { EventEmitter } from "events"
import { BracketedPasteHandler } from "../../../senses/cli/bracketed-paste"

/** Fake stdin/stdout for testing */
function createFakeStdio() {
  const stdin = new EventEmitter() as EventEmitter & { setRawMode?: (mode: boolean) => void }
  const stdout = { write: vi.fn() } as unknown as NodeJS.WriteStream
  return { stdin, stdout }
}

describe("BracketedPasteHandler", () => {
  let stdio: ReturnType<typeof createFakeStdio>
  let handler: BracketedPasteHandler

  beforeEach(() => {
    stdio = createFakeStdio()
  })

  afterEach(() => {
    handler?.destroy()
  })

  it("writes enable sequence on creation", () => {
    handler = new BracketedPasteHandler(stdio.stdin as any, stdio.stdout)
    expect(stdio.stdout.write).toHaveBeenCalledWith("\x1b[?2004h")
  })

  it("writes disable sequence on destroy", () => {
    handler = new BracketedPasteHandler(stdio.stdin as any, stdio.stdout)
    ;(stdio.stdout.write as any).mockClear()
    handler.destroy()
    expect(stdio.stdout.write).toHaveBeenCalledWith("\x1b[?2004l")
  })

  it("emits paste event for content between start and end markers", () => {
    handler = new BracketedPasteHandler(stdio.stdin as any, stdio.stdout)
    const pasteSpy = vi.fn()
    handler.on("paste", pasteSpy)

    stdio.stdin.emit("data", Buffer.from("\x1b[200~hello world\x1b[201~"))

    expect(pasteSpy).toHaveBeenCalledWith("hello world")
  })

  it("buffers content across multiple data chunks", () => {
    handler = new BracketedPasteHandler(stdio.stdin as any, stdio.stdout)
    const pasteSpy = vi.fn()
    handler.on("paste", pasteSpy)

    stdio.stdin.emit("data", Buffer.from("\x1b[200~hello"))
    expect(pasteSpy).not.toHaveBeenCalled()

    stdio.stdin.emit("data", Buffer.from(" world\x1b[201~"))
    expect(pasteSpy).toHaveBeenCalledWith("hello world")
  })

  it("handles paste content containing newlines", () => {
    handler = new BracketedPasteHandler(stdio.stdin as any, stdio.stdout)
    const pasteSpy = vi.fn()
    handler.on("paste", pasteSpy)

    stdio.stdin.emit("data", Buffer.from("\x1b[200~line1\nline2\nline3\x1b[201~"))
    expect(pasteSpy).toHaveBeenCalledWith("line1\nline2\nline3")
  })

  it("passes through non-paste data unchanged via 'data' event", () => {
    handler = new BracketedPasteHandler(stdio.stdin as any, stdio.stdout)
    const dataSpy = vi.fn()
    handler.on("data", dataSpy)

    stdio.stdin.emit("data", Buffer.from("normal input"))
    expect(dataSpy).toHaveBeenCalledWith("normal input")
  })

  it("handles end marker split across two data chunks", () => {
    handler = new BracketedPasteHandler(stdio.stdin as any, stdio.stdout)
    const pasteSpy = vi.fn()
    handler.on("paste", pasteSpy)

    // Start paste
    stdio.stdin.emit("data", Buffer.from("\x1b[200~pasted text"))
    expect(pasteSpy).not.toHaveBeenCalled()

    // End marker split: "\x1b[201" in one chunk, "~" in next
    stdio.stdin.emit("data", Buffer.from("\x1b[201"))
    expect(pasteSpy).not.toHaveBeenCalled()

    stdio.stdin.emit("data", Buffer.from("~"))
    expect(pasteSpy).toHaveBeenCalledWith("pasted text")
  })

  it("handles empty paste (start marker immediately followed by end marker)", () => {
    handler = new BracketedPasteHandler(stdio.stdin as any, stdio.stdout)
    const pasteSpy = vi.fn()
    handler.on("paste", pasteSpy)

    stdio.stdin.emit("data", Buffer.from("\x1b[200~\x1b[201~"))
    expect(pasteSpy).toHaveBeenCalledWith("")
  })

  it("handles multiple pastes in sequence", () => {
    handler = new BracketedPasteHandler(stdio.stdin as any, stdio.stdout)
    const pasteSpy = vi.fn()
    handler.on("paste", pasteSpy)

    stdio.stdin.emit("data", Buffer.from("\x1b[200~first\x1b[201~"))
    stdio.stdin.emit("data", Buffer.from("\x1b[200~second\x1b[201~"))

    expect(pasteSpy).toHaveBeenCalledTimes(2)
    expect(pasteSpy).toHaveBeenNthCalledWith(1, "first")
    expect(pasteSpy).toHaveBeenNthCalledWith(2, "second")
  })

  it("does not emit data events while in paste-buffering mode", () => {
    handler = new BracketedPasteHandler(stdio.stdin as any, stdio.stdout)
    const dataSpy = vi.fn()
    handler.on("data", dataSpy)

    stdio.stdin.emit("data", Buffer.from("\x1b[200~paste content"))
    // Should not emit 'data' while buffering
    expect(dataSpy).not.toHaveBeenCalled()

    stdio.stdin.emit("data", Buffer.from("\x1b[201~"))
    // End of paste -- still no data event
    expect(dataSpy).not.toHaveBeenCalled()
  })

  it("handles data before and after paste markers in same chunk", () => {
    handler = new BracketedPasteHandler(stdio.stdin as any, stdio.stdout)
    const pasteSpy = vi.fn()
    const dataSpy = vi.fn()
    handler.on("paste", pasteSpy)
    handler.on("data", dataSpy)

    stdio.stdin.emit("data", Buffer.from("before\x1b[200~pasted\x1b[201~after"))

    expect(dataSpy).toHaveBeenCalledWith("before")
    expect(pasteSpy).toHaveBeenCalledWith("pasted")
    expect(dataSpy).toHaveBeenCalledWith("after")
  })

  it("removes stdin listener on destroy", () => {
    handler = new BracketedPasteHandler(stdio.stdin as any, stdio.stdout)
    handler.destroy()

    const dataSpy = vi.fn()
    handler.on("data", dataSpy)
    handler.on("paste", dataSpy)

    stdio.stdin.emit("data", Buffer.from("test"))
    // No events should fire after destroy
    expect(dataSpy).not.toHaveBeenCalled()
  })
})
