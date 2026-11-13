import { spawnSync } from "node:child_process"
import type { IssueDrainConfig } from "../../heart/identity"
import { cleanGhEnv } from "../../heart/providers/account-pool"
import { emitNervesEvent } from "../../nerves/runtime"
import { sendToAppSession, type AppSessionsOptions } from "./client"
import { drainStateFile, readDrainStates, type DrainState, type IssueEvent } from "./issue-drain-state"
import { writeJson } from "./store"

/**
 * Issue drains: Copilot app sessions that work a GitHub repository's issues. A deterministic poll (no model turn)
 * lists each repository's open issues and messages the drain's session when one is new or changed since the last
 * poll. Events are written to disk before anyone is woken, so a crash or a refused message loses nothing; an
 * authentication or network failure is recorded for `ouro status` and leaves every marker where it was.
 */
export const ISSUE_POLL_MS = 5 * 60_000
/** A drain's own status comment carries this marker, so its creation and edits do not wake the drain again. */
export const DRAIN_STATUS_MARKER = "<!-- ouro-drain-status -->"
const MAX_TITLES = 20
const PAGE = 100

export interface GhIssue { number: number; title: string; updated_at: string }
export interface GhComment { body?: string | null; updated_at: string; user?: { login?: string } | null }

export interface GithubApi {
  /** The login the poll runs as. */
  login: string
  openIssues(repo: string): Promise<GhIssue[]>
  /** Comments created or edited after `since`. */
  comments(repo: string, issue: number, since: string): Promise<GhComment[]>
}

export type ConnectGithub = (account: string | undefined) => Promise<GithubApi>
export type SendWake = (session: string, message: string) => Promise<{ ok: boolean; error: string | null }>

const blank = (): DrainState => ({ seeded: false, seen: {}, pending: [] })

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat
}

export function wakeMessage(repo: string, events: IssueEvent[]): string {
  const shown = events.slice(0, MAX_TITLES).map(event => `#${event.number} ${oneLine(event.title)}`)
  const more = events.length > MAX_TITLES ? `, and ${events.length - MAX_TITLES} more` : ""
  return `New or changed issues in ${repo}: ${shown.join(", ")}${more}. Drain them.`
}

/** Only the drain's own status comment explains the issue's newest change. */
function ownStatusOnly(issue: GhIssue, comments: GhComment[], login: string): boolean {
  const own = (comment: GhComment): boolean => comment.user?.login?.toLowerCase() === login.toLowerCase() && !!comment.body?.includes(DRAIN_STATUS_MARKER)
  return comments.some(comment => own(comment) && comment.updated_at === issue.updated_at) && comments.every(own)
}

