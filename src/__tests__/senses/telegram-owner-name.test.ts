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

describe("Telegram owner display name", () => {
  afterEach(() => { fs.rmSync(path.join(root, "sanctuary.ouro"), { recursive: true, force: true }) })

  it("uses the owner's name from house config", () => {
    fs.mkdirSync(path.join(root, "sanctuary.ouro", "house"), { recursive: true })
    fs.writeFileSync(path.join(root, "sanctuary.ouro", "house", "house.json"), JSON.stringify({ ownerName: "Sam" }))
    expect(ownerDisplayName("sanctuary")).toBe("Sam")
  })

  it("says Owner when the household has not named its owner", () => {
    expect(ownerDisplayName("sanctuary")).toBe("Owner")
  })
})
