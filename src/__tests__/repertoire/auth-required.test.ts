import { describe, expect, it } from "vitest"
import { authRequired } from "../../repertoire/auth-required"

describe("authRequired", () => {
  it("promises a sign-in prompt only when one can appear", () => {
    expect(authRequired({ signin: async () => undefined, oauthAvailable: ["graph"] }, "graph", "I need access to Microsoft Graph."))
      .toBe("AUTH_REQUIRED:graph -- I need access to Microsoft Graph. Please sign in when prompted.")
    const unavailable = authRequired(undefined, "ado", "I need access to Azure DevOps.")
    expect(unavailable).toContain("AUTH_UNAVAILABLE:ado")
    expect(unavailable).toContain("human-required")
    expect(unavailable).not.toContain("when prompted")
    expect(authRequired({ signin: async () => undefined }, "github", "GitHub needed.")).toContain("AUTH_UNAVAILABLE:github")
    expect(authRequired({ signin: async () => undefined, oauthUnavailable: { github: "" } }, "github", "GitHub needed.")).toContain("AUTH_UNAVAILABLE:github")
  })

  it("says exactly why sign-in can't start, without the AUTH_REQUIRED marker that would retry it", () => {
    const result = authRequired({ signin: async () => undefined, oauthUnavailable: { graph: "the bot has no OAuth connection named \"graph\"." } }, "graph", "I need access to Microsoft Graph.")
    expect(result).toBe("AUTH_UNAVAILABLE:graph -- I need access to Microsoft Graph. Sign-in can't start here: the bot has no OAuth connection named \"graph\".")
    expect(result).not.toContain("AUTH_REQUIRED")
  })
})
