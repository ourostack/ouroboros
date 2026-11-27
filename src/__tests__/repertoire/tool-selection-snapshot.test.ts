import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { getChannelCapabilities, type ChannelCapabilities } from "@ouro.bot/friends"
import type { ProviderCapability } from "../../heart/core"
import { loadRelationshipCapabilityRegistry } from "../../repertoire/relationship-authorization"
import { selectToolsForChannel, toolSelectionSchemas, type ToolContext } from "../../repertoire/tools"
import { useButlerProduct } from "../test-helpers/butler-product"

/**
 * Pins the menu every agent gets on every channel under every relationship profile, as tool names in order, so moving
 * the Butler's tool rules behind its product (M3) is proven not to change one turn's menu. The snapshot was recorded on
 * main before the move.
 */
const AGENTS = ["butler", "sanctuary", "slugger"] as const
const CHANNELS = ["telegram", "a2a", "inner", "cli", "mcp", "teams", "voice", undefined] as const
const PROFILES = [undefined, "sanctuary-owner", "sanctuary-agent-peer", "sanctuary-household", "sanctuary-event", "unknown-profile"] as const
const CAPABILITIES: ReadonlySet<ProviderCapability> = new Set(["reasoning-effort", "phase-annotation", "approval-continuation"])

const registry = loadRelationshipCapabilityRegistry(path.resolve(__dirname, "../../../deploy/unraid/sanctuary.ouro"))
const everyProfileTool = [...new Set(Object.values(registry.profiles).flatMap((profile) => profile.toolNames))]
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tool-selection-snapshot-"))
afterAll(() => { fs.rmSync(scratch, { recursive: true, force: true }) })

function capabilitiesFor(channel: typeof CHANNELS[number]): ChannelCapabilities | undefined {
  return channel === undefined ? undefined : getChannelCapabilities(channel as never)
}

function contextFor(agent: string, profileId: typeof PROFILES[number]): ToolContext {
  const agentRoot = path.join(scratch, `${agent}.ouro`)
  return {
    signin: async () => undefined,
    agentName: agent,
    agentRoot,
    ...(profileId === undefined ? {} : {
      relationshipAuthorization: {
        profileId,
        authorizedContextScopes: [],
        // An unknown profile is advertised every tool any profile lists, so a leak past the profile rules shows here.
        advertisedToolNames: profileId === "unknown-profile" ? everyProfileTool : [...registry.profiles[profileId]!.toolNames],
        authorizeTool: vi.fn(async () => ({ allowed: true as const, receiptId: "snapshot", profileVersion: 1 })),
      },
    }),
  }
}

function menus(agents: readonly string[]): Record<string, { ordinary: string[]; engine: string[] }> {
  const rows: Record<string, { ordinary: string[]; engine: string[] }> = {}
  for (const agent of agents) {
    for (const channel of CHANNELS) {
      for (const profileId of PROFILES) {
        const selection = selectToolsForChannel(capabilitiesFor(channel), undefined, undefined, CAPABILITIES, undefined, undefined, contextFor(agent, profileId))
        rows[`${agent} / ${channel ?? "none"} / ${profileId ?? "none"}`] = {
          ordinary: selection.ordinary.map((definition) => definition.tool.function.name),
          engine: toolSelectionSchemas(selection).slice(selection.ordinary.length).map((tool) => tool.function.name),
        }
      }
    }
  }
  return rows
}

describe("every turn's tool menu", () => {
  describe("with the Butler's product loaded, as on its image", () => {
    useButlerProduct()
    it("is unchanged for every agent, channel and relationship profile", () => {
      expect(menus(AGENTS)).toMatchSnapshot()
    })
  })

  describe("with no product loaded, as on a Mac or in dev", () => {
    it("is unchanged for an ordinary agent on every channel and relationship profile", () => {
      expect(menus(["slugger"])).toMatchSnapshot()
    })
  })
})
