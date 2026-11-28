import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-telegram-owner-"))
vi.mock("../../heart/identity", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../heart/identity")>(),
  getAgentRoot: (agentName: string) => path.join(root, `${agentName}.ouro`),
}))

import { ownerDisplayName } from "../../senses/telegram"
import { loadProduct } from "../../heart/product/active"
import { useButlerProduct } from "../test-helpers/butler-product"

function nameOwner(agentName: string, ownerName: string): void {
  fs.mkdirSync(path.join(root, `${agentName}.ouro`, "house"), { recursive: true })
  fs.writeFileSync(path.join(root, `${agentName}.ouro`, "house", "house.json"), JSON.stringify({ ownerName }))
}

afterEach(() => { for (const agent of ["butler", "sanctuary", "slugger"]) fs.rmSync(path.join(root, `${agent}.ouro`), { recursive: true, force: true }) })

describe("Telegram owner display name, on the Butler's image", () => {
  useButlerProduct()

  it.each(["butler", "sanctuary"])("uses the owner's name from %s's house config", (agent) => {
    nameOwner(agent, "Ada")
    expect(ownerDisplayName(agent)).toBe("Ada")
  })

  it("says Owner when the household has not named its owner", () => {
    expect(ownerDisplayName("butler")).toBe("Owner")
  })
})

describe("Telegram owner display name, for an agent with no product", () => {
  afterEach(() => { loadProduct(undefined) })

  it("says Owner, whatever a house config in its bundle says", () => {
    nameOwner("slugger", "Ada")
    expect(ownerDisplayName("slugger")).toBe("Owner")
  })
})