/** Poll one drain's repository, record what changed, then wake its session once with the whole batch. */
export async function pollDrain(
  drain: IssueDrainConfig,
  states: Record<string, DrainState>,
  save: () => void,
  deps: { connect: ConnectGithub; send: SendWake; now: number },
): Promise<void> {
  const state = states[drain.repo] ?? (states[drain.repo] = blank())
  const at = new Date(deps.now).toISOString()
  try {
    const api = await deps.connect(drain.account)
    const issues = await api.openIssues(drain.repo)
    const seen: Record<string, string> = {}
    const recorded: IssueEvent[] = []
    for (const issue of issues) {
      const key = String(issue.number)
      const before = state.seen[key]
      seen[key] = issue.updated_at
      if (!state.seeded || before === issue.updated_at) continue
      if (before && ownStatusOnly(issue, (await api.comments(drain.repo, issue.number, before)).filter(comment => comment.updated_at > before), api.login)) continue
      recorded.push({ number: issue.number, title: issue.title, updatedAt: issue.updated_at })
    }
    const numbers = new Set(recorded.map(event => event.number))
    state.pending = [...state.pending.filter(event => !numbers.has(event.number)), ...recorded]
    state.seen = seen
    state.seeded = true
    state.openCount = issues.length
    delete state.lastError
  } catch (error) {
    state.lastError = (error as Error).message
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.issue_drain_poll_error", message: "could not poll a repository's issues; markers stay where they were", meta: { repo: drain.repo, error: state.lastError } })
  }
  state.lastPollAt = at
  save()
  emitNervesEvent({ component: "senses", event: "senses.issue_drain_poll", message: "polled a repository's issues for its drain", meta: { repo: drain.repo, open: state.openCount ?? null, waiting: state.pending.length, ok: !state.lastError } })
  if (state.pending.length === 0) return
  const events = state.pending
  const sent = await deps.send(drain.session, wakeMessage(drain.repo, events)).catch((error: Error) => ({ ok: false, error: error.message }))
  if (sent.ok) {
    state.pending = []
    state.lastWakeAt = new Date(deps.now).toISOString()
    state.lastWakeCount = events.length
  } else {
    state.lastError = `could not wake the drain: ${sent.error ?? "the app refused the message"}`
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.issue_drain_wake_error", message: "could not message an issue drain; its events wait on disk", meta: { repo: drain.repo, session: drain.session, error: state.lastError } })
  }
  save()
  emitNervesEvent({ component: "senses", event: "senses.issue_drain_wake", message: "messaged an issue drain about new or changed issues", meta: { repo: drain.repo, session: drain.session, issues: events.length, ok: sent.ok } })
}

/** Poll every configured drain once. Repositories dropped from the config lose their state. */
export async function pollIssueDrains(agentRoot: string, drains: IssueDrainConfig[], deps: { connect: ConnectGithub; send: SendWake; now: number }): Promise<void> {
  const stored = readDrainStates(agentRoot)
  const states: Record<string, DrainState> = Object.fromEntries(drains.map(drain => [drain.repo, stored[drain.repo] ?? blank()]))
  const save = (): void => writeJson(drainStateFile(agentRoot), states)
  for (const drain of drains) await pollDrain(drain, states, save, deps)
  save()
}

/** The drain's GitHub access: its account's token from the `gh` CLI, then the REST API. */
export const connectGithub: ConnectGithub = async (account) => {
  const tokenArgs = ["auth", "token", "--hostname", "github.com", ...(account ? ["--user", account] : [])]
  const result = spawnSync("gh", tokenArgs, { encoding: "utf8", timeout: 10_000, env: cleanGhEnv() })
  const token = result.status === 0 ? String(result.stdout ?? "").trim() : ""
  if (!token) throw new Error(`the GitHub CLI has no token for ${account ?? "its active account"} (run \`gh auth login --hostname github.com\`)`)
  const get = async (route: string): Promise<{ body: unknown; next: boolean }> => {
    const response = await fetch(`https://api.github.com${route}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "ouro-issue-drains" },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status} for ${route.split("?")[0]}`)
    return { body: await response.json(), next: /rel="next"/.test(response.headers.get("link") ?? "") }
  }
  const all = async <T>(route: string): Promise<T[]> => {
    const items: T[] = []
    for (let page = 1; ; page++) {
      const { body, next } = await get(`${route}&per_page=${PAGE}&page=${page}`)
      items.push(...(body as T[]))
      if (!next) return items
    }
  }
  const login = account ?? String(((await get("/user")).body as { login?: string }).login ?? "")
  return {
    login,
    openIssues: async (repo) => (await all<GhIssue & { pull_request?: unknown }>(`/repos/${repo}/issues?state=open&sort=updated&direction=desc`)).filter(issue => !issue.pull_request),
    comments: (repo, issue, since) => all<GhComment>(`/repos/${repo}/issues/${issue}/comments?since=${encodeURIComponent(since)}`),
  }
}

export const sendWake = (client: AppSessionsOptions): SendWake => async (session, message) => {
  const result = await sendToAppSession(session, message, { ...client, delivery: "enqueue" })
  return { ok: result.ok, error: result.error }
}
