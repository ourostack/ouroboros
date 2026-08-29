import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const bundleRoot = path.resolve("deploy/unraid/sanctuary.ouro")
const transcriptPath = path.resolve("src/__tests__/fixtures/sanctuary-butler-transcripts.json")

type Transcript = { id: string; audience: "owner" | "family"; user: string; reply: string; tools: string[] }

function psyche(name: string): string {
  return fs.readFileSync(path.join(bundleRoot, "psyche", `${name}.md`), "utf8")
}

describe("Mendelow Cloud Butler household UX", () => {
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
        contextScopes: expect.arrayContaining(["household.status", "household.policy"]),
        toolNames: expect.arrayContaining(["steward_policy_manage", "unraid_restart_container"]),
        effectScopes: expect.arrayContaining(["telegram.proactive", "telegram.request_return"]),
      },
      "sanctuary-household": {
        contextScopes: expect.arrayContaining(["household.status"]),
        toolNames: expect.arrayContaining(["unraid_get_system"]),
        effectScopes: ["telegram.request_return"],
      },
      "sanctuary-event": {
        contextScopes: expect.arrayContaining(["household.status", "household.policy"]),
        toolNames: expect.arrayContaining(["external_event_disposition", "query_cares", "care_manage", "await_condition"]),
        effectScopes: ["telegram.owner_event"],
      },
    })
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
    expect(expectedOff.tools).toEqual(["steward_policy_manage"])
    const reminder = transcripts.find((entry) => entry.id === "specified-snooze")!
    expect(reminder.reply).toContain("Friday at 10:00 AM")
    expect(reminder.tools).toContain("await_condition")
    const topUp = transcripts.find((entry) => entry.id === "credit-top-up")!
    expect(topUp.reply).toContain("<provider account link>")
    expect(topUp.reply).toContain("Tell me when you’re done and I’ll test it")
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
})
