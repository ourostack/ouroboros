import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"
import type { AppSessionRow } from "../../../senses/app-sessions/client"
import { EMPTY_DIGEST_STATE, type Digest, type DigestSession, type DigestState } from "../../../senses/app-sessions/digest"
import { conditions, HOLD_MS, PUSH_GAP_MS, PUSH_LIST_MAX, pushDue, pushMessage, stillDue, type PushItem } from "../../../senses/app-sessions/digest-push"
import type { NotifyOutcome } from "../../../senses/app-sessions/waiting-prompts"

const NOW = Date.parse("2026-11-16T15:49:28Z")
const MIN = 60_000
const TRACKER = "ad8f4be3-3a5a-4bc7-bb55-7821d8b5934c"

function session(id: string, state: DigestSession["state"], extra: Partial<DigestSession> = {}): DigestSession {
  return { id, name: `Lane ${id}`, state, detail: `${state} detail`, lastActivity: null, ...extra }
}

function digest(extra: Partial<Digest> = {}): Digest {
  return { at: new Date(NOW).toISOString(), appRunning: true, counts: { working: 0, idle: 0, waiting: 0, stuck: 0 }, sessions: [], needsOwner: [], machine: null, drains: null, merged: [], unread: [], tokens: 0, ...extra }
}

const state = (extra: Partial<DigestState> = {}): DigestState => ({ ...structuredClone(EMPTY_DIGEST_STATE), seeded: true, ...extra })
const notifier = (outcome: NotifyOutcome = "sent") => vi.fn(async (_text: string, _keys: string[]) => outcome)
const ready = (slug = "r", name = "Lane"): Pick<Digest, "needsOwner"> => ({ needsOwner: [{ kind: "ready", key: `ready:eng/${slug}`, session: `s-${slug}`, name, text: "ready for you: Reviewed", since: null }] })
const waiting = (id = "w"): Pick<Digest, "needsOwner"> => ({ needsOwner: [{ kind: "waiting", key: `waiting:${id}`, session: id, name: "Ask lane", text: "waiting for the person's answer", since: NOW }] })

/** The digest the sense built at 07:49:28 PT on 2026-11-16, eleven seconds after the owner asked a question in Teams. */
const at0749 = (): Digest => digest({
  sessions: [session(TRACKER, "stuck", { name: "Ouro migration: customer tracker", detail: "not running, but its loop stopped between turns (its last turn called tools and no next turn started)", lastActivity: "2026-11-16T15:20:00Z" })],
  machine: { installed: true, heartbeat: "ok", beatAgeS: 29, bad: null, restartedAt: null, resumedAt: null, watched: 12, watchBad: [{ id: "x", title: "cit pages", status: "oversize" }] },
  drains: { polling: 5, waiting: 0, relays: 4, stale: ["owner/repo: 40 min"], quota: [] },
  appRunning: false,
})

describe("conditions", () => {
  it("pushes nothing from the 07:49 digest: a stuck session, the health watch, a stale drain and the app are not the owner's to act on", () => {
    expect(conditions(at0749())).toEqual([])
  })

  it("names only work ready for the owner and a session waiting on their answer, and leaves prompts to their own notice", () => {
    const found = conditions(digest({
      sessions: [session("s-r", "idle", { card: { track: "eng", slug: "r", title: "Spoonjoy store listing", status: "collaborating", next: null } })],
      needsOwner: [{ kind: "prompt", key: "prompt:x", session: "x", name: "P", text: "trust", since: 1 }, ...ready().needsOwner, ...waiting().needsOwner],
    }))
    expect(found.map(item => `${item.kind}:${item.key}`)).toEqual(["ready:ready:eng/r", "needs-you:waiting:w"])
    expect(found[0]!.text).toBe(`"Lane" has "Spoonjoy store listing" ready for you to look at.`)
    expect(conditions(digest(ready()))[0]!.text).toBe(`"Lane" has its work ready for you to look at.`)
  })

  it("never cuts a name short with an ellipsis", () => {
    const long = "A session with a very long name that goes on well past sixty characters and then some more"
    expect(conditions(digest(ready("r", long)))[0]!.text).toContain(long)
    expect(conditions(digest(ready("r", long)))[0]!.text).not.toMatch(/…|\.\.\.$/)
  })
})

describe("pushMessage", () => {
  it("puts the owner's answers first, each a whole sentence with the one link that opens it", () => {
    const items: PushItem[] = [
      { key: "r", kind: "ready", session: "s1", text: `"A" has its work ready for you to look at.`, holdMs: 0 },
      { key: "n", kind: "needs-you", session: "s2", text: `"B" is waiting for your answer.`, holdMs: 0 },
    ]
    expect(pushMessage(items)).toBe(`Waiting on you:\n- "B" is waiting for your answer. ghapp://sessions/s2\n\nReady for you:\n- "A" has its work ready for you to look at. ghapp://sessions/s1`)
  })
})

