import * as fs from "node:fs"
import { emitNervesEvent } from "../../nerves/runtime"
import { appSessionsStateDir } from "../../senses/app-sessions/store"
import type { PeerAppSession, PeerRecord } from "./presence"

type PeerAppSessionDesk = PeerAppSession["desk"]
import * as path from "node:path"

const SNAPSHOT_MAX_AGE_MS = 10 * 60_000
const DIGEST_MAX_AGE_MS = 60 * 60_000

interface DigestCard { track: string; slug: string; status: string; repo?: string; branch?: string; pr?: string; session?: string; file?: string; deskRepo?: string; updatedAt?: string | null }

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T
  } catch {
    return null
  }
}

/** The desk card's own pointers: its track and slug, plus the repository, branch, pull request, owning session and desk log file it names, with when it last changed. */
function deskPointer(card: DigestCard): NonNullable<PeerAppSessionDesk> {
  return {
    track: card.track, slug: card.slug, status: card.status, via: "desk",
    ...(card.pr ? { url: card.pr } : {}),
    ...(card.repo ? { repo: card.repo } : {}),
    ...(card.branch ? { branch: card.branch } : {}),
    ...(card.session ? { session: card.session } : {}),
    ...(card.file ? { file: card.file } : {}),
    ...(card.deskRepo ? { deskRepo: card.deskRepo } : {}),
    ...(card.updatedAt ? { updatedAt: card.updatedAt } : {}),
  }
}

/**
 * This machine's Copilot app sessions for its peer record, from the app-sessions sense's last snapshot. Each session
 * the digest tied to a desk card carries that card's track, slug and status, so a peer sees what work runs here and
 * where its source of truth lives (the desk), without reaching this machine. Stale snapshots publish nothing.
 */
export function appSessionsRecord(agentRoot: string, nowMs: number): Partial<PeerRecord> {
  const snap = readJson<{ at?: string; counts?: Record<string, number>; sessions?: Array<{ id: string; name?: string; state?: string }> }>(path.join(appSessionsStateDir(agentRoot), "snapshot.json"))
  if (!snap?.at || !snap.counts || nowMs - Date.parse(snap.at) > SNAPSHOT_MAX_AGE_MS) return {}
  const digest = readJson<{ at?: string; sessions?: Array<{ id: string; card?: DigestCard }> }>(path.join(appSessionsStateDir(agentRoot), "digest.json"))
  const digestFresh = !!digest?.at && nowMs - Date.parse(digest.at) <= DIGEST_MAX_AGE_MS
  const cards = new Map((digestFresh ? digest?.sessions ?? [] : []).filter((s) => s.card).map((s) => [s.id, s.card!] as const))
  const sessions = (snap.sessions ?? []).map(({ id, name, state }) => {
    const card = cards.get(id)
    return { id, name, state, ...(card ? { desk: deskPointer(card) } : {}) }
  })
  emitNervesEvent({ component: "daemon", event: "daemon.app_sessions_record_built", message: "built the app sessions part of the peer record", meta: { sessions: sessions.length, withDeskCard: cards.size } })
  return { appSessions: { at: snap.at, counts: snap.counts, sessions } }
}
