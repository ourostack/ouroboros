import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as http from "node:http"
import { describe, expect, it, vi } from "vitest"

const loadSelfA2AIdentity = vi.hoisted(() => vi.fn(async () => ({ did: "did:key:z6MkButler" })))
vi.mock("../../a2a/identity", async (importOriginal) => ({ ...await importOriginal<typeof import("../../a2a/identity")>(), loadSelfA2AIdentity }))

import { normalizeSenses } from "../../heart/identity"
import {
  OWNER_ROUTE_FALLBACK_PREFIX,
  createA2AOwnerRoute,
  formatOwnerRouteMessage,
  ownerRouteDedupeKey,
  ownerRouteForAgent,
  ownerRouteItem,
  ownerRouteUrgency,
} from "../../senses/telegram-owner-route"

const SLUGGER_DID = "did:key:z6MkppLXDVabJRdmx5bFg1W8SKxMLwbccrxW8Y5PhYmKkGKt"
const CARD_URL = "http://100.99.143.43:18921/.well-known/agent-card.json"

describe("senses.telegram.ownerNoticesTo in agent.json", () => {
  it("keeps a peer named by card URL and DID", () => {
    expect(normalizeSenses({ telegram: { enabled: true, ownerNoticesTo: { cardUrl: CARD_URL, did: SLUGGER_DID } } }, "/t/agent.json").telegram)
      .toEqual({ enabled: true, ownerNoticesTo: { cardUrl: CARD_URL, did: SLUGGER_DID } })
    expect(normalizeSenses({ telegram: { enabled: true } }, "/t/agent.json").telegram).toEqual({ enabled: true })
  })

  it("refuses a peer that is not an object, an address that is not http(s), or a DID that is not did:key", () => {
    expect(() => normalizeSenses({ telegram: { enabled: true, ownerNoticesTo: "slugger" } }, "/t/agent.json")).toThrow("senses.telegram.ownerNoticesTo must be { cardUrl, did }")
    expect(() => normalizeSenses({ telegram: { enabled: true, ownerNoticesTo: { cardUrl: "file:///x", did: SLUGGER_DID } } }, "/t/agent.json")).toThrow("senses.telegram.ownerNoticesTo.cardUrl must be an http or https URL")
    expect(() => normalizeSenses({ telegram: { enabled: true, ownerNoticesTo: { cardUrl: "not a url", did: SLUGGER_DID } } }, "/t/agent.json")).toThrow("senses.telegram.ownerNoticesTo.cardUrl must be an http or https URL")
    expect(() => normalizeSenses({ telegram: { enabled: true, ownerNoticesTo: { cardUrl: 7, did: SLUGGER_DID } } }, "/t/agent.json")).toThrow("senses.telegram.ownerNoticesTo.cardUrl must be an http or https URL")
    expect(() => normalizeSenses({ telegram: { enabled: true, ownerNoticesTo: { cardUrl: CARD_URL, did: "slugger" } } }, "/t/agent.json")).toThrow("senses.telegram.ownerNoticesTo.did must be a did:key")
  })
})

describe("what Slugger is told", () => {
  it("rates a critical notice now, a house-sweep digest batch, and the rest today", () => {
    expect(ownerRouteUrgency("owner-notice:failure-fixed:1", true)).toBe("now")
    expect(ownerRouteUrgency("owner-notice:house-sweep:scheduled:2026-11-22:ab", false)).toBe("batch")
    expect(ownerRouteUrgency("external-event:[\"sanctuary-health\",\"container:plex\",1]", false)).toBe("today")
    expect(ownerRouteUrgency("proactive:1", false)).toBe("today")
  })

  it("keeps one dedupe key per condition, so a re-fire updates Slugger's item", () => {
    expect(ownerRouteDedupeKey("external-event:[\"sanctuary-health\",\"container:plex\",3]", "x")).toBe("butler-sanctuary-health-container-plex")
    expect(ownerRouteDedupeKey("external-event:[\"sanctuary-health\",\"container:plex\",4]", "y")).toBe("butler-sanctuary-health-container-plex")
    expect(ownerRouteDedupeKey("owner-notice:failure-fixed:Report 7", "x")).toBe("butler-failure-fixed-report-7")
    expect(ownerRouteDedupeKey("proactive:4f1d", "Disk is full")).toBe(ownerRouteDedupeKey("proactive:9a9a", "Disk is full"))
    expect(ownerRouteDedupeKey("proactive:4f1d", "Disk is full")).toMatch(/^butler-proactive-[0-9a-f]{12}$/u)
    expect(ownerRouteDedupeKey("external-event:not json", "x")).toBe("butler-external-event-not-json")
    expect(ownerRouteDedupeKey("held-batch:x".repeat(40), "x").length).toBeLessThanOrEqual(120)
  })

  it("writes the message in Slugger's intake format", () => {
    const item = ownerRouteItem("owner-notice:failure-fixed:7", "Plex is back up.\nIt restarted twice.", false)
    expect(item).toEqual({ key: "owner-notice:failure-fixed:7", text: "Plex is back up.\nIt restarted twice.", urgency: "today", dedupeKey: "butler-failure-fixed-7" })
    expect(formatOwnerRouteMessage(item)).toBe([
      "from: the Butler (sanctuary, Ari's house server)",
      "urgency: today",
      "ask: Plex is back up.",
      "why only Ari: it is about his house, and the Butler reports to him",
      "steps: Plex is back up.\nIt restarted twice.",
      "deadline: none",
      "dedupe key: butler-failure-fixed-7",
    ].join("\n"))
    expect(formatOwnerRouteMessage({ ...item, text: `${"a".repeat(300)}` }).split("\n")[2]).toBe(`ask: ${"a".repeat(199)}…`)
  })

  it("says plainly when it falls back to Telegram", () => {
    expect(OWNER_ROUTE_FALLBACK_PREFIX).toBe("Slugger can't be reached, so this comes to you directly.")
  })
})