describe("pushDue", () => {
  it("tells the owner about ready work once, then not again while it stays ready, and again only after it clears and returns", async () => {
    const notify = notifier()
    const st = state()
    const first = await pushDue(digest(ready()), st, NOW, notify)
    expect(first.sent).toBe(`Ready for you:\n- "Lane" has its work ready for you to look at. ghapp://sessions/s-r`)
    expect(notify).toHaveBeenCalledWith(first.sent, ["ready:eng/r"])
    expect(st.lastPushAt).toBe(NOW)
    expect((await pushDue(digest(ready()), st, NOW + 40 * MIN, notify)).sent).toBeNull()
    expect(notify).toHaveBeenCalledTimes(1)
    await pushDue(digest(), st, NOW + 50 * MIN, notify)
    expect(st.pushed).toEqual({})
    expect((await pushDue(digest(ready()), st, NOW + 120 * MIN, notify)).sent).not.toBeNull()
  })

  it("does not announce work that was already ready when it first looks", async () => {
    const notify = notifier()
    const st = state({ seeded: false })
    expect((await pushDue(digest({ needsOwner: [...ready().needsOwner, ...waiting().needsOwner] }), st, NOW, notify)).sent).toBeNull()
    expect(Object.keys(st.pushed)).toEqual(["ready:eng/r"])
    expect(st.seeded).toBe(true)
  })

  it("holds a waiting session until it has waited ten minutes", async () => {
    const notify = notifier()
    const st = state()
    expect((await pushDue(digest(waiting()), st, NOW, notify)).due).toBe(0)
    expect((await pushDue(digest(waiting()), st, NOW + HOLD_MS.waiting, notify)).sent).toBe(`Waiting on you:\n- "Ask lane" is waiting for your answer. ghapp://sessions/w`)
  })

  it("checks again live just before sending, and drops what no longer holds, untold", async () => {
    const notify = notifier()
    const st = state()
    const both = digest({ needsOwner: [...ready("a").needsOwner, ...ready("b").needsOwner] })
    const sent = await pushDue(both, st, NOW, notify, async items => items.filter(item => item.key !== "ready:eng/a"))
    expect(sent.sent).not.toContain("s-a")
    expect(Object.keys(st.pushed)).toEqual(["ready:eng/b"])
    const gone = state()
    expect(await pushDue(digest(ready("a")), gone, NOW, notify, async () => [])).toEqual({ sent: null, due: 0 })
    expect(gone.pushed).toEqual({})
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it("sends at most one message per half hour, batching what became due", async () => {
    const notify = notifier()
    const st = state({ lastPushAt: NOW - 10 * MIN })
    expect(await pushDue(digest(ready("a")), st, NOW, notify)).toEqual({ sent: null, due: 1 })
    expect(notify).not.toHaveBeenCalled()
    const later = await pushDue(digest({ needsOwner: [...ready("a").needsOwner, ...ready("b").needsOwner] }), st, NOW + PUSH_GAP_MS, notify)
    expect(later.sent!.match(/^- /gm)).toHaveLength(2)
  })

  it("keeps an item for the next digest when it was held (the owner is talking) and counts the ones that do not fit", async () => {
    const held = notifier("pending")
    const st = state()
    expect(await pushDue(digest(ready()), st, NOW, held)).toEqual({ sent: null, due: 1 })
    expect(st.pushed).toEqual({})
    expect(st.lastPushAt).toBe(0)
    const many = Array.from({ length: PUSH_LIST_MAX + 3 }, (_, index) => ready(`s${index}`).needsOwner[0]!)
    const unknown = notifier("unknown")
    const sent = await pushDue(digest({ needsOwner: many }), state(), NOW, unknown)
    expect(sent.sent).toMatch(/and 3 more in \/status$/)
    expect(unknown.mock.calls[0]![1]).toHaveLength(PUSH_LIST_MAX)
  })
})

describe("stillDue", () => {
  const appRow = (id: string, over: Partial<AppSessionRow> = {}): AppSessionRow => ({
    id, name: id, kind: "chat", workspaceId: null, workspaceType: null, project: null, projectId: null, projectRepo: null, branch: null, path: null,
    parentSessionId: null, creatorSessionId: null, coordinatingCreatorSessionId: null, state: "idle", detail: "", isRunning: false, wasInterrupted: false, remote: false,
    createdAt: null, updatedAt: null, lastActivity: null, ...over,
  })

  it("keeps only what a fresh look still finds: a listed session still waiting, a card still ready", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "still-due-"))
    const card = (slug: string, status: string) => {
      fs.mkdirSync(path.join(root, "eng", slug), { recursive: true })
      fs.writeFileSync(path.join(root, "eng", slug, "task.md"), `---\ntitle: ${slug}\nstatus: ${status}\n---\n`)
    }
    card("ready", "collaborating")
    card("moved", "processing")
    const items: PushItem[] = [
      { key: "waiting:w", kind: "needs-you", session: "w", text: "", holdMs: 0 },
      { key: "waiting:answered", kind: "needs-you", session: "answered", text: "", holdMs: 0 },
      { key: "waiting:prompted", kind: "needs-you", session: "prompted", text: "", holdMs: 0 },
      { key: "waiting:archived", kind: "needs-you", session: "archived", text: "", holdMs: 0 },
      { key: "ready:eng/ready", kind: "ready", session: "r1", text: "", holdMs: 0 },
      { key: "ready:eng/moved", kind: "ready", session: "r2", text: "", holdMs: 0 },
      { key: "ready:bad", kind: "ready", session: "r3", text: "", holdMs: 0 },
    ]
    const rows = [
      appRow("w", { state: "waiting" }), appRow("answered", { state: "working" }), appRow("prompted", { state: "waiting", prompt: { requestId: "p", what: "trust", at: null } }),
      appRow("r1"), appRow("r2"), appRow("r3"),
    ]
    expect(stillDue(items, rows, [root]).map(item => item.key)).toEqual(["waiting:w", "ready:eng/ready"])
    fs.rmSync(root, { recursive: true, force: true })
  })
})
