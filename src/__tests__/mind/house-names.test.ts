import { describe, expect, it } from "vitest"
import { fillHouseNames, houseNameFields } from "../../mind/house-names"

describe("house names", () => {
  it("reads the names house.json gives, trimmed, and skips blank or non-string ones", () => {
    expect(houseNameFields(JSON.stringify({ ownerName: " Ada ", butlerName: "Jeeves", householdName: "  ", extra: "x" }))).toEqual({ owner: "Ada", butler: "Jeeves" })
    expect(houseNameFields(JSON.stringify({ ownerName: 7 }))).toEqual({})
  })

  it("gives no names for a missing, unparseable or non-object house.json", () => {
    for (const text of [null, "", "{not json", "[]", "null", "\"Ada\""]) expect(houseNameFields(text), String(text)).toEqual({})
  })

  it("fills only the names it has and leaves the other placeholders as they are", () => {
    expect(fillHouseNames("{{butler}} serves {{owner}} at {{household}}; {{other}} stays", { owner: "Ada", butler: "Jeeves" }))
      .toBe("Jeeves serves Ada at {{household}}; {{other}} stays")
  })
})
