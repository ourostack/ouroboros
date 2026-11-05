import { describe, expect, it } from "vitest"
import { JSDOM } from "jsdom"
import { attentionPage } from "../../../senses/shepherd/attention-page"
import { attentionSidebar } from "../../../senses/shepherd/attention-sidebar"
import { readAgentConfigForAgent } from "../../../heart/auth/auth-flow"
import { createTmpBundle } from "../../test-helpers/tmpdir-bundle"
import { FULL_AGENT_JSON } from "../../heart/identity-fixture"
import * as fs from "node:fs"
import { loadAgentConfig } from "../../../heart/identity"
import { agentPresentation, readAgentPresentation, stripAgentAddress, validateAgentDisplayName } from "../../../senses/shepherd/agent-presentation"

describe("configured agent presentation", () => {
  it("reads the explicit owner's presentation without changing its config or requiring provider setup", () => {
    const tmp = createTmpBundle({ agentName: "orchid-runtime", agentJson: { displayName: "Orchid One" } })
    try {
      const before = fs.readFileSync(tmp.agentConfigPath, "utf8")
      expect(readAgentPresentation(tmp.agentName, tmp.agentRoot)).toEqual({
        name: "Orchid One", aliases: ["Orchid One", "orchid-runtime"],
      })
      expect(fs.readFileSync(tmp.agentConfigPath, "utf8")).toBe(before)
    } finally { tmp.cleanup() }
  })

  it("does not silently replace malformed presentation configuration with a default identity", () => {
    const tmp = createTmpBundle()
    try {
      fs.writeFileSync(tmp.agentConfigPath, "{broken")
      expect(() => readAgentPresentation(tmp.agentName, tmp.agentRoot)).toThrow()
    } finally { tmp.cleanup() }
  })

  it.each(["null", "[]", "3", '"Agent"'])("refuses a non-object presentation document %s", encoded => {
    const tmp = createTmpBundle()
    try {
      fs.writeFileSync(tmp.agentConfigPath, encoded)
      expect(() => readAgentPresentation(tmp.agentName, tmp.agentRoot)).toThrow("object")
    } finally { tmp.cleanup() }
  })

  it("uses the routing identifier only for a genuinely absent config, not a read failure", () => {
    const tmp = createTmpBundle()
    try {
      fs.renameSync(tmp.agentConfigPath, `${tmp.agentConfigPath}.saved`)
      expect(readAgentPresentation(tmp.agentName, tmp.agentRoot)).toEqual({
        name: tmp.agentName, aliases: [tmp.agentName],
      })
      fs.mkdirSync(tmp.agentConfigPath)
      expect(() => readAgentPresentation(tmp.agentName, tmp.agentRoot)).toThrow()
    } finally { tmp.cleanup() }
  })

  it("normalizes the explicit owner's display name through the runtime config loader too", () => {
    const tmp = createTmpBundle({ agentName: "orchid-runtime", agentJson: { ...FULL_AGENT_JSON, displayName: "Orchid One" } })
    try {
      expect(loadAgentConfig({ agentName: tmp.agentName, agentRoot: tmp.agentRoot }).displayName).toBe("Orchid One")
      fs.writeFileSync(tmp.agentConfigPath, JSON.stringify({ ...FULL_AGENT_JSON, displayName: "<bad>" }))
      expect(() => loadAgentConfig({ agentName: tmp.agentName, agentRoot: tmp.agentRoot })).toThrow("displayName")
    } finally { tmp.cleanup() }
  })

  it.each([null, 3, true, [], {}])("rejects non-string explicit names %j", value => {
    expect(() => validateAgentDisplayName(value)).toThrow("displayName")
  })

  it("keeps display identity separate from the configured routing identifier", () => {
    expect(agentPresentation("orchid-runtime", { displayName: "Orchid One" }))
      .toEqual({ name: "Orchid One", aliases: ["Orchid One", "orchid-runtime"] })
    expect(agentPresentation("other", {})).toEqual({ name: "other", aliases: ["other"] })
    expect(agentPresentation("same", { displayName: "same" })).toEqual({ name: "same", aliases: ["same"] })
    expect(validateAgentDisplayName(undefined)).toBeUndefined()
  })

  it.each(["", "../other", "<script>", "Agent\nOther"])("refuses unsafe routing aliases %j before rendering or address matching", agent => {
    expect(() => agentPresentation(agent, { displayName: "Orchid" })).toThrow("identifier")
  })

  it.each([
    { input: "@Orchid One review this", want: "review this" },
    { input: "@ORCHID ONE\nreview this", want: "review this" },
    { input: "@orchid-runtime review this", want: "review this" },
    { input: "@Orchid One", want: "" },
    { input: "@Orchid OneMore review this", want: "@Orchid OneMore review this" },
    { input: "@Ouro review this", want: "@Ouro review this" },
    { input: "Ask @Orchid One about this", want: "Ask @Orchid One about this" },
  ])("only removes this configured agent's exact leading address: $input", ({ input, want }) => {
    expect(stripAgentAddress(input, ["Orchid One", "orchid-runtime"])).toBe(want)
  })

  it("treats punctuation in an address literally instead of as a regular expression", () => {
    expect(stripAgentAddress("@R&D.2 hi", ["R&D.2"])).toBe("hi")
    expect(stripAgentAddress("@R&Dx2 hi", ["R&D.2"])).toBe("@R&Dx2 hi")
    expect(stripAgentAddress("@anything", [])).toBe("@anything")
  })

  it.each(["Orchid One", "Zoë", "R&D"])("renders the configured name %s instead of a universal agent identity", name => {
    const dom = new JSDOM(attentionPage("nonce", { name, aliases: [name, "agent-id"] }))
    try {
      expect(dom.window.document.title).toBe(name)
      expect(dom.window.document.querySelector("h1")?.textContent).toBe(name)
      expect(dom.window.document.querySelector("textarea")?.getAttribute("aria-label")).toBe(`Message ${name}`)
      expect(dom.window.document.querySelector("#cancel")?.textContent).toBe(`Cancel ${name}`)
    } finally { dom.window.close() }
  })

  it("gives the native entry the selected agent's name without changing its no-focus browser action", () => {
    const source = attentionSidebar(`http://127.0.0.1:12345/#${"a".repeat(64)}`, "Orchid One")
    expect(source).toContain('Text("Orchid One")')
    expect(source).toContain('Text("Talk to Orchid One")')
    expect(source).toContain('cmux("browser.open_split", focus: false')
    expect(source).not.toContain('Text("Ouro")')
  })

  it.each(["", "  ", "<img src=x>", "Agent\nOther", "Agent\u200b", "A".repeat(81)])(
    "rejects an invalid explicitly configured display name %j",
    displayName => {
      const tmp = createTmpBundle({
        agentName: "presentation-contract",
        agentJson: { ...FULL_AGENT_JSON, displayName },
      })
      try {
        expect(() => readAgentConfigForAgent(tmp.agentName, tmp.bundlesRoot)).toThrow("displayName")
      } finally { tmp.cleanup() }
    },
  )
})
