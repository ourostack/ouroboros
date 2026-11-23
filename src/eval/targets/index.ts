/**
 * Model targets for eval runs: `github-copilot:<model>` or `minimax:<model>`, each a host-side `ProviderRuntime`
 * built from a named local agent's stored credentials (`readProviderCredentialRecord`), never from the bundle under
 * test.
 *
 * A Copilot target bills exactly one account. It is built with no owner and only that account's token and endpoint,
 * so the account pool never switches accounts on a 402 or 429 and no burn is written or published as the agent's
 * usage. With a stored pool, `--copilot-account` names the account; with one stored account, its login is checked.
 * Each call costs the model's premium-request multiplier from Copilot's `/models` listing, or `--premium-multiplier`
 * when the listing has none. There is no default: without either the target refuses to start, before any call.
 */
import { createGithubCopilotProviderRuntime } from "../../heart/providers/github-copilot"
import { createMinimaxProviderRuntime } from "../../heart/providers/minimax"
import { apiBaseForHost, parseAccountPool, type PoolAccount } from "../../heart/providers/account-pool"
import { directReading } from "../../heart/quota/fleet-readings"
import type { QuotaReading } from "../../heart/quota/tranche"
import type { GithubCopilotProviderConfig, MinimaxProviderConfig } from "../../heart/config"
import type { ProviderRuntime } from "../../heart/core"
import type { AgentProvider } from "../../heart/identity"
import { readProviderCredentialRecord, type ProviderCredentialRecordReadResult } from "../../heart/provider-credentials"
import { emitNervesEvent } from "../../nerves/runtime"

export type TargetSpec = { provider: "github-copilot" | "minimax"; model: string }
type Account = { githubToken: string; baseUrl: string; host: string; login?: string }

export type TargetDeps = {
  readCredential(agent: string, provider: AgentProvider): Promise<ProviderCredentialRecordReadResult>
  listCopilotModels(account: Account): Promise<unknown[]>
  /** The account's `/copilot_internal/user` answer. */
  copilotUser(account: Account): Promise<unknown>
  createCopilotRuntime(model: string, config: GithubCopilotProviderConfig): ProviderRuntime
  createMinimaxRuntime(model: string, config: MinimaxProviderConfig): ProviderRuntime
}

export type QuotaSnapshot = { tokenBased: boolean | null; reading: QuotaReading | null }

export type ResolvedTarget = {
  spec: string
  runtime: ProviderRuntime
  /** Premium requests each call costs. */
  unitCost: number
  multiplierSource: "copilot /models" | "--premium-multiplier" | "not a Copilot target"
  /** The one Copilot account billed, `login@host`. */
  account: string | null
  quota(): Promise<QuotaSnapshot>
}

export type TargetCredentials = { agent: string; copilotAccount?: string; premiumMultiplier?: number }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

export function parseTargetSpec(spec: string): TargetSpec {
  const match = /^(github-copilot|minimax):(\S+)$/.exec(spec)
  if (!match) throw new Error(`target ${spec} must be github-copilot:<model> or minimax:<model>`)
  return { provider: match[1] as TargetSpec["provider"], model: match[2]! }
}

async function credentials(deps: TargetDeps, agent: string, provider: AgentProvider): Promise<Record<string, string | number>> {
  const read = await deps.readCredential(agent, provider)
  if (!read.ok) throw new Error(`${agent} has no ${provider} credentials (${read.error}); run \`ouro auth --agent ${agent} --provider ${provider}\``)
  // `ouro auth` keeps secrets in `credentials` and settings such as Copilot's `baseUrl` in `config`.
  return { ...read.record.config, ...read.record.credentials } as Record<string, string | number>
}

const loginOf = (body: unknown): string | undefined => isRecord(body) && typeof body.login === "string" ? body.login : undefined

async function chooseAccount(deps: TargetDeps, stored: Record<string, string | number>, wanted: string | undefined): Promise<Account & { login: string }> {
  const pool = parseAccountPool(stored.accountPool)
  if (pool.length > 0) {
    const key = (account: PoolAccount): string => `${account.login}@${account.host}`
    if (!wanted) {
      if (pool.length === 1) return pool[0]!
      throw new Error(`the stored Copilot pool has ${pool.length} accounts; name the one to bill with --copilot-account ${pool.map(key).join(" or ")}`)
    }
    const found = pool.find((account) => key(account) === wanted || account.login === wanted)
    if (!found) throw new Error(`no Copilot account ${wanted} in the stored pool (${pool.map(key).join(", ")})`)
    return found
  }
  if (typeof stored.githubToken !== "string" || typeof stored.baseUrl !== "string") throw new Error("the stored Copilot credentials have no token and endpoint; run `ouro auth --provider github-copilot` for the agent")
  const single: Account = { githubToken: stored.githubToken, baseUrl: stored.baseUrl, host: "github.com" }
  const login = loginOf(await deps.copilotUser(single))
  if (!login) throw new Error("could not read the login of the stored Copilot account")
  if (wanted && wanted !== login && wanted !== `${login}@github.com`) throw new Error(`the stored Copilot account signs in as ${login}, not ${wanted}`)
  return { ...single, login }
}

