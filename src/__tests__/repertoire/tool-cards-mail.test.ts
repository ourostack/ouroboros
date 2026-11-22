import { describe, expect, it } from "vitest"
import { mailToolDefinitions } from "../../repertoire/tools-mail"

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/

describe("mail tool cards", () => {
  it("gives every mail tool a turn-mail card named after it, with kebab-case codes", () => {
    expect(mailToolDefinitions).toHaveLength(12)
    for (const def of mailToolDefinitions) {
      expect(def.ax?.id).toBe(`tool:${def.tool.function.name}`)
      expect(def.ax?.group).toBe("turn-mail")
      for (const error of def.ax!.errors) expect(error.code).toMatch(KEBAB)
    }
  })

  it("marks only mail_access_log read, because every other mail tool writes the access log or mail state", () => {
    const reads = mailToolDefinitions.filter((def) => def.ax?.effect === "read")
    expect(reads.map((def) => def.tool.function.name)).toEqual(["mail_access_log"])
    expect(reads[0].riskProfile).toEqual({ mutates: "none", risk: "low" })
  })

  it("ends an untrusted refusal with the code the card names", async () => {
    const status = mailToolDefinitions.find((def) => def.tool.function.name === "mail_status")!
    const refusal = await status.handler({}, { context: { friend: { trustLevel: "stranger" } } } as never)
    expect(refusal).toBe("mail is private; this tool is only available in trusted contexts. (code: not-trusted)")
    expect(status.ax!.errors.map((error) => error.code)).toContain("not-trusted")
  })
})
