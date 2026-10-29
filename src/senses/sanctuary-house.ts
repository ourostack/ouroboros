import * as fs from "node:fs"
import * as path from "node:path"

// A household install describes its own home in <bundle>/house/house.json, a file the
// package never overwrites. Nothing here may name a particular household: a missing or
// partial file means generic names, no public endpoints and no required containers.

export interface SanctuaryHouseEndpoint {
  name: string
  url: string
}

export interface SanctuaryHouse {
  ownerName: string
  butlerName: string
  householdName: string
  publicEndpoints: SanctuaryHouseEndpoint[]
  requiredContainers: string[]
  booksContainer?: string
  jellyfinWebUrl?: string
}

export const DEFAULT_SANCTUARY_HOUSE: SanctuaryHouse = {
  ownerName: "the owner",
  butlerName: "the Butler",
  householdName: "the household",
  publicEndpoints: [],
  requiredContainers: [],
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function webUrl(value: unknown): string | undefined {
  const candidate = text(value)
  if (!candidate) return undefined
  try {
    const url = new URL(candidate)
    return url.protocol === "https:" || url.protocol === "http:" ? candidate : undefined
  } catch {
    return undefined
  }
}

/** Parse a house description, keeping only well-formed fields and filling the rest with generic defaults. */
export function parseSanctuaryHouse(raw: unknown): SanctuaryHouse {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const endpoints = Array.isArray(record.publicEndpoints) ? record.publicEndpoints : []
  const containers = Array.isArray(record.requiredContainers) ? record.requiredContainers : []
  const booksContainer = text(record.booksContainer)
  const jellyfinWebUrl = webUrl(record.jellyfinWebUrl)
  return {
    ownerName: text(record.ownerName) ?? DEFAULT_SANCTUARY_HOUSE.ownerName,
    butlerName: text(record.butlerName) ?? DEFAULT_SANCTUARY_HOUSE.butlerName,
    householdName: text(record.householdName) ?? DEFAULT_SANCTUARY_HOUSE.householdName,
    publicEndpoints: endpoints.flatMap((entry) => {
      const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : {}
      const name = text(item.name)
      const url = webUrl(item.url)
      return name && url ? [{ name, url }] : []
    }),
    requiredContainers: containers.flatMap((entry) => text(entry) ? [text(entry)!] : []),
    ...(booksContainer ? { booksContainer } : {}),
    ...(jellyfinWebUrl ? { jellyfinWebUrl } : {}),
  }
}

/** Read <agentRoot>/house/house.json; a missing or unreadable file is the generic house. */
export function readSanctuaryHouse(agentRoot: string): SanctuaryHouse {
  try {
    return parseSanctuaryHouse(JSON.parse(fs.readFileSync(path.join(agentRoot, "house", "house.json"), "utf-8")))
  } catch {
    return { ...DEFAULT_SANCTUARY_HOUSE, publicEndpoints: [], requiredContainers: [] }
  }
}
