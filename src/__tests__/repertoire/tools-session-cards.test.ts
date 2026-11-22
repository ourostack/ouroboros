import { describe, expect, it } from "vitest"
import { sessionToolDefinitions } from "../../repertoire/tools-session"

const tool = (name: string) => sessionToolDefinitions.find((d) => d.tool.function.name === name)!

describe("session tools' Ouro AX cards", () => {
  it("gives every session tool a card named after it, with reads backed by a profile that changes nothing", () => {
    for (const def of sessionToolDefinitions) {
      expect(def.ax?.id).toBe(`tool:${def.tool.function.name}`)
      expect(def.ax?.group).toBe("turn-sessions")
    }
    for (const name of ["query_active_work", "session_summary", "query_session"]) {
      expect(tool(name).ax?.effect).toBe("read")
      expect(tool(name).riskProfile).toMatchObject({ mutates: "none", risk: "low" })
    }
    expect(tool("send_message").ax?.effect).toBe("write")
    expect(tool("set_reasoning_effort").ax?.effect).toBe("write")
  })
})
