import { describe, expect, it } from "vitest"
import { callInTurnTool, DISPATCH_ERRORS, listInTurnTools, neverSignIn } from "../../repertoire/in-turn-tools-door"

describe("the in-turn tools door", () => {
  it("lists every registered tool once, each a function definition with an Ouro AX card", () => {
    const tools = listInTurnTools()
    const names = tools.map((tool) => tool.function.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(expect.arrayContaining(["read_file", "shell", "surface", "settle", "rest", "find_tools", "complete_adoption", "list_directory", "voice_join_local_audio"]))
    for (const tool of tools) {
      expect(tool.type).toBe("function")
      expect(tool.ax.id).toBe(`tool:${tool.function.name}`)
      expect(["read", "write", "consequential", "person-only"]).toContain(tool.ax.effect)
    }
  })

  it("refuses an unknown tool with the dispatcher's code, naming the real tool it could mean", async () => {
    await expect(callInTurnTool("read_fil", {})).resolves.toEqual({
      state: "refused", text: 'unknown: read_fil; did you mean "read_file"? (code: unknown-tool)', code: "unknown-tool",
    })
  })

  it("points an unknown tool with no close name at find_tools, which this door serves", async () => {
    await expect(callInTurnTool("zzqx", {})).resolves.toEqual({
      state: "refused",
      text: "unknown: zzqx; no tool has a name close to it, so pick one from this turn's tool list, or call find_tools to search the tools held back from it (code: unknown-tool)",
      code: "unknown-tool",
    })
  })

  it("refuses a call missing a required argument, naming it, before any handler runs", async () => {
    const outcome = await callInTurnTool("read_file", {})
    expect(outcome).toMatchObject({ state: "refused", code: "invalid-arguments" })
    expect(outcome.text).toMatch(/path/)
  })
  it("names the missing arguments of the root host tool too, before its authority is asked", async () => {
    const outcome = await callInTurnTool("sanctuary_host_execute", {})
    expect(outcome).toMatchObject({ state: "refused", code: "invalid-arguments" })
    expect(outcome.text).toMatch(/targetHost/)
  })

  it("answers a call that passes every check without running the tool", async () => {
    await expect(callInTurnTool("settle", { answer: "hi" })).resolves.toEqual({
      state: "refused", text: "settle passed the dispatcher's checks; this X-ray door runs no tool (code: not-run)", code: "not-run",
    })
  })

  it("never starts a sign-in", async () => {
    await expect(neverSignIn()).resolves.toBeUndefined()
  })

  it("cards every code the door answers", () => {
    expect(DISPATCH_ERRORS.map((e) => e.code)).toEqual(expect.arrayContaining(["unknown-tool", "invalid-arguments", "not-run"]))
  })
})
