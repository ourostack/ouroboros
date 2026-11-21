import { describe, it, expect, vi } from "vitest"
import { shellToolDefinitions } from "../../repertoire/tools-shell"
import { webToolDefinitions } from "../../repertoire/tools-web"
import { formatTelegramApprovalPrompt } from "../../senses/telegram-approval-runtime"

vi.mock("../../repertoire/shell-sessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../repertoire/shell-sessions")>()),
  getShellSession: () => undefined,
  tailShellSession: () => undefined,
}))

const shell = (name: string) => shellToolDefinitions.find((d) => d.tool.function.name === name)!
const ctx = { agentName: "card-test", agentRoot: "/tmp/card-test" }

describe("shell and web tools' Ouro AX cards", () => {
  it("gives each tool a card named after it, in its own group", () => {
    for (const def of shellToolDefinitions) {
      expect(def.ax?.id).toBe(`tool:${def.tool.function.name}`)
      expect(def.ax?.group).toBe("turn-shell")
    }
    expect(webToolDefinitions[0].ax?.id).toBe("tool:fetch_url")
    expect(webToolDefinitions[0].ax?.group).toBe("turn-web")
  })

  it("says shell asks for approval, in the words the approval prompt uses", () => {
    expect(shell("shell").ax?.effect).toBe("consequential")
    const prompt = formatTelegramApprovalPrompt("shell", { command: "docker restart x" })
    expect(prompt).toBe('Approve shell with exact arguments {"command":"docker restart x"}?')
    expect(shell("shell").ax?.confirm).toBe("Approve shell with exact arguments <the call's arguments as JSON>?")
  })

  it("backs each read card with a profile that changes nothing", () => {
    for (const def of [shell("shell_status"), shell("shell_tail"), webToolDefinitions[0]]) {
      expect(def.ax?.effect).toBe("read")
      expect(def.riskProfile).toEqual({ mutates: "none", risk: "low" })
    }
  })

  it("ends a missing background process with the code its cards name", async () => {
    expect(await shell("shell_status").handler({ id: "gone" }, ctx as never)).toBe("process not found: gone (code: process-not-found)")
    expect(await shell("shell_tail").handler({ id: "gone" }, ctx as never)).toBe("process not found: gone (code: process-not-found)")
  })

  it("ends fetch_url's refusals of an address with the code its card names", async () => {
    const run = (url: string) => webToolDefinitions[0].handler({ url })
    expect(await run("not a url")).toBe("error: not a valid URL: not a url (code: invalid-url)")
    expect(await run("ftp://example.com/x")).toBe("error: only http and https URLs can be fetched, not ftp: (code: invalid-url)")
    expect(await run("http://127.0.0.1/")).toBe("error: refused: 127.0.0.1 resolves to a private or local address (127.0.0.1) (code: private-address)")
  })
})
