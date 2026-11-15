import * as path from "node:path"
import type { DigestConfig } from "../../heart/identity"
import { emitNervesEvent } from "../../nerves/runtime"
import type { AppSessionRow, AppSessionsOptions } from "./client"
import { FIRST_SCAN_BYTES, readCard, scanFocus, type CardFacts, type FocusEntry } from "./digest-cards"
import { isFolder, mergedCacheFile, readDrains, readMachine, readMergedToday, sourceFailed, type DrainFacts, type MachineFacts, type MergedFacts } from "./digest-sources"
import { appSessionsStateDir, readJson, writeJson, type WaitingPrompt } from "./store"
import type { RunCommand } from "./wake-runner"

/**
 * The status digest: one deterministic picture of how everything is going, built with no model turn from the app's
 * sessions, their task cards, the machine's health, the drains and what merged today. It is written beside the sense's
 * snapshot; the Teams `/status` command and the `app_sessions_digest` tool read it, and `digest-push.ts` decides what is
 * worth telling the owner unasked.
 */
export const DIGEST_DEFAULT_SECONDS = 300
/** A digest older than this is shown as stale: the sense that writes it may be down. */
export const DIGEST_STALE_MS = 15 * 60_000
/** Only sessions active in this window have their card looked up. */
export const CARD_WINDOW_MS = 24 * 3_600_000
/** The most history one digest reads to find declared tasks, so the first one after a start stays light. */
export const SCAN_BUDGET_BYTES = 1024 * 1024 * 1024
const INCREMENTAL_SCAN_BYTES = 4 * 1024 * 1024
const WORKING_LISTED = 8
const NAME_MAX = 60

export interface DigestSession {
  id: string
  name: string
  state: AppSessionRow["state"]
  detail: string
  lastActivity: string | null
  card?: CardFacts
}

export interface NeedsOwner {
  kind: "prompt" | "waiting" | "ready"
  key: string
  session: string
  name: string
  text: string
  /** When it began (epoch ms), when known. */
  since: number | null
}

export interface Digest {
  at: string
  appRunning: boolean
  counts: Record<AppSessionRow["state"], number>
  sessions: DigestSession[]
  needsOwner: NeedsOwner[]
  machine: MachineFacts | null
  drains: DrainFacts | null
  merged: MergedFacts[]
  /** Sources that could not be read, one line each. */
  unread: string[]
  /** Estimated tokens in the Teams text (a fourth of its characters). */
  tokens: number
}

export interface DigestState {
  focus: Record<string, FocusEntry>
  /** The last status seen of each card, `<track>/<slug>`. */
  cards: Record<string, string>
  /** When each held condition was first seen (epoch ms), so a condition must last before it is told. */
  firstSeen: Record<string, number>
  /** Conditions already told, with when; each clears when the condition does. */
  pushed: Record<string, string>
  lastPushAt: number
  seeded: boolean
}

export const EMPTY_DIGEST_STATE: DigestState = { focus: {}, cards: {}, firstSeen: {}, pushed: {}, lastPushAt: 0, seeded: false }

export function digestFiles(agentRoot: string): { json: string; state: string } {
  const dir = appSessionsStateDir(agentRoot)
  return { json: path.join(dir, "digest.json"), state: path.join(dir, "digest-state.json") }
}

export function readDigestState(agentRoot: string): DigestState {
  return { ...EMPTY_DIGEST_STATE, ...readJson<Partial<DigestState>>(digestFiles(agentRoot).state, {}) }
}

export function expandHome(folder: string, home: string): string {
  return folder === "~" ? home : folder.startsWith("~/") ? path.join(home, folder.slice(2)) : folder
}

export interface DigestInput {
  agentRoot: string
  config: DigestConfig
  client: AppSessionsOptions
  run: RunCommand
  now: number
  home: string
  rows: AppSessionRow[]
  appRunning: boolean
  waitingPrompts: WaitingPrompt[]
  state: DigestState
  /** The most history to read this time to find declared tasks; tests set it small. */
  scanBudgetBytes?: number
}

