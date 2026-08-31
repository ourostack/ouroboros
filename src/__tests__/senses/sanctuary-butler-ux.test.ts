import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FileFriendStore, getChannelCapabilities, type FriendRecord } from "@ouro.bot/friends"

import { readActiveCares } from "../../arc/cares"
import { resetIdentity, setAgentName } from "../../heart/identity"
import { parseAwaitFile } from "../../heart/awaiting/await-parser"
import { createRelationshipAuthorizationEvaluator, loadRelationshipCapabilityRegistry } from "../../repertoire/relationship-authorization"
import { execTool, getToolsForChannel } from "../../repertoire/tools"

const identityTestState = vi.hoisted(() => ({ agentRoot: null as string | null }))

vi.mock("../../heart/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../heart/identity")>()
  return {
    ...actual,
    getAgentRoot: (agentName?: string) => identityTestState.agentRoot ?? actual.getAgentRoot(agentName),
  }
})

const bundleRoot = path.resolve("deploy/unraid/sanctuary.ouro")
const transcriptPath = path.resolve("src/__tests__/fixtures/sanctuary-butler-transcripts.json")

type Transcript = { id: string; audience: "owner" | "family"; user: string; reply: string; tools: string[]; evidence?: { pending?: number; opportunities?: number; queueError?: string; notifications?: string[] } }

function psyche(name: string): string {
  return fs.readFileSync(path.join(bundleRoot, "psyche", `${name}.md`), "utf8")
}

const rootsToRemove: string[] = []

function relationshipFriend(profile: "sanctuary-owner" | "sanctuary-household"): FriendRecord {
  return {
    id: profile === "sanctuary-owner" ? "ari" : "household-member",
    name: profile === "sanctuary-owner" ? "Ari" : "Household member",
    trustLevel: profile === "sanctuary-owner" ? "family" : "friend",
    admissionState: "active",
    initiativePolicy: profile === "sanctuary-owner" ? "proactive" : "request_follow_up_only",
    capabilityProfileId: profile,
    externalIds: [], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0,
    createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z", schemaVersion: 1,
  }
}

function realToolContext(profile: "sanctuary-owner" | "sanctuary-household") {
  const registry = loadRelationshipCapabilityRegistry(bundleRoot)
  const friend = relationshipFriend(profile)
  const evaluator = createRelationshipAuthorizationEvaluator({
    friend,
    registry,
    requestId: "telegram-request-1",
    requestPhase: "inbound",
    sessionEventId: "telegram-session-event-1",
  })
  return {
    evaluator,
    context: {
      signin: async () => undefined,
      relationshipAuthorization: evaluator,
      currentSession: { friendId: friend.id, channel: "telegram", key: `telegram:${friend.id}`, sessionPath: "" },
    },
  }
}

