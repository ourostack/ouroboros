import { describe, it, expect, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { FriendRecord } from "@ouro.bot/friends"
import type { ToolContext } from "../../repertoire/tools-base"

const fallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), "friend-link-tool-default-"))
vi.mock("../../heart/identity", async () => ({
  ...(await vi.importActual<typeof import("../../heart/identity")>("../../heart/identity")),
  getAgentRoot: () => fallbackRoot,
}))

import { friendLinkToolDefinition } from "../../repertoire/tools-friend-link"

function friend(trustLevel: FriendRecord["trustLevel"]): FriendRecord {
  return {
    id: "friend-1", name: "Ari", trustLevel, externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {},
    totalTokens: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", schemaVersion: 1,
  }
}

function ctx(record: FriendRecord | undefined, options: { isGroupChat?: boolean; agentRoot?: string } = {}): ToolContext {
  return {
    signin: async () => undefined,
    ...(options.agentRoot ? { agentRoot: options.agentRoot } : {}),
    ...(record ? { context: { friend: record, channel: { channel: "cli" }, isGroupChat: options.isGroupChat ?? false } as ToolContext["context"] } : {}),
  }
}

const run = (args: Record<string, string>, context?: ToolContext) => friendLinkToolDefinition.handler(args, context) as Promise<string>

describe("friend_link_code tool", () => {
  it("only issues codes to family in a 1:1 chat, for a known channel", async () => {
    expect(await run({})).toContain("no friend context")
    expect(await run({}, ctx(undefined))).toContain("no friend context")
    expect(await run({}, ctx(friend("friend")))).toContain("only for family")
    expect(await run({}, ctx(friend("family"), { isGroupChat: true }))).toContain("group chat")
    expect(await run({ channel: "fax" }, ctx(friend("family")))).toContain("unknown channel")
    expect(await run({})).toBe("no friend context: I can only issue a link code to the person I'm talking to. (code: no-friend-context)")
    expect(await run({}, ctx(friend("friend")))).toBe("link codes are only for family. (code: family-only)")
    expect(await run({}, ctx(friend("family"), { isGroupChat: true }))).toBe("link codes can't be issued in a group chat. Ask me in a 1:1 chat. (code: group-chat)")
    expect(await run({ channel: "fax" }, ctx(friend("family")))).toMatch(/^unknown channel 'fax'\. Use one of: .*\. \(code: invalid-channel\)$/)
    expect(friendLinkToolDefinition.ax).toMatchObject({ id: "tool:friend_link_code", group: "turn-friends", effect: "write" })
  })

  it("refuses a socket turn, whose caller chose the friend itself, even for family in a 1:1 chat", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "friend-link-tool-socket-"))
    const socketTurn = { ...ctx(friend("family"), { agentRoot }), turnOrigin: "socket" as const }
    expect(await run({}, socketTurn)).toBe("link codes are issued only in a chat the person started, not in a turn asked for over the daemon socket. (code: socket-turn)")
    expect(fs.existsSync(path.join(agentRoot, "state", "friend-link-codes"))).toBe(false)
    expect(await run({}, { ...ctx(friend("family"), { agentRoot }), turnOrigin: "sense-ingress" })).toMatch(/^link code for Ari:/)
  })

  it("issues a code for the family friend, under the agent root", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "friend-link-tool-"))
    const text = await run({ channel: "teams" }, ctx(friend("family"), { agentRoot }))
    expect(text).toMatch(/link code for Ari: OURO-[A-Z2-9]{4}-[A-Z2-9]{4}/)
    expect(text).toContain("from their teams account")
    expect(fs.readdirSync(path.join(agentRoot, "state", "friend-link-codes", "pending"))).toHaveLength(1)
  })

  it("falls back to the running agent's root and accepts any channel", async () => {
    const text = await run({}, ctx(friend("family")))
    expect(text).toContain("from the account they want to link")
    expect(fs.readdirSync(path.join(fallbackRoot, "state", "friend-link-codes", "pending"))).toHaveLength(1)
  })
})