function cut(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

export function minutes(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000))
  return min < 90 ? `${min} min` : min < 60 * 36 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} d`
}

/** Looks up every recently active session's declared task and card; reads at most the scan budget of history. */
function attachCards(input: DigestInput): Map<string, CardFacts> {
  const roots = (input.config.deskRoots ?? []).map(folder => expandHome(folder, input.home)).filter(isFolder)
  const cards = new Map<string, CardFacts>()
  if (!roots.length) return cards
  let budget = input.scanBudgetBytes ?? SCAN_BUDGET_BYTES
  const known = new Set(input.rows.map(row => row.id))
  for (const id of Object.keys(input.state.focus)) if (!known.has(id)) delete input.state.focus[id]
  const busyFirst = [...input.rows].sort((a, b) => Number(a.state === "idle") - Number(b.state === "idle"))
  for (const row of busyFirst) {
    const active = row.state !== "idle" || (row.lastActivity !== null && input.now - Date.parse(row.lastActivity) < CARD_WINDOW_MS)
    if (!active || row.remote) continue
    if (budget > 0) {
      const scanned = scanFocus(row.id, input.state.focus[row.id], Math.min(budget, input.state.focus[row.id] ? INCREMENTAL_SCAN_BYTES : FIRST_SCAN_BYTES), input.client)
      input.state.focus[row.id] = scanned.entry
      budget -= scanned.bytes
    }
    const focus = input.state.focus[row.id]
    const card = focus?.track && focus.slug ? readCard(roots, focus.track, focus.slug) : null
    if (card) cards.set(row.id, card)
  }
  return cards
}

/** What only the owner can do next: an open prompt, an answer to give, or finished work to look at. */
function needsOwner(sessions: DigestSession[], prompts: WaitingPrompt[], now: number): NeedsOwner[] {
  const items: NeedsOwner[] = prompts.map(prompt => ({ kind: "prompt", key: `prompt:${prompt.session}:${prompt.requestId}`, session: prompt.session, name: prompt.name, text: prompt.what, since: prompt.since }))
  const prompted = new Set(prompts.map(prompt => prompt.session))
  for (const session of sessions) {
    if (session.state === "waiting" && !prompted.has(session.id)) {
      const since = session.lastActivity ? Date.parse(session.lastActivity) : NaN
      items.push({ kind: "waiting", key: `waiting:${session.id}`, session: session.id, name: session.name, text: session.detail, since: Number.isNaN(since) ? now : since })
    }
    if (session.card?.status === "collaborating") {
      items.push({ kind: "ready", key: `ready:${session.card.track}/${session.card.slug}`, session: session.id, name: session.name, text: `ready for you: ${session.card.title}${session.card.next ? `. Next: ${session.card.next}` : ""}`, since: null })
    }
  }
  return items
}

/** Builds the digest from the app's rows and every source the config names. A source that fails is named in `unread`. */
export async function buildDigest(input: DigestInput): Promise<Digest> {
  const cards = attachCards(input)
  const unread: string[] = []
  const sessions: DigestSession[] = input.rows
    .filter(row => row.state !== "idle" || cards.has(row.id))
    .map(row => ({
      id: row.id,
      name: cut(row.name, NAME_MAX),
      state: row.state,
      detail: row.detail,
      lastActivity: row.lastActivity,
      ...(cards.has(row.id) ? { card: cards.get(row.id) } : {}),
    }))
  const counts: Digest["counts"] = { working: 0, idle: 0, waiting: 0, stuck: 0 }
  for (const row of input.rows) counts[row.state] += 1

  const machine = await readMachine(input.client).catch(/* v8 ignore next -- readMachine never throws @preserve */ (error: Error) => ({ error: error.message }) as MachineFacts)
  if (machine.error) unread.push(sourceFailed("machine health", machine.error))
  const drains = await readDrains(input.config.drains, input.run, input.now)
  if (drains?.error) unread.push(sourceFailed("drains", drains.error))
  const merged: MergedFacts[] = []
  for (const account of input.config.mergedToday ?? []) {
    const facts = await readMergedToday(account, input.run, mergedCacheFile(appSessionsStateDir(input.agentRoot)), input.now)
    if (facts.error) unread.push(sourceFailed(`merged today (${account.label})`, facts.error))
    merged.push(facts)
  }
  const digest: Digest = {
    at: new Date(input.now).toISOString(),
    appRunning: input.appRunning,
    counts,
    sessions,
    needsOwner: needsOwner(sessions, input.waitingPrompts, input.now),
    machine: machine.installed || machine.error ? machine : null,
    drains,
    merged,
    unread,
    tokens: 0,
  }
  digest.tokens = Math.ceil(renderDigest(digest, input.now).length / 4)
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_digest_built", message: "built the status digest", meta: { sessions: sessions.length, needsOwner: digest.needsOwner.length, unread: unread.length, tokens: digest.tokens } })
  return digest
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZoneName: "short" })
}

function sessionLine(session: DigestSession, now: number): string {
  const last = session.lastActivity ? Date.parse(session.lastActivity) : NaN
  const bits = [session.card?.next ?? (session.card ? session.card.title : null), Number.isNaN(last) ? null : `last turn ${minutes(now - last)} ago`].filter(Boolean)
  return `- ${session.name}${bits.length ? ` — ${bits.join("; ")}` : ""}`
}

/** The digest as the short Teams message: a blank line between paragraphs, bullets where there are several. `plain` leaves out the bold marks, for a send that is plain text. */
export function renderDigest(digest: Digest, now: number, plain = false): string {
  const at = Date.parse(digest.at)
  const blocks: string[] = [`**Ouroboros status** · ${clock(at)}`]
  if (digest.needsOwner.length) {
    blocks.push(["**Needs you**", ...digest.needsOwner.map(item => `- ${item.name} — ${item.text}${item.since ? ` (${minutes(now - item.since)})` : ""}`)].join("\n"))
  }
  const broken: string[] = []
  for (const session of digest.sessions) if (session.state === "stuck") broken.push(`- ${session.name} — stuck (${session.detail})`)
  if (digest.machine?.heartbeat === "bad" || digest.machine?.heartbeat === "stale") broken.push(`- Mac watcher — heartbeat ${digest.machine.heartbeat}${digest.machine.bad ? `: ${digest.machine.bad}` : ""}`)
  for (const session of digest.machine?.watchBad ?? []) broken.push(`- ${cut(session.title, NAME_MAX)} — health watch: ${session.status}`)
  for (const stale of digest.drains?.stale ?? []) broken.push(`- drain ${stale} since its last good poll`)
  if (broken.length) blocks.push(["**Broken**", ...broken].join("\n"))

  const { counts } = digest
  const working = digest.sessions.filter(session => session.state === "working")
  const list = working.slice(0, WORKING_LISTED).map(session => sessionLine(session, now))
  if (working.length > WORKING_LISTED) list.push(`- and ${working.length - WORKING_LISTED} more`)
  blocks.push([`**Sessions** ${counts.working} working · ${counts.waiting} waiting · ${counts.stuck} stuck · ${counts.idle} idle${digest.appRunning ? "" : " · the app is not running"}`, ...list].join("\n"))

  if (digest.machine) {
    const machine = digest.machine
    const parts = [
      machine.installed ? `heartbeat ${machine.heartbeat}${machine.beatAgeS === null ? "" : ` (${machine.beatAgeS} s)`}` : "status unreadable",
      machine.restartedAt ? `app restarted ${minutes(now - Date.parse(machine.restartedAt))} ago` : null,
      machine.resumedAt ? `last resume ${minutes(now - Date.parse(machine.resumedAt))} ago` : null,
      machine.installed ? `health watch: ${machine.watched} sessions, ${machine.watchBad.length} not ok` : null,
    ].filter(Boolean)
    blocks.push(`**Machine** ${parts.join(" · ")}`)
  }
  if (digest.drains) {
    const drains = digest.drains
    blocks.push(`**Drains** ${drains.polling} polling, ${drains.stale.length} stale · ${drains.relays} relays · ${drains.waiting} issues waiting${drains.quota.length ? ` · quota ${drains.quota.join(", ")}` : ""}`)
  }
  if (digest.merged.length) {
    const total = digest.merged.reduce((sum, account) => sum + account.count, 0)
    const prs = digest.merged.flatMap(account => account.prs).slice(0, 4).map(pr => `- ${pr.repo}#${pr.number} ${cut(pr.title, 70)}`)
    blocks.push([`**Merged today** ${total}${digest.merged.length > 1 ? ` (${digest.merged.map(account => `${account.label} ${account.count}`).join(", ")})` : ""}`, ...prs].join("\n"))
  }
  if (digest.unread.length) blocks.push(`Not read: ${digest.unread.join("; ")}`)
  const text = blocks.join("\n\n")
  return plain ? text.replace(/\*\*/g, "") : text
}

