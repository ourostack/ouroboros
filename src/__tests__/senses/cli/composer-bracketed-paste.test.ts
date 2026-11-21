import { EventEmitter } from "events"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { bracketedPasteText, pasteOpenAfter, plainInputText } from "../../../senses/cli/input-keys"

class FakeStdin extends EventEmitter {
  isTTY = true
  isRaw = false
  setRawMode = vi.fn((mode: boolean) => {
    this.isRaw = mode
    return this
  })
  setEncoding(): this { return this }
  resume(): this { return this }
  pause(): this { return this }
  ref(): this { return this }
  unref(): this { return this }
  read(): null { return null }
}

class FakeStdout extends EventEmitter {
  isTTY = true
  columns = 100
  rows = 60
  write = (): boolean => true
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

describe("bracketedPasteText", () => {
  it("returns null when the input holds no paste marker", () => {
    expect(bracketedPasteText("hello")).toBeNull()
    expect(bracketedPasteText("\x1b[H")).toBeNull()
  })

  it("returns the pasted text with both markers removed and line endings as \\n", () => {
    expect(bracketedPasteText("\x1b[200~Plan Friday\r\nthen fly\x1b[201~")).toBe("Plan Friday\nthen fly")
  })

  it("returns the text of a paste split across chunks, and nothing for a lone marker", () => {
    expect(bracketedPasteText("\x1b[200~Plan Fri")).toBe("Plan Fri")
    expect(bracketedPasteText("day\x1b[201~")).toBe("day")
    expect(bracketedPasteText("\x1b[201~")).toBe("")
  })

  it("removes escape sequences and control bytes, keeping newlines and tabs", () => {
    const raw = "\x1b[200~\x1b[2Jred \x1b[31mtext\x1b[0m\x1b]0;title\x07 link\x1b]8;;https://x\x1b\\ ok\x07\x08\ta\nb\x1b[201~"
    expect(bracketedPasteText(raw)).toBe("red text link ok\ta\nb")
  })
})

describe("plainInputText", () => {
  it("keeps ordinary text and drops escape sequences and C0/C1 controls", () => {
    expect(plainInputText("a[b]~c ü 日本 🎉 x~y [1] {}")).toBe("a[b]~c ü 日本 🎉 x~y [1] {}")
    expect(plainInputText("text\x1b]0;title\x07 more\x9b2J\r\n")).toBe("text more2J\n")
  })
})

describe("pasteOpenAfter", () => {
  it("opens on a start marker, closes on an end marker, and keeps its state otherwise", () => {
    expect(pasteOpenAfter("\x1b[200~Plan", false)).toBe(true)
    expect(pasteOpenAfter(" Friday", true)).toBe(true)
    expect(pasteOpenAfter(" Friday", false)).toBe(false)
    expect(pasteOpenAfter("day\x1b[201~", true)).toBe(false)
    expect(pasteOpenAfter("\x1b[200~a\x1b[201~", false)).toBe(false)
    expect(pasteOpenAfter("\x1b[201~\x1b[200~b", false)).toBe(true)
  })
})

async function renderComposer() {
  const { render } = await import("ink")
  const { OuroTui } = await import("../../../senses/cli/ouro-tui")
  const stdin = new FakeStdin()
  const onSubmit = vi.fn()
  const instance = render(React.createElement(OuroTui, {
    agentName: "slugger",
    model: "test-model",
    completedMessages: [],
    inputHistory: [],
    queuedInputs: [],
    live: {
      streamingText: "",
      loading: false,
      spinnerPhrase: "",
      spinnerPhrasePool: [],
      activeTool: null,
      errorMessage: null,
      kickMessage: null,
      inputSuppressed: false,
    },
    elapsedSeconds: 0,
    contextPercent: 0,
    onSubmit,
    onCtrlC: () => "clear" as const,
    onPopQueue: () => [],
    headerShown: true,
    cwd: "~",
  }), {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  })
  const send = async (...chunks: string[]) => {
    for (const chunk of chunks) {
      stdin.emit("data", chunk)
      await settle()
    }
  }
  await settle()
  return { onSubmit, send, unmount: () => instance.unmount() }
}

describe("composer and bracketed paste", () => {
  it("types a pasted prompt into the composer and sends it on Enter", async () => {
    const composer = await renderComposer()
    try {
      // One chunk, as Orca sends a launch prompt.
      await composer.send("\x1b[200~Plan Friday: lunch with Sam\x1b[201~", "\r")
      expect(composer.onSubmit).toHaveBeenCalledWith("Plan Friday: lunch with Sam")
    } finally {
      composer.unmount()
    }
  })

  it("keeps a paste split across chunks whole, and a lone \\r inside it does not send", async () => {
    const composer = await renderComposer()
    try {
      await composer.send("\x1b[200~Plan Friday", "\r", "then fly\x1b[201~")
      expect(composer.onSubmit).not.toHaveBeenCalled()
      await composer.send("\r")
      expect(composer.onSubmit).toHaveBeenCalledWith("Plan Friday\nthen fly")
    } finally {
      composer.unmount()
    }
  })

  it("lets Enter send again when a paste's end marker never arrives", async () => {
    const composer = await renderComposer()
    try {
      await composer.send("\x1b[200~Plan Friday")
      await new Promise((resolve) => setTimeout(resolve, 250))
      await composer.send("\r")
      expect(composer.onSubmit).toHaveBeenCalledWith("Plan Friday")
    } finally {
      composer.unmount()
    }
  })

  it("cleans a paste's middle chunk too", async () => {
    const composer = await renderComposer()
    try {
      await composer.send("\x1b[200~one ", "two\x1b]0;title\x07 three", "\x1b[201~", "\r")
      expect(composer.onSubmit).toHaveBeenCalledWith("one two three")
    } finally {
      composer.unmount()
    }
  })

  it("pastes at the cursor in the middle of typed text", async () => {
    const composer = await renderComposer()
    try {
      // Ctrl+A moves to the start of the line.
      await composer.send("lunch", "\x01", "\x1b[200~Friday \x1b[201~", "!", "\r")
      expect(composer.onSubmit).toHaveBeenCalledWith("Friday !lunch")
    } finally {
      composer.unmount()
    }
  })

  it("ends a yank, so Alt+Y after a paste leaves the pasted text alone", async () => {
    const composer = await renderComposer()
    try {
      // Ctrl+W kills "foo " into the ring; Ctrl+Y yanks it back; then a paste; then Alt+Y.
      await composer.send("foo ", "\x17", "\x19", "\x1b[200~bar\x1b[201~", "\x1by", "\r")
      expect(composer.onSubmit).toHaveBeenCalledWith("foo bar")
    } finally {
      composer.unmount()
    }
  })
})