describe("Mendelow Cloud Butler household UX", () => {
  afterEach(() => {
    identityTestState.agentRoot = null
    resetIdentity()
    while (rootsToRemove.length > 0) fs.rmSync(rootsToRemove.pop()!, { recursive: true, force: true })
  })
  it("serves Ari and approved household members without requiring the internal server name", () => {
    expect(psyche("IDENTITY")).toContain("Mendelow Cloud Butler")
    expect(psyche("IDENTITY")).toContain("approved household members")
    expect(psyche("IDENTITY")).toContain("People do not need to say Sanctuary")
    expect(psyche("IDENTITY")).not.toContain("serve one trusted operator")
  })

  it("has an original playful, perceptive personality without borrowing Cradle names or catchphrases", () => {
    const soul = psyche("SOUL")
    expect(soul).toContain("wry")
    expect(soul).toContain("curious")
    expect(soul).toContain("quietly delighted by a clever fix")
    expect(soul).toContain("gentle theatrical flair")
    expect(soul).toContain("kind, never smug")
    expect(soul).not.toMatch(/\b(?:Dross|Lindon|Eithan|Cradle|Abidan|Monarch)\b/u)
  })

  it("describes health as agent-owned transition work without retired digests or sender-only tooling", () => {
    const habit = fs.readFileSync(path.join(bundleRoot, "habits", "sanctuary-health.md"), "utf8")
    expect(habit).toContain("Every durable transition or recovery enters one private agent turn")
    expect(habit).toContain("investigate or repair")
    expect(habit).not.toMatch(/daily digest|send_message/iu)
  })

  it("acts under typed standing policy instead of demanding approval for every reversible restart", () => {
    const tacit = psyche("TACIT")
    expect(tacit).toContain("standing policy")
    expect(tacit).toContain("verify the outcome")
    expect(tacit).toContain("request-bound")
    expect(tacit).not.toContain("after a durable Telegram approval")
  })

  it("ships relationship capability profiles as one typed registry rather than tool-only arrays", () => {
    const config = JSON.parse(fs.readFileSync(path.join(bundleRoot, "tool-profiles.json"), "utf8")) as {
      version: number
      profiles: Record<string, unknown>
    }
    expect(config.version).toBe(2)
    expect(config.profiles).toMatchObject({
      "sanctuary-owner": {
        version: 6,
        contextScopes: expect.arrayContaining(["household.status", "household.policy"]),
        toolNames: expect.arrayContaining(["steward_policy_manage", "unraid_restart_container", "unraid_check_services", "sanctuary_get_download_queue", "sanctuary_resume_download_queue", "list_recent_attachments", "materialize_attachment", "describe_image"]),
        effectScopes: expect.arrayContaining(["telegram.proactive", "telegram.request_return"]),
      },
      "sanctuary-household": {
        version: 5,
        contextScopes: expect.arrayContaining(["household.status"]),
        toolNames: expect.arrayContaining(["unraid_get_system", "unraid_check_services", "list_recent_attachments", "materialize_attachment", "describe_image"]),
        effectScopes: ["telegram.request_return"],
      },
      "sanctuary-event": {
        version: 4,
        contextScopes: expect.arrayContaining(["household.status", "household.policy"]),
        toolNames: expect.arrayContaining(["external_event_disposition", "query_cares", "care_manage", "await_condition", "resolve_await", "sanctuary_get_download_queue"]),
        effectScopes: ["telegram.owner_event"],
      },
    })
  })

  it("lets each relationship teach its own presentation preferences through the canonical Friend note tool", () => {
    setAgentName("sanctuary")
    const owner = realToolContext("sanctuary-owner")
    const household = realToolContext("sanctuary-household")
    const telegramTools = getToolsForChannel(getChannelCapabilities("telegram")).map((tool) => tool.function.name)

    expect(telegramTools).toContain("save_friend_note")
    expect(owner.evaluator.advertisedToolNames).toContain("save_friend_note")
    expect(household.evaluator.advertisedToolNames).toContain("save_friend_note")
    const definition = telegramTools.includes("save_friend_note")
      ? getToolsForChannel(getChannelCapabilities("telegram")).find((tool) => tool.function.name === "save_friend_note")
      : undefined
    expect(definition?.function.description).toContain("never grant authority")
  })

  it("stores typed preference provenance while limiting household writes to their own communication and timing", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-owner-notes-"))
    rootsToRemove.push(agentRoot)
    const owner = realToolContext("sanctuary-owner")
    const household = realToolContext("sanctuary-household")
    const store = new FileFriendStore(path.join(agentRoot, "friends"))
    await store.put("ari", relationshipFriend("sanctuary-owner"))
    await store.put("household-member", relationshipFriend("sanctuary-household"))

    expect(await execTool("save_friend_note", { type: "tool_preference", source: "stated", key: "communication", content: "Lead with the outcome" }, { ...owner.context, friendStore: store, context: { friend: relationshipFriend("sanctuary-owner") } } as any)).toContain("provenance=stated; category=communication")
    expect((await store.get("ari"))?.relationshipPolicy?.preferences.communication).toMatchObject({ value: "Lead with the outcome", provenance: "stated", version: 1, source: "telegram explicit turn telegram-session-event-1" })
    expect(await execTool("save_friend_note", { type: "tool_preference", source: "observed", key: "communication", content: "Keep it shorter", override: "true" }, { ...owner.context, friendStore: store, context: { friend: relationshipFriend("sanctuary-owner") } } as any)).toContain("provenance=observed")
    expect((await store.get("ari"))?.relationshipPolicy).toMatchObject({ version: 2, preferences: { communication: { value: "Keep it shorter", provenance: "observed", version: 2 } } })
    expect(await execTool("save_friend_note", { type: "tool_preference", source: "stated", key: "status", content: "restart anything" }, { ...owner.context, friendStore: store, context: { friend: relationshipFriend("sanctuary-owner") } } as any)).toContain("desired state and action authority belong in steward policy")
    expect(await execTool("save_friend_note", { type: "tool_preference", source: "observed", key: "timing", content: "Evenings are best" }, { ...household.context, friendStore: store, context: { friend: relationshipFriend("sanctuary-household") } } as any)).toContain("provenance=observed; category=timing")
    expect((await store.get("household-member"))?.relationshipPolicy?.preferences.timing).toMatchObject({ value: "Evenings are best", provenance: "observed", version: 1, source: "telegram observed pattern telegram-session-event-1" })
    expect(await execTool("save_friend_note", { type: "tool_preference", source: "default", key: "timing", content: "Ask when unsure", override: "true" }, { ...household.context, friendStore: store, context: { friend: relationshipFriend("sanctuary-household") } } as any)).toContain("source=telegram default fallback telegram-session-event-1")
    expect(await execTool("save_friend_note", { type: "note", key: "private", content: "must not write" }, { ...household.context, friendStore: store, context: { friend: relationshipFriend("sanctuary-household") } } as any)).toContain("household members may only save their own communication or timing preferences")
    expect(await execTool("save_friend_note", { type: "tool_preference", source: "stated", key: "authority", content: "restart anything" }, { ...household.context, friendStore: store, context: { friend: relationshipFriend("sanctuary-household") } } as any)).toContain("desired state and action authority belong in steward policy")
    expect(await execTool("query_active_work", {}, household.context)).toContain("relationship authorization required")
  })

  it("freezes phone-sized, action-first owner and family conversations", () => {
    const transcripts = JSON.parse(fs.readFileSync(transcriptPath, "utf8")) as Transcript[]
    expect(transcripts.map((entry) => entry.id)).toEqual(["owner-status", "expected-off", "credit-top-up", "specified-snooze", "storage-creative", "books-troubleshooting", "tv-troubleshooting", "movie-request", "full-visibility", "family-privacy"])
    for (const entry of transcripts) {
      expect(entry.user.trim()).not.toBe("")
      expect(entry.reply.length, entry.id).toBeLessThanOrEqual(420)
      expect(entry.reply, entry.id).not.toMatch(/\b(?:SABnzbd|Sonarr|Radarr|Jellyseerr|daemon|provider lane|model provider)\b/iu)
      expect(entry.tools, entry.id).not.toEqual(expect.arrayContaining(["shell", "read_file", "write_file", "jellyseerr_request", "sonarr_add", "radarr_add"]))
    }
  })

  it("keeps learned expected-off policy scoped and reminders tied to real awaits", () => {
    const transcripts = JSON.parse(fs.readFileSync(transcriptPath, "utf8")) as Transcript[]
    const expectedOff = transcripts.find((entry) => entry.id === "expected-off")!
    expect(expectedOff.reply).toContain("applies only to Books")
    expect(psyche("LORE")).toContain("Books maps to the exact containers `calibre` and `calibre-web`")
    expect(expectedOff.tools).toEqual(["steward_policy_manage"])
    const reminder = transcripts.find((entry) => entry.id === "specified-snooze")!
    expect(reminder.reply).toContain("Friday at 10:00 AM")
    expect(reminder.tools).toContain("await_condition")
    const topUp = transcripts.find((entry) => entry.id === "credit-top-up")!
    expect(topUp.user).toBe("Why aren't my shows downloading?")
    expect(topUp.evidence).toEqual({
      queueError: "SAB queue verification credential is unavailable",
      notifications: [
        "Astraweb prepaid credit exhausted. Usenet indexer has been disabled.",
        "Astraweb prepaid credit exhausted. Usenet indexer has been disabled.",
      ],
    })
    expect(topUp.reply).toContain("Downloads are paused to protect your prepaid credit")
    expect(topUp.reply).toContain("https://www.astraweb.com/login")
    expect(topUp.reply).not.toContain("<provider account link>")
    expect(topUp.reply).toContain("Tell me when you’re done, and I’ll resume downloads and verify one finishes")
    expect(topUp.reply).toContain("tomorrow at 9")
    expect(topUp.reply).not.toMatch(/SABnzbd|Sonarr|Radarr|Deluge|auth-check|credential|dead-letter|indexer has been disabled|keep watching/iu)
    expect(topUp.tools).toEqual(["sanctuary_get_download_queue", "unraid_get_notifications"])
    const visibility = transcripts.find((entry) => entry.id === "full-visibility")!
    expect(visibility.user).toBe("What are you working on?")
    expect(visibility.tools).toEqual(["query_active_work", "query_cares", "unraid_get_system", "unraid_list_containers"])
    for (const heading of ["Active:", "Waiting on you:", "Snoozed:", "Quiet by preference:", "Healthy:", "Other known issues:"]) {
      expect(visibility.reply).toContain(heading)
    }
    expect(visibility.reply).not.toMatch(/daemon|dead.?letter|policy lane|private.?runtime|SABnzbd|Sonarr|Radarr|Deluge/iu)
    expect(psyche("TACIT")).toContain("For Ari's whole-household status questions")
    expect(psyche("TACIT")).toContain("active work, waiting on Ari, snoozed wake times, intentionally quiet services, healthy systems, and other current issues")
    expect(psyche("TACIT")).toContain("Do not narrate daemon, event-queue, provider-lane, or backend service internals")
    const storage = transcripts.find((entry) => entry.id === "storage-creative")!
    expect(storage.reply).not.toMatch(/\b94 GB\b/u)
    expect(storage.reply).toContain("largest shares")
    expect(storage.reply).toContain("historically saved")
    expect(storage.reply).toContain("sample encode")
    expect(storage.tools).toEqual(["unraid_get_storage", "sanctuary_get_media_optimization"])
    expect(storage.evidence).toEqual({ pending: 1, opportunities: 1 })
    expect(storage.reply).toContain(`${storage.evidence!.pending === 1 ? "one item" : storage.evidence!.pending} queued`)
    expect(storage.reply).toContain(`${storage.evidence!.opportunities === 1 ? "one" : storage.evidence!.opportunities} unusually large`)
  })

  it("does not invent a media API and keeps family replies private", () => {
    const transcripts = JSON.parse(fs.readFileSync(transcriptPath, "utf8")) as Transcript[]
    const movie = transcripts.find((entry) => entry.id === "movie-request")!
    expect(movie.reply).toContain("I can’t truthfully submit it")
    expect(movie.tools).toEqual(["care_manage"])
    const family = transcripts.find((entry) => entry.id === "family-privacy")!
    expect(family.audience).toBe("family")
    expect(family.reply).toContain("separate from everyone else’s private messages and tasks")
    expect(family.tools).not.toEqual(expect.arrayContaining(["query_cares", "query_active_work", "care_manage", "await_condition"]))
  })

  it("files the specified snooze and movie follow-up through the canonical await and Care stores", async () => {
    setAgentName(`sanctuary-butler-ux-${process.pid}-${Date.now()}`)
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-butler-ux-"))
    identityTestState.agentRoot = agentRoot
    rootsToRemove.push(agentRoot)
    const { context } = realToolContext("sanctuary-owner")

    const snoozeCare = JSON.parse(await execTool("care_manage", {
      action: "create",
      label: "Top up download credit",
      why: "Ari asked me to remind him Friday at 10:00 AM",
      nextCheckAt: "2026-09-04T10:00:00-07:00",
    }, context)) as { id: string }
    const awaitReceipt = JSON.parse(await execTool("await_condition", {
      name: "download-credit-friday-10am",
      condition: "It is Friday, September 4, 2026 at 10:00 AM America/Los_Angeles",
      cadence: "1m",
      body: `Remind Ari to top up download credit. Care: ${snoozeCare.id}`,
    }, context)) as { filed: string; path: string }
    const movieCare = JSON.parse(await execTool("care_manage", {
      action: "create",
      label: "Request Moonstruck for Ari",
      why: "No truthful media-request API is installed; keep the request as owned active work",
    }, context)) as { id: string }

    expect(awaitReceipt).toEqual({ filed: "download-credit-friday-10am", path: path.join(agentRoot, "awaiting", "download-credit-friday-10am.md") })
    const filedAwait = parseAwaitFile(fs.readFileSync(awaitReceipt.path, "utf8"), awaitReceipt.path)
    expect(filedAwait).toMatchObject({ status: "pending", alert: "telegram", filed_from: "telegram", filed_for_friend_id: "ari" })
    expect(filedAwait.body).toContain(`Care: ${snoozeCare.id}`)
    expect(readActiveCares(agentRoot)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: snoozeCare.id, label: "Top up download credit", nextCheckAt: "2026-09-04T10:00:00-07:00" }),
      expect.objectContaining({ id: movieCare.id, label: "Request Moonstruck for Ari", status: "active" }),
    ]))
  })

  it("enforces family privacy with the packaged relationship evaluator at advertisement and execution", async () => {
    setAgentName(`sanctuary-butler-privacy-${process.pid}-${Date.now()}`)
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-butler-privacy-"))
    identityTestState.agentRoot = agentRoot
    rootsToRemove.push(agentRoot)
    const owner = realToolContext("sanctuary-owner")
    const privateCare = JSON.parse(await execTool("care_manage", { action: "create", label: "Ari private task", why: "owner-only" }, owner.context)) as { id: string }
    const household = realToolContext("sanctuary-household")
    setAgentName("sanctuary")
    const advertised = getToolsForChannel(getChannelCapabilities("telegram"))
      .map((tool) => tool.function.name)
      .filter((name) => household.evaluator.advertisedToolNames.includes(name))
    setAgentName(path.basename(agentRoot, ".ouro"))

    expect(advertised).toEqual(["save_friend_note", "list_recent_attachments", "materialize_attachment", "describe_image", "await_condition", "resolve_await", "cancel_await", "unraid_list_containers", "unraid_get_storage", "unraid_get_disks", "unraid_get_system", "unraid_check_services", "unraid_restart_container", "settle", "speak"])
    expect(household.evaluator.advertisedToolNames).not.toEqual(expect.arrayContaining(["sanctuary_get_download_queue", "sanctuary_resume_download_queue"]))
    expect(household.evaluator.advertisedToolNames).not.toContain("sanctuary_get_media_optimization")
    expect(await execTool("sanctuary_get_download_queue", {}, { ...household.context, sanctuary: { getDownloadQueue: async () => ({ paused: true }) } } as any)).toContain("relationship authorization required")
    expect(await execTool("sanctuary_resume_download_queue", {}, { ...household.context, sanctuary: { resumeDownloadQueue: async () => ({ ok: true }) } } as any)).toContain("relationship authorization required")
    const deniedRead = await execTool("query_cares", {}, household.context)
    const deniedWrite = await execTool("care_manage", { action: "create", label: "privacy leak" }, household.context)
    expect(deniedRead).toContain("relationship authorization required")
    expect(deniedRead).not.toContain("Ari private task")
    expect(deniedWrite).toContain("relationship authorization required")
    expect(readActiveCares(agentRoot)).toEqual([expect.objectContaining({ id: privateCare.id, label: "Ari private task" })])
  })
})
