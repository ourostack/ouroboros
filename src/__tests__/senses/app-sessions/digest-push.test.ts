import { describe, expect, it, vi } from "vitest"
import { EMPTY_DIGEST_STATE, type Digest, type DigestSession, type DigestState } from "../../../senses/app-sessions/digest"
import { conditions, HOLD_MS, PUSH_GAP_MS, PUSH_LIST_MAX, pushDue, pushMessage } from "../../../senses/app-sessions/digest-push"
import type { NotifyOutcome } from "../../../senses/app-sessions/waiting-prompts"

const NOW = Date.parse("2026-11-15T22:00:00Z")
const MIN = 60_000

function session(id: string, state: DigestSession["state"], card?: { slug: string; status: string; next?: string | null }): DigestSession {
  return { id, name: `Lane ${id}`, state, detail: `${state} detail`, lastActivity: null, ...(card ? { card: { track: "eng", slug: card.slug, title: `Title ${card.slug}`, status: card.status, next: card.next ?? null } } : {}) }
}

function digest(extra: Partial<Digest> = {}): Digest {
  return { at: new Date(NOW).toISOString(), appRunning: true, counts: { working: 0, idle: 0, waiting: 0, stuck: 0 }, sessions: [], needsOwner: [], machine: null, drains: null, merged: [], unread: [], tokens: 0, ...extra }
}

const state = (extra: Partial<DigestState> = {}): DigestState => ({ ...structuredClone(EMPTY_DIGEST_STATE), seeded: true, ...extra })
const notifier = (outcome: NotifyOutcome = "sent") => vi.fn(async () => outcome)

describe("conditions", () => {
  it("names work ready for the owner, an answer they owe, finished work and what is broken, and leaves prompts to their own notice", () => {
    const found = conditions(digest({
      appRunning: false,
      sessions: [session("a", "idle", { slug: "k", status: "done" }), session("b", "stuck")],
      needsOwner: [
        { kind: "prompt", key: "prompt:x", session: "x", name: "P", text: "trust", since: 1 },
        { kind: "ready", key: "ready:eng/r", session: "r", name: "Ready lane", text: "ready for you: R", since: null },
        { kind: "waiting", key: "waiting:w", session: "w", name: "Ask lane", text: "waiting for you", since: 1 },
      ],
      machine: { installed: true, heartbeat: "bad", beatAgeS: 3, bad: "frozen", restartedAt: null, resumedAt: null, watched: 1, watchBad: [{ id: "s9", title: "Bad lane", status: "erroring" }] },
      drains: { polling: 0, waiting: 0, relays: 0, stale: ["owner/repo: 40 min"], quota: [] },
    }), { "eng/k": "validating" })
    expect(found.map(item => `${item.kind}:${item.key}`)).toEqual([
      "ready:ready:eng/r", "needs-you:waiting:w", "done:done:eng/k", "broken:stuck:b", "broken:machine:heartbeat", "broken:watch:s9", "broken:drain:owner/repo", "broken:app:down",
    ])
    expect(found.find(item => item.key === "machine:heartbeat")!.text).toBe("the Mac watcher's heartbeat is bad: frozen")
  })

  it("calls a card done only on the move into done, and a heartbeat with no stated problem by its state", () => {
    expect(conditions(digest({ sessions: [session("a", "idle", { slug: "k", status: "done" })] }), { "eng/k": "done" })).toEqual([])
    expect(conditions(digest({ sessions: [session("a", "idle", { slug: "k", status: "done" })] }), {})).toEqual([])
    expect(conditions(digest({ machine: { installed: true, heartbeat: "stale", beatAgeS: 999, bad: null, restartedAt: null, resumedAt: null, watched: 0, watchBad: [] } }), {})[0]!.text).toBe("the Mac watcher's heartbeat is stale")
    expect(conditions(digest({ machine: { installed: true, heartbeat: "ok", beatAgeS: 1, bad: null, restartedAt: null, resumedAt: null, watched: 0, watchBad: [] } }), {})).toEqual([])
  })
})

describe("pushMessage", () => {
  it("groups what is due by kind, the owner's own work first, with a blank line between groups", () => {
    const text = pushMessage([
      { key: "d", kind: "done", text: "Shipped", holdMs: 0 }, { key: "b", kind: "broken", text: "drain stale", holdMs: 0 },
      { key: "r", kind: "ready", text: "Reviewed", holdMs: 0 }, { key: "n", kind: "needs-you", text: "Asked", holdMs: 0 },
    ])
    expect(text).toBe("**Waiting on you**\n- Asked\n\n**Ready for you**\n- Reviewed\n\n**Still broken**\n- drain stale\n\n**Done**\n- Shipped")
  })
})