/** Builds the digest and writes it and the state beside the sense's snapshot; the sense calls this on its cadence. */
export async function writeDigest(input: DigestInput): Promise<Digest> {
  const digest = await buildDigest(input)
  const files = digestFiles(input.agentRoot)
  writeJson(files.json, digest)
  writeDigestState(input.agentRoot, input.state)
  return digest
}

export function writeDigestState(agentRoot: string, state: DigestState): void {
  writeJson(digestFiles(agentRoot).state, state)
}

/** The last digest as the Teams message, with its age when it is old; null when no digest was ever written. */
export function readDigestText(agentRoot: string, now: number): string | null {
  const digest = readJson<Digest | null>(digestFiles(agentRoot).json, null)
  if (!digest) return null
  const age = now - Date.parse(digest.at)
  const stale = age > DIGEST_STALE_MS ? `The digest is ${minutes(age)} old; the sense that writes it may be down.\n\n` : ""
  return `${stale}${renderDigest(digest, now)}`
}

/** The ask that means "how is everything going": the whole message, nothing else. */
const STATUS_ASK = /^(?:hey |hi |ouro(?:boros)?,? )?(?:how(?:'?s| is| are) (?:it|things|everything|we|the work) (?:going|doing)|how(?:'?s| are) (?:things|everything)|what'?s (?:the )?status|what'?s (?:up|going on)|status(?: report| update)?|sitrep|any news|update me)[?!. ]*$/i

export function isStatusAsk(message: string): boolean {
  return STATUS_ASK.test(message.trim().replace(/[’]/g, "'"))
}

/**
 * The answer to "how's it going?" with no model turn: `/status`, or the plain question with nothing else in the message.
 * Null means the message is something else and goes to the agent as usual.
 */
export function statusAnswer(message: string, agentRoot: string, now: number): string | null {
  const slash = /^\/status\s*$/i.test(message.trim())
  if (!slash && !isStatusAsk(message)) return null
  const text = readDigestText(agentRoot, now)
  if (!text && !slash) return null
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_status_answered", message: "answered a status ask from the digest with no model turn", meta: { via: slash ? "command" : "question", tokens: Math.ceil((text?.length ?? 0) / 4) } })
  return text ?? "No status digest yet. Add a digest block to the app-sessions sense in agent.json and it is built within minutes."
}