function multiplierFrom(models: unknown[], model: string): number | undefined {
  const entry = models.find((candidate) => isRecord(candidate) && candidate.id === model)
  if (!entry) throw new Error(`Copilot does not offer ${model} to this account`)
  const billing = (entry as Record<string, unknown>).billing
  const value = isRecord(billing) ? billing.multiplier : undefined
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

async function copilotTarget(spec: string, model: string, creds: TargetCredentials, deps: TargetDeps): Promise<ResolvedTarget> {
  const account = await chooseAccount(deps, await credentials(deps, creds.agent, "github-copilot"), creds.copilotAccount)
  const listed = multiplierFrom(await deps.listCopilotModels(account), model)
  const given = creds.premiumMultiplier
  if (listed === undefined && given === undefined) {
    throw new Error(`Copilot's /models gives no premium-request multiplier for ${model}; pass --premium-multiplier <n> from GitHub's published table`)
  }
  if (listed === undefined && !(Number.isFinite(given) && given! >= 0)) throw new Error("--premium-multiplier must be a number of at least 0")
  const key = `${account.login}@${account.host}`
  const runtime = deps.createCopilotRuntime(model, { githubToken: account.githubToken, baseUrl: account.baseUrl })
  emitNervesEvent({ component: "eval", event: "eval.target_resolved", message: "resolved an eval model target", meta: { spec, account: key, multiplier: listed ?? given! } })
  return {
    spec, runtime, account: key,
    unitCost: listed ?? given!,
    multiplierSource: listed === undefined ? "--premium-multiplier" : "copilot /models",
    quota: async () => {
      try {
        const body = await deps.copilotUser(account)
        return { tokenBased: isRecord(body) && typeof body.token_based_billing === "boolean" ? body.token_based_billing : null, reading: directReading(key, body, new Date().toISOString()) }
      } catch {
        return { tokenBased: null, reading: null }
      }
    },
  }
}

export async function resolveTarget(spec: string, creds: TargetCredentials, deps: TargetDeps = defaultTargetDeps()): Promise<ResolvedTarget> {
  const parsed = parseTargetSpec(spec)
  if (parsed.provider === "github-copilot") return copilotTarget(spec, parsed.model, creds, deps)
  const stored = await credentials(deps, creds.agent, "minimax")
  if (typeof stored.apiKey !== "string" || !stored.apiKey) throw new Error(`${creds.agent}'s minimax credentials have no API key; run \`ouro auth --agent ${creds.agent} --provider minimax\``)
  const runtime = deps.createMinimaxRuntime(parsed.model, { apiKey: stored.apiKey })
  emitNervesEvent({ component: "eval", event: "eval.target_resolved", message: "resolved an eval model target", meta: { spec, account: null, multiplier: 0 } })
  return { spec, runtime, unitCost: 0, multiplierSource: "not a Copilot target", account: null, quota: async () => ({ tokenBased: null, reading: null }) }
}

/* v8 ignore start -- network and vault defaults: each wrapped function is tested in its own module @preserve */
export function defaultTargetDeps(): TargetDeps {
  const getJson = async (url: string, token: string): Promise<unknown> => {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Copilot-Integration-Id": "vscode-chat" }, signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
    return response.json()
  }
  return {
    readCredential: (agent, provider) => readProviderCredentialRecord(agent, provider),
    listCopilotModels: async (account) => {
      const body = await getJson(`${account.baseUrl.replace(/\/$/, "")}/models`, account.githubToken)
      return isRecord(body) && Array.isArray(body.data) ? body.data : []
    },
    copilotUser: (account) => getJson(`${apiBaseForHost(account.host)}/copilot_internal/user`, account.githubToken),
    createCopilotRuntime: (model, config) => createGithubCopilotProviderRuntime(model, config),
    createMinimaxRuntime: (model, config) => createMinimaxProviderRuntime(model, config),
  }
}
/* v8 ignore stop */