describe("pushDue", () => {
  const ready = (slug = "r"): Pick<Digest, "needsOwner"> => ({ needsOwner: [{ kind: "ready", key: `ready:eng/${slug}`, session: "r", name: "Lane", text: "ready for you: Reviewed", since: null }] })
  const stuck = (): Pick<Digest, "sessions"> => ({ sessions: [session("b", "stuck")] })

  it("tells the owner at once about work that is ready, once, then not again while it stays ready", async () => {
    const notify = notifier()
    const st = state()
    const first = await pushDue(digest(ready()), st, NOW, notify)
    expect(first.sent).toBe("**Ready for you**\n- Lane — ready for you: Reviewed")
    expect(notify).toHaveBeenCalledWith(first.sent, ["ready:eng/r"])
    expect(st.lastPushAt).toBe(NOW)
    expect((await pushDue(digest(ready()), st, NOW + 40 * MIN, notify)).sent).toBeNull()
    expect(notify).toHaveBeenCalledTimes(1)
    await pushDue(digest(), st, NOW + 50 * MIN, notify)
    expect(st.pushed).toEqual({})
    expect((await pushDue(digest(ready()), st, NOW + 120 * MIN, notify)).sent).not.toBeNull()
  })

  it("does not announce work that was already ready or done when it first looks, and tells a done move after that", async () => {
    const notify = notifier()
    const st = state({ seeded: false })
    expect((await pushDue(digest({ ...ready(), sessions: [session("a", "idle", { slug: "old", status: "done" }), session("b", "stuck")] }), st, NOW, notify)).sent).toBeNull()
    expect(Object.keys(st.pushed)).toEqual(["ready:eng/r"])
    expect(st.seeded).toBe(true)
    expect(st.cards["eng/old"]).toBe("done")
    const moving = state({ cards: { "eng/k": "validating" } })
    const done = await pushDue(digest({ sessions: [session("a", "idle", { slug: "k", status: "done" })] }), moving, NOW, notify)
    expect(done.sent).toBe("**Done**\n- Title k")
    expect(moving.cards["eng/k"]).toBe("done")
  })

  it("holds a broken thing until it has lasted, then tells it once, and tells it again if it clears and returns", async () => {
    const notify = notifier()
    const st = state()
    expect((await pushDue(digest(stuck()), st, NOW, notify)).due).toBe(0)
    expect((await pushDue(digest(stuck()), st, NOW + HOLD_MS.stuck - 1, notify)).sent).toBeNull()
    const told = await pushDue(digest(stuck()), st, NOW + HOLD_MS.stuck, notify)
    expect(told.sent).toBe("**Still broken**\n- Lane b is stuck: stuck detail")
    expect((await pushDue(digest(stuck()), st, NOW + 3 * HOLD_MS.stuck, notify)).sent).toBeNull()
    await pushDue(digest(), st, NOW + 4 * HOLD_MS.stuck, notify)
    expect(st.firstSeen).toEqual({})
    await pushDue(digest(stuck()), st, NOW + 5 * HOLD_MS.stuck, notify)
    expect((await pushDue(digest(stuck()), st, NOW + 6 * HOLD_MS.stuck, notify)).sent).not.toBeNull()
  })

  it("sends at most one message per half hour, batching what became due, and keeps the rest for later", async () => {
    const notify = notifier()
    const st = state({ lastPushAt: NOW - 10 * MIN })
    const early = await pushDue(digest(ready("a")), st, NOW, notify)
    expect(early).toEqual({ sent: null, due: 1 })
    expect(notify).not.toHaveBeenCalled()
    const later = await pushDue(digest({ needsOwner: [...ready("a").needsOwner, ...ready("b").needsOwner] }), st, NOW + PUSH_GAP_MS, notify)
    expect(later.sent!.match(/^- /gm)).toHaveLength(2)
  })

  it("keeps an item for the next digest when nothing reached the owner, and counts the ones that do not fit", async () => {
    const pending = notifier("pending")
    const st = state({ cards: { "eng/k": "validating" } })
    const waiting = digest({ ...ready(), sessions: [session("a", "idle", { slug: "k", status: "done" })] })
    expect((await pushDue(waiting, st, NOW, pending)).sent).toBeNull()
    expect(st.pushed).toEqual({})
    expect(st.cards["eng/k"]).toBe("validating")
    expect(st.lastPushAt).toBe(0)
    const many = Array.from({ length: PUSH_LIST_MAX + 3 }, (_, index) => ready(`s${index}`).needsOwner[0]!)
    const unknown = notifier("unknown")
    const sent = await pushDue(digest({ needsOwner: many }), state(), NOW, unknown)
    expect(sent.sent).toMatch(/and 3 more$/)
    expect(unknown.mock.calls[0]![1]).toHaveLength(PUSH_LIST_MAX)
  })
})
