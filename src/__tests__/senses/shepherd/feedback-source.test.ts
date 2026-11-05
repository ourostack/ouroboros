import { describe, expect, it } from "vitest"
import { resolveFeedbackOrigin } from "../../../senses/shepherd/feedback-source"

describe("native-session feedback origin", () => {
  it("runs the bounded native inspector and reports an absent controlling TTY honestly", async () => {
    try {
      expect((await resolveFeedbackOrigin()).tty).toMatch(/^\/dev\/(?:tty[s]?[A-Za-z0-9]+|pts\/[0-9]+)$/)
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain("controlling terminal is unavailable")
    }
  })

  it("uses the bridge's own controlling terminal even when its stdio belongs to the MCP protocol", async () => {
    const origin = await resolveFeedbackOrigin(async (command, args) => {
      expect(command).toBe("/bin/ps")
      expect(args).toEqual(["-p", String(process.pid), "-o", "tty="])
      return "  ttys042\n"
    })
    expect(origin).toEqual({ tty: "/dev/ttys042" })
  })

  it("preserves a Linux PTY coordinate without reading GUI focus", async () => {
    expect(await resolveFeedbackOrigin(async () => "pts/42\n")).toEqual({ tty: "/dev/pts/42" })
  })

  it.each(["??", "", "ttys001\n tt ys002", "../ttys001", "/private/terminal"])("rejects missing or ambiguous native origin %j", async value => {
    await expect(resolveFeedbackOrigin(async () => value)).rejects.toThrow("terminal")
  })

  it("surfaces OS lookup failure instead of inventing a terminal", async () => {
    await expect(resolveFeedbackOrigin(async () => { throw new Error("inspection timed out") })).rejects.toThrow("timed out")
  })
})