describe("createA2AOwnerRoute", () => {
  const identity = { did: "did:key:z6MkButler" } as never
  const card = (did: string) => ({ name: "slugger", url: "http://100.99.143.43:18921/a2a", did })

  it("delivers a sealed message to the pinned peer", async () => {
    const send = vi.fn(async () => ({ text: "noted", conversationId: "c", taskId: "t", peerDid: SLUGGER_DID, peerName: "slugger" }))
    const route = createA2AOwnerRoute({ cardUrl: CARD_URL, did: SLUGGER_DID, loadIdentity: async () => identity, fetchCard: async () => card(SLUGGER_DID) as never, send })
    const item = ownerRouteItem("proactive:1", "hello", false)
    await expect(route(item)).resolves.toEqual({ status: "delivered" })
    expect(send).toHaveBeenCalledWith({ cardUrl: CARD_URL, text: formatOwnerRouteMessage(item), identity })
  })

  it("refuses a card at that address that serves another DID", async () => {
    const send = vi.fn()
    const route = createA2AOwnerRoute({ cardUrl: CARD_URL, did: SLUGGER_DID, loadIdentity: async () => identity, fetchCard: async () => card("did:key:z6MkOther") as never, send })
    await expect(route(ownerRouteItem("proactive:1", "hello", false))).resolves.toEqual({ status: "unreachable", detail: `the card at ${CARD_URL} serves did:key:z6MkOther, not the pinned ${SLUGGER_DID}` })
    expect(send).not.toHaveBeenCalled()
  })

  it("refuses a card that serves no DID", async () => {
    const route = createA2AOwnerRoute({ cardUrl: CARD_URL, did: SLUGGER_DID, loadIdentity: async () => identity, fetchCard: async () => ({ name: "slugger", url: "http://x/a2a" }) as never, send: vi.fn() })
    await expect(route(ownerRouteItem("proactive:1", "hello", false))).resolves.toEqual({ status: "unreachable", detail: `the card at ${CARD_URL} serves undefined, not the pinned ${SLUGGER_DID}` })
  })

  it("reports a failed fetch or send as unreachable, with the reason", async () => {
    const down = createA2AOwnerRoute({ cardUrl: CARD_URL, did: SLUGGER_DID, loadIdentity: async () => identity, fetchCard: async () => { throw new Error("connect ECONNREFUSED") }, send: vi.fn() })
    await expect(down(ownerRouteItem("proactive:1", "hello", false))).resolves.toEqual({ status: "unreachable", detail: "connect ECONNREFUSED" })
    const refused = createA2AOwnerRoute({ cardUrl: CARD_URL, did: SLUGGER_DID, loadIdentity: async () => identity, fetchCard: async () => card(SLUGGER_DID) as never, send: async () => { throw "not a friend" } })
    await expect(refused(ownerRouteItem("proactive:1", "hello", false))).resolves.toEqual({ status: "unreachable", detail: "not a friend" })
  })

  it("uses the real card fetch and sealed send by default", async () => {
    const route = createA2AOwnerRoute({ cardUrl: "http://127.0.0.1:9/.well-known/agent-card.json", did: SLUGGER_DID, loadIdentity: async () => identity })
    const outcome = await route(ownerRouteItem("proactive:1", "hello", false))
    expect(outcome.status).toBe("unreachable")
  })
})

describe("ownerRouteForAgent", () => {
  const bundle = (senses: unknown) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-route-"))
    fs.writeFileSync(path.join(root, "agent.json"), JSON.stringify({
      version: 2, enabled: true,
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" }, agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      senses,
    }))
    return root
  }

  it("is the route agent.json names, and none when it names none", async () => {
    expect(ownerRouteForAgent("butler", bundle({ telegram: { enabled: true } }))).toBeUndefined()
    const route = ownerRouteForAgent("butler", bundle({ telegram: { enabled: true, ownerNoticesTo: { cardUrl: "http://127.0.0.1:9/.well-known/agent-card.json", did: SLUGGER_DID } } }))
    expect(route).toBeTypeOf("function")
    // Nothing listens on port 9, so the card fetch fails before the identity is needed.
    await expect(route!(ownerRouteItem("proactive:1", "hello", false))).resolves.toMatchObject({ status: "unreachable" })
    expect(loadSelfA2AIdentity).not.toHaveBeenCalled()
  })

  it("signs as this agent's own A2A identity once the pinned card answers", async () => {
    const server = http.createServer((_req, res) => {
      const port = (server.address() as { port: number }).port
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ name: "slugger", url: `http://127.0.0.1:${port}/a2a`, did: SLUGGER_DID }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    try {
      const port = (server.address() as { port: number }).port
      const route = ownerRouteForAgent("butler", bundle({ telegram: { enabled: true, ownerNoticesTo: { cardUrl: `http://127.0.0.1:${port}/.well-known/agent-card.json`, did: SLUGGER_DID } } }))
      // The stand-in identity can't seal, so the send fails after the identity is loaded.
      await expect(route!(ownerRouteItem("proactive:1", "hello", false))).resolves.toMatchObject({ status: "unreachable" })
      expect(loadSelfA2AIdentity).toHaveBeenCalledWith({ agentName: "butler" })
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
