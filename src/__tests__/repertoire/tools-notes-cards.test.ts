import { describe, expect, it, vi } from "vitest"

vi.mock("child_process", () => ({ spawnSync: vi.fn() }))
vi.mock("../../repertoire/skills", () => ({
  listSkills: vi.fn(() => ["book-delivery", "media-requests"]),
  loadSkill: vi.fn(() => { throw new Error("skill 'nope' not found") }),
}))
vi.mock("../../heart/config", () => ({ getIntegrationsConfig: vi.fn(() => ({})) }))

import { spawnSync } from "child_process"
import { notesToolDefinitions } from "../../repertoire/tools-notes"

const tool = (name: string) => notesToolDefinitions.find((d) => d.tool.function.name === name)!
const call = (name: string, args: Record<string, string>, ctx?: unknown) => tool(name).handler(args, ctx as never)

describe("notes tools' Ouro AX cards", () => {
  it("answers an unknown skill name with the names the agent can load, never a tool it may not have", async () => {
    const result = await call("load_skill", { name: "media" })
    expect(result).toContain("Skills you can load: book-delivery, media-requests.")
    expect(result).not.toContain("list_skills")
    expect(result).not.toContain("/")
    const card = tool("load_skill").ax!
    expect(JSON.stringify(card)).not.toContain("list_skills")
    expect(card.errors!.find((e) => e.code === "skill-not-found")!.fix).toContain("names the error lists")
  })

  it("keeps the loader's own error when the skill exists but could not be read, or the skills cannot be listed", async () => {
    const { listSkills, loadSkill } = await import("../../repertoire/skills")
    vi.mocked(loadSkill).mockImplementationOnce(() => { throw new Error("EACCES: book-delivery.md") })
    expect(await call("load_skill", { name: "book-delivery" })).toBe("error: Error: EACCES: book-delivery.md (code: skill-not-found)")
    vi.mocked(listSkills).mockImplementationOnce(() => { throw new Error("EIO") })
    expect(await call("load_skill", { name: "nope" })).toBe("error: Error: skill 'nope' not found (code: skill-not-found)")
  })

  it("says plainly when no skill is installed at all", async () => {
    const { listSkills } = await import("../../repertoire/skills")
    vi.mocked(listSkills).mockReturnValueOnce([])
    expect(await call("load_skill", { name: "media" })).toBe("error: there is no skill called 'media', and this agent has no skills installed. Work from the tools you have. (code: skill-not-found)")
  })

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
    expect(await call("load_skill", { name: "nope" })).toBe("error: there is no skill called 'nope'. Skills you can load: book-delivery, media-requests. Call load_skill again with one of those names, spelled exactly. (code: skill-not-found)")
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
