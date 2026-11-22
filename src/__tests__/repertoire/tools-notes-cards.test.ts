import { describe, expect, it, vi } from "vitest"

vi.mock("child_process", () => ({ spawnSync: vi.fn() }))
vi.mock("../../repertoire/skills", () => ({
  listSkills: vi.fn(() => []),
  loadSkill: vi.fn(() => { throw new Error("skill 'nope' not found") }),
}))
vi.mock("../../heart/config", () => ({ getIntegrationsConfig: vi.fn(() => ({})) }))

import { spawnSync } from "child_process"
import { notesToolDefinitions } from "../../repertoire/tools-notes"

const tool = (name: string) => notesToolDefinitions.find((d) => d.tool.function.name === name)!
const call = (name: string, args: Record<string, string>, ctx?: unknown) => tool(name).handler(args, ctx as never)

describe("notes tools' Ouro AX cards", () => {
  it("gives every notes tool a card named after it, with reads backed by a profile that changes nothing", () => {
    for (const def of notesToolDefinitions) {
      expect(def.ax?.id).toBe(`tool:${def.tool.function.name}`)
      expect(def.ax?.group).toMatch(/^turn-(skills|web|record|friends)$/)
    }
    for (const name of ["list_skills", "load_skill", "web_search", "search_facts", "consult_diary", "friend_list", "get_friend_note"]) {
      expect(tool(name).ax?.effect).toBe("read")
      expect(tool(name).riskProfile).toEqual({ mutates: "none", risk: "low" })
    }
    expect(tool("claude").ax?.effect).toBe("read")
    expect(tool("diary_write").ax?.effect).toBe("write")
    expect(tool("save_friend_note").ax?.effect).toBe("write")
  })

  it("ends each refusal with the code its card names", async () => {
    expect(await call("load_skill", { name: "nope" })).toBe("error: Error: skill 'nope' not found (code: skill-not-found)")
    vi.mocked(spawnSync).mockReturnValueOnce({ error: new Error("spawn claude ENOENT") } as never)
    expect(await call("claude", { prompt: "p" })).toBe("error: Error: spawn claude ENOENT (code: claude-not-started)")
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 2, stderr: "bad" } as never)
    expect(await call("claude", { prompt: "p" })).toBe("claude exited with code 2: bad (code: claude-failed)")
    expect(await call("web_search", { query: "q" })).toBe("error: perplexityApiKey not configured in the agent vault runtime/config item (code: search-not-configured)")
    expect(await call("search_facts", { query: " " })).toBe("query is required (code: missing-argument)")
    expect(await call("diary_write", { entry: " " })).toBe("entry is required (code: missing-argument)")
    expect(await call("friend_list", {})).toBe("i can't list friends -- friend store not available (code: friend-store-unavailable)")
    expect(await call("get_friend_note", {})).toBe("friendId is required (code: missing-argument)")
    expect(await call("get_friend_note", { friendId: "f" })).toBe("i can't read friend notes -- friend store not available (code: friend-store-unavailable)")
    expect(await call("save_friend_note", { type: "note", content: "x" })).toBe("i can't save notes -- no friend context available (code: no-friend-context)")
  })
})
