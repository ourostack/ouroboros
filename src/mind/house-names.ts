// A household install names its owner, its Butler and its home in house/house.json,
// a file the package never overwrites. The packaged psyche writes {{owner}}, {{butler}}
// and {{household}} where those names go, so one psyche serves every household.

import { emitNervesEvent } from "../nerves/runtime"

export type HouseNameKey = "owner" | "butler" | "household"

const HOUSE_NAME_FIELDS: ReadonlyArray<readonly [HouseNameKey, string]> = [["owner", "ownerName"], ["butler", "butlerName"], ["household", "householdName"]]

/** The names house.json gives, by placeholder key; a missing, empty or unparseable file gives none. */
export function houseNameFields(houseJson: string | null): Partial<Record<HouseNameKey, string>> {
  const names = readHouseNames(houseJson)
  // Only how many names were given: the names themselves are the household's.
  emitNervesEvent({
    component: "mind",
    event: "mind.house_names_read",
    message: "read the household's names",
    meta: { given: Object.keys(names).length },
  })
  return names
}

function readHouseNames(houseJson: string | null): Partial<Record<HouseNameKey, string>> {
  const names: Partial<Record<HouseNameKey, string>> = {}
  let parsed: unknown
  try {
    parsed = JSON.parse(houseJson ?? "")
  } catch {
    return names
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return names
  for (const [key, field] of HOUSE_NAME_FIELDS) {
    const value = (parsed as Record<string, unknown>)[field]
    if (typeof value === "string" && value.trim()) names[key] = value.trim()
  }
  return names
}

/** Replaces each {{owner}}, {{butler}} and {{household}} whose name is given; the rest stay as they are. */
export function fillHouseNames(text: string, names: Partial<Record<HouseNameKey, string>>): string {
  return text.replace(/\{\{(owner|butler|household)\}\}/gu, (match, key: HouseNameKey) => names[key] ?? match)
}
