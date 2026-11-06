import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { BlueBubblesNormalizedMessage } from "../../../senses/bluebubbles/model"

describe("BlueBubbles active turn markers", () => {
  let tmpRoot = ""
  const originalHome = process.env.HOME

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bb-active-turns-"))
    process.env.HOME = tmpRoot
  })

  afterEach(() => {
    process.env.HOME = originalHome
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  function markerDir(): string {
    return path.join(tmpRoot, "AgentBundles", "slugger.ouro", "state", "senses", "bluebubbles", "active-turns")
  }

  function event(messageGuid: string): BlueBubblesNormalizedMessage {
    return {
      kind: "message",
      messageGuid,
      textForAgent: "hello",
      sender: {
        provider: "imessage-handle",
        rawId: "ari@example.com",
        externalId: "ari@example.com",
      },
      chat: {
        sessionKey: "chat:ari",
        chatGuid: "chat-guid",
        chatIdentifier: "ari@example.com",
        isGroup: false,
        participantHandles: [],
      },
      createdAt: "2026-04-30T00:00:00.000Z",
    }
  }

  it("records, snapshots, and removes markers around a live turn", async () => {
    const {
      beginBlueBubblesActiveTurn,
      finishBlueBubblesActiveTurn,
      noteBlueBubblesActiveTurnVisibleActivity,
      snapshotBlueBubblesActiveTurns,
    } = await import("../../../senses/bluebubbles/active-turns")

    const turnId = beginBlueBubblesActiveTurn("slugger", event("msg-1"))
    const secondTurnId = beginBlueBubblesActiveTurn("slugger", event("msg-2"))
    noteBlueBubblesActiveTurnVisibleActivity("slugger", turnId)

    expect(snapshotBlueBubblesActiveTurns("slugger", 90_000, Date.now() + 120_000)).toEqual(
      expect.objectContaining({
        activeTurnCount: 2,
        stalledTurnCount: 2,
      }),
    )

    finishBlueBubblesActiveTurn("slugger", turnId)
    finishBlueBubblesActiveTurn("slugger", secondTurnId)

    expect(snapshotBlueBubblesActiveTurns("slugger", 90_000, Date.now() + 120_000)).toEqual({
      activeTurnCount: 0,
      stalledTurnCount: 0,
      oldestActiveTurnStartedAt: undefined,
      oldestActiveTurnAgeMs: undefined,
    })
  })

  it("logs and keeps going when visible-activity timestamp writes fail", async () => {
    const {
      beginBlueBubblesActiveTurn,
      noteBlueBubblesActiveTurnVisibleActivity,
      snapshotBlueBubblesActiveTurns,
    } = await import("../../../senses/bluebubbles/active-turns")

    const turnId = beginBlueBubblesActiveTurn("slugger", event("msg-1"))
    const markerPath = path.join(markerDir(), fs.readdirSync(markerDir())[0])
    fs.chmodSync(markerPath, 0o400)

    expect(() => noteBlueBubblesActiveTurnVisibleActivity("slugger", turnId)).not.toThrow()
    expect(snapshotBlueBubblesActiveTurns("slugger", 90_000)).toEqual(expect.objectContaining({
      activeTurnCount: 1,
      stalledTurnCount: 0,
    }))
  })

  it("ignores malformed markers during visible-activity updates", async () => {
    const {
      beginBlueBubblesActiveTurn,
      noteBlueBubblesActiveTurnVisibleActivity,
      snapshotBlueBubblesActiveTurns,
    } = await import("../../../senses/bluebubbles/active-turns")

    const turnId = beginBlueBubblesActiveTurn("slugger", event("msg-1"))
    const markerPath = path.join(markerDir(), fs.readdirSync(markerDir())[0])
    fs.writeFileSync(markerPath, "{}\n", "utf-8")

    expect(() => noteBlueBubblesActiveTurnVisibleActivity("slugger", turnId)).not.toThrow()
    expect(snapshotBlueBubblesActiveTurns("slugger", 90_000)).toEqual({
      activeTurnCount: 0,
      stalledTurnCount: 0,
      oldestActiveTurnStartedAt: undefined,
      oldestActiveTurnAgeMs: undefined,
    })
  })

  it("keeps live turns best-effort when the marker directory is blocked", async () => {
    const { beginBlueBubblesActiveTurn } = await import("../../../senses/bluebubbles/active-turns")

    fs.mkdirSync(path.dirname(markerDir()), { recursive: true })
    fs.writeFileSync(markerDir(), "blocked", "utf-8")

    expect(() => beginBlueBubblesActiveTurn("slugger", event("msg-1"))).not.toThrow()
  })

  it("defaults optional chat fields to null when reading older marker files", async () => {
    const { listBlueBubblesActiveTurns } = await import("../../../senses/bluebubbles/active-turns")

    fs.mkdirSync(markerDir(), { recursive: true })
    fs.writeFileSync(
      path.join(markerDir(), "old-marker.json"),
      JSON.stringify({
        turnId: "old-marker",
        pid: process.pid,
        startedAt: "2026-04-30T00:00:00.000Z",
        messageGuid: "msg-old",
        sessionKey: "chat:ari",
      }, null, 2) + "\n",
      "utf-8",
    )

    expect(listBlueBubblesActiveTurns("slugger")).toEqual([
      expect.objectContaining({
        chatGuid: null,
        chatIdentifier: null,
      }),
    ])
  })

  it("prunes corrupt and dead-process markers instead of treating them as active turns", async () => {
    const { snapshotBlueBubblesActiveTurns } = await import("../../../senses/bluebubbles/active-turns")

    fs.mkdirSync(markerDir(), { recursive: true })
    const unreadable = path.join(markerDir(), "aaa-unreadable.json")
    fs.writeFileSync(
      unreadable,
      JSON.stringify({
        turnId: "unreadable",
        pid: process.pid,
        startedAt: "2026-04-30T00:00:00.000Z",
        messageGuid: "msg-unreadable",
        sessionKey: "chat:ari",
      }, null, 2) + "\n",
      "utf-8",
    )
    fs.chmodSync(unreadable, 0o000)
    fs.writeFileSync(path.join(markerDir(), "corrupt.json"), "{", "utf-8")
    fs.writeFileSync(
      path.join(markerDir(), "missing-required.json"),
      JSON.stringify({
        turnId: "missing-required",
        pid: process.pid,
        startedAt: "2026-04-30T00:00:00.000Z",
      }, null, 2) + "\n",
      "utf-8",
    )
    fs.writeFileSync(
      path.join(markerDir(), "invalid-pid.json"),
      JSON.stringify({
        turnId: "invalid-pid",
        pid: "not-a-number",
        startedAt: "2026-04-30T00:00:00.000Z",
        messageGuid: "msg-invalid-pid",
        sessionKey: "chat:ari",
      }, null, 2) + "\n",
      "utf-8",
    )
    fs.writeFileSync(
      path.join(markerDir(), "dead-process.json"),
      JSON.stringify({
        turnId: "dead-process",
        pid: 99_999_999,
        startedAt: "2026-04-30T00:00:00.000Z",
        messageGuid: "msg-dead",
        sessionKey: "chat:ari",
        chatGuid: "chat-guid",
        chatIdentifier: "ari@example.com",
      }, null, 2) + "\n",
      "utf-8",
    )

    expect(snapshotBlueBubblesActiveTurns("slugger", 90_000, Date.parse("2026-04-30T00:05:00.000Z"))).toEqual({
      activeTurnCount: 0,
      stalledTurnCount: 0,
      oldestActiveTurnStartedAt: undefined,
      oldestActiveTurnAgeMs: undefined,
    })
    expect(fs.readdirSync(markerDir())).toEqual([])
  })
})
