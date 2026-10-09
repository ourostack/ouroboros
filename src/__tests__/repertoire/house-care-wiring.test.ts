import * as fs from "node:fs"
import { describe, expect, it } from "vitest"
import { getChannelCapabilities } from "@ouro.bot/friends"
import { selectToolsForChannel } from "../../repertoire/tools"
import { parseAwaitFile } from "../../heart/awaiting/await-parser"
import { SANCTUARY_PACKAGE_MANAGED_FILES } from "../../heart/daemon/sanctuary-bundle-migration"

const AWAIT_PATH = "awaiting/house-care-sweep.md"
const names = (tools: { tool: { function: { name: string } } }[]) => tools.map((definition) => definition.tool.function.name)

describe("house care wiring", () => {
  it("gives the Butler's own scheduled turn both house tools, and no other agent's scheduled turn", () => {
    const inner = getChannelCapabilities("inner")
    const butler = names(selectToolsForChannel(inner, undefined, undefined, undefined, undefined, undefined, { agentName: "sanctuary" } as never).ordinary)
    expect(butler).toEqual(expect.arrayContaining(["house_sweep", "house_digest_send"]))
    const other = names(selectToolsForChannel(inner, undefined, undefined, undefined, undefined, undefined, { agentName: "slugger" } as never).ordinary)
    expect(other).not.toContain("house_sweep")
  })
  it("ships a never-resolving daily await in the package-managed bundle", () => {
    expect(SANCTUARY_PACKAGE_MANAGED_FILES).toContain(AWAIT_PATH)
    const file = `deploy/unraid/sanctuary.ouro/${AWAIT_PATH}`
    const parsed = parseAwaitFile(fs.readFileSync(file, "utf8"), file)
    expect(parsed.cadence).toBe("1d")
    expect(parsed.status).toBe("pending")
    expect(parsed.body).toContain("house_sweep")
    expect(parsed.body).toContain("house_digest_send")
  })
})
