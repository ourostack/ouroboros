import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

import { DEFAULT_SANCTUARY_HOUSE, parseSanctuaryHouse, readSanctuaryHouse } from "../../senses/sanctuary-house"

describe("Sanctuary house config", () => {
  it("keeps well-formed fields and trims them", () => {
    expect(parseSanctuaryHouse({
      ownerName: " Sam ", butlerName: "Hearth", householdName: "The Lees",
      publicEndpoints: [{ name: "media", url: "https://media.example/" }, { name: "lan", url: "http://10.0.0.2:8096" }],
      requiredContainers: ["jellyfin", " sonarr "],
      booksContainer: "calibre-web",
      jellyfinWebUrl: "https://media.example",
    })).toEqual({
      ownerName: "Sam", butlerName: "Hearth", householdName: "The Lees",
      publicEndpoints: [{ name: "media", url: "https://media.example/" }, { name: "lan", url: "http://10.0.0.2:8096" }],
      requiredContainers: ["jellyfin", "sonarr"],
      booksContainer: "calibre-web",
      jellyfinWebUrl: "https://media.example",
    })
  })

  it.each([
    ["not an object", "house"],
    ["an array", []],
    ["null", null],
    ["empty fields", { ownerName: "  ", butlerName: 3, publicEndpoints: "x", requiredContainers: {} }],
  ])("falls back to generic defaults for %s", (_label, raw) => {
    expect(parseSanctuaryHouse(raw)).toEqual(DEFAULT_SANCTUARY_HOUSE)
  })

  it("drops malformed endpoints, containers and URLs", () => {
    const house = parseSanctuaryHouse({
      publicEndpoints: [null, { name: "x" }, { name: "ftp", url: "ftp://files.example/" }, { name: "bad", url: "not a url" }, { name: "ok", url: "https://ok.example/" }],
      requiredContainers: ["", 4, "keep"],
      booksContainer: " ",
      jellyfinWebUrl: "javascript:alert(1)",
    })
    expect(house.publicEndpoints).toEqual([{ name: "ok", url: "https://ok.example/" }])
    expect(house.requiredContainers).toEqual(["keep"])
    expect(house).not.toHaveProperty("booksContainer")
    expect(house).not.toHaveProperty("jellyfinWebUrl")
  })

  it("reads house/house.json from the bundle and treats a missing or broken file as the generic house", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-house-"))
    try {
      const missing = readSanctuaryHouse(root)
      expect(missing).toEqual(DEFAULT_SANCTUARY_HOUSE)
      missing.publicEndpoints.push({ name: "leak", url: "https://leak.example/" })
      expect(DEFAULT_SANCTUARY_HOUSE.publicEndpoints).toEqual([])
      fs.mkdirSync(path.join(root, "house"))
      fs.writeFileSync(path.join(root, "house", "house.json"), "{ not json")
      expect(readSanctuaryHouse(root)).toEqual(DEFAULT_SANCTUARY_HOUSE)
      fs.writeFileSync(path.join(root, "house", "house.json"), JSON.stringify({ ownerName: "Sam" }))
      expect(readSanctuaryHouse(root).ownerName).toBe("Sam")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
