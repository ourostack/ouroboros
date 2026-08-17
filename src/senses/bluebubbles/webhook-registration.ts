import { createHash } from "crypto"
import { emitNervesEvent } from "../../nerves/runtime"

export const BLUEBUBBLES_WEBHOOK_RECONCILE_INTERVAL_MS = 180_000

export interface BlueBubblesWebhookRegistrationInput {
  serverUrl: string
  password: string
  callbackPort: number
  callbackPath: string
  agentName: string
  machineId: string
  requestTimeoutMs: number
  listenerReady: boolean
}

export type BlueBubblesWebhookRegistrationState =
  | "exact"
  | "missing"
  | "drifted"
  | "auth-failed"
  | "api-unreachable"
  | "malformed"
  | "listener-not-ready"

export interface BlueBubblesWebhookRegistrationResult {
  ok: boolean
  state: BlueBubblesWebhookRegistrationState
  changed: boolean
  ownedCount: number
  exactCount: number
  detail: string
}

interface BlueBubblesWebhook {
  id: number
  url: string
  events: string[]
}

interface WebhookRegistrationDeps {
  fetchImpl?: typeof fetch
  setIntervalImpl?: (callback: () => void, intervalMs: number) => unknown
  clearIntervalImpl?: (timer: unknown) => void
}

interface WebhookListSuccess {
  hooks: BlueBubblesWebhook[]
}

function result(
  state: BlueBubblesWebhookRegistrationState,
  detail: string,
  counts: { ownedCount?: number; exactCount?: number; changed?: boolean } = {},
): BlueBubblesWebhookRegistrationResult {
  return {
    ok: state === "exact",
    state,
    changed: counts.changed ?? false,
    ownedCount: counts.ownedCount ?? 0,
    exactCount: counts.exactCount ?? 0,
    detail,
  }
}

export function blueBubblesWebhookOwnerToken(agentName: string, machineId: string): string {
  return `v1_${createHash("sha256").update(`ouro-bluebubbles-webhook\0${agentName}\0${machineId}`).digest("hex").slice(0, 32)}`
}

export function buildBlueBubblesWebhookCallbackUrl(input: BlueBubblesWebhookRegistrationInput): string {
  const callback = new URL(`http://127.0.0.1:${input.callbackPort}`)
  callback.pathname = input.callbackPath.startsWith("/") ? input.callbackPath : `/${input.callbackPath}`
  callback.searchParams.set("password", input.password)
  callback.searchParams.set("ouroWebhook", blueBubblesWebhookOwnerToken(input.agentName, input.machineId))
  return callback.toString()
}

function apiUrl(input: BlueBubblesWebhookRegistrationInput, id?: number): string {
  const base = `${input.serverUrl.replace(/\/+$/, "")}/api/v1/webhook${id === undefined ? "" : `/${id}`}`
  const url = new URL(base)
  url.searchParams.set("password", input.password)
  return url.toString()
}

export function sanitizeBlueBubblesWebhookText(
  text: string,
  input: BlueBubblesWebhookRegistrationInput,
): string {
  const owner = blueBubblesWebhookOwnerToken(input.agentName, input.machineId)
  return text
    .replaceAll(input.password, "[redacted]")
    .replaceAll(owner, "[redacted]")
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, "$1?[redacted]")
}

function isWebhook(value: unknown): value is BlueBubblesWebhook {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  return Number.isInteger(row.id)
    && typeof row.url === "string"
    && Array.isArray(row.events)
    && row.events.every((event) => typeof event === "string")
}

function ownedBy(urlText: string, owner: string): boolean {
  try {
    return new URL(urlText).searchParams.get("ouroWebhook") === owner
  } catch {
    return false
  }
}

function exactUnmarked(urlText: string, desiredUrl: string): boolean {
  try {
    const candidate = new URL(urlText)
    const desired = new URL(desiredUrl)
    if (candidate.searchParams.has("ouroWebhook")) return false
    desired.searchParams.delete("ouroWebhook")
    return candidate.toString() === desired.toString()
  } catch {
    return false
  }
}

function exactHook(hook: BlueBubblesWebhook, desiredUrl: string): boolean {
  return hook.url === desiredUrl && hook.events.length === 1 && hook.events[0] === "*"
}

async function request(
  input: BlueBubblesWebhookRegistrationInput,
  fetchImpl: typeof fetch,
  method: "GET" | "POST" | "DELETE",
  id?: number,
  body?: unknown,
): Promise<Response> {
  return fetchImpl(apiUrl(input, id), {
    method,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    signal: AbortSignal.timeout(input.requestTimeoutMs),
  })
}

async function readHooks(
  input: BlueBubblesWebhookRegistrationInput,
  fetchImpl: typeof fetch,
): Promise<WebhookListSuccess | BlueBubblesWebhookRegistrationResult> {
  try {
    const response = await request(input, fetchImpl, "GET")
    if (response.status === 401 || response.status === 403) {
      return result("auth-failed", `BlueBubbles rejected webhook credentials (HTTP ${response.status})`)
    }
    if (!response.ok) return result("api-unreachable", `BlueBubbles webhook API returned HTTP ${response.status}`)
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return result("malformed", "BlueBubbles webhook API returned invalid JSON")
    }
    const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>).data : undefined
    if (!Array.isArray(data) || !data.every(isWebhook)) {
      return result("malformed", "BlueBubbles webhook API returned an invalid webhook list")
    }
    return { hooks: data }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return result("api-unreachable", sanitizeBlueBubblesWebhookText(detail, input))
  }
}

function inspectHooks(
  hooks: BlueBubblesWebhook[],
  input: BlueBubblesWebhookRegistrationInput,
): BlueBubblesWebhookRegistrationResult {
  const desired = buildBlueBubblesWebhookCallbackUrl(input)
  const owner = blueBubblesWebhookOwnerToken(input.agentName, input.machineId)
  const owned = hooks.filter((hook) => ownedBy(hook.url, owner))
  const exact = owned.filter((hook) => exactHook(hook, desired))
  if (owned.length === 1 && exact.length === 1) {
    return result("exact", "one exact Ouro-owned BlueBubbles webhook is registered", {
      ownedCount: 1,
      exactCount: 1,
    })
  }
  return result(owned.length === 0 ? "missing" : "drifted", owned.length === 0
    ? "the Ouro-owned BlueBubbles webhook is missing"
    : "the Ouro-owned BlueBubbles webhook registration is drifted", {
    ownedCount: owned.length,
    exactCount: exact.length,
  })
}

export async function inspectBlueBubblesWebhookRegistration(
  input: BlueBubblesWebhookRegistrationInput,
  deps: WebhookRegistrationDeps = {},
): Promise<BlueBubblesWebhookRegistrationResult> {
  if (!input.listenerReady) return result("listener-not-ready", "the local BlueBubbles listener is not ready")
  const listed = await readHooks(input, deps.fetchImpl ?? fetch)
  return "hooks" in listed ? inspectHooks(listed.hooks, input) : listed
}

async function mutate(
  input: BlueBubblesWebhookRegistrationInput,
  fetchImpl: typeof fetch,
  method: "POST" | "DELETE",
  id?: number,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    const response = await request(
      input,
      fetchImpl,
      method,
      id,
      method === "POST" ? { url: buildBlueBubblesWebhookCallbackUrl(input), events: ["*"] } : undefined,
    )
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status}` }
    return { ok: true }
  } catch (error) {
    return { ok: false, detail: sanitizeBlueBubblesWebhookText(error instanceof Error ? error.message : String(error), input) }
  }
}

export async function reconcileBlueBubblesWebhookRegistration(
  input: BlueBubblesWebhookRegistrationInput,
  deps: WebhookRegistrationDeps = {},
): Promise<BlueBubblesWebhookRegistrationResult> {
  if (!input.listenerReady) return result("listener-not-ready", "the local BlueBubbles listener is not ready")
  const fetchImpl = deps.fetchImpl ?? fetch
  const listed = await readHooks(input, fetchImpl)
  if (!("hooks" in listed)) return listed

  const desired = buildBlueBubblesWebhookCallbackUrl(input)
  const owner = blueBubblesWebhookOwnerToken(input.agentName, input.machineId)
  const owned = listed.hooks.filter((hook) => ownedBy(hook.url, owner))
  const exact = owned.filter((hook) => exactHook(hook, desired))
  const keep = exact[0]
  const stale = owned.filter((hook) => hook !== keep)
  const adopt = keep ? [] : listed.hooks.filter((hook) => exactUnmarked(hook.url, desired)).slice(0, 1)
  let changed = false

  if (!keep) {
    const created = await mutate(input, fetchImpl, "POST")
    if (!created.ok) {
      return result(owned.length === 0 ? "missing" : "drifted", `could not create the desired webhook: ${created.detail}`, {
        ownedCount: owned.length,
        exactCount: exact.length,
      })
    }
    changed = true
  }

  for (const hook of [...stale, ...adopt]) {
    const deleted = await mutate(input, fetchImpl, "DELETE", hook.id)
    if (!deleted.ok) {
      return result("drifted", `could not remove 1 stale owned registration: ${deleted.detail}`, {
        ownedCount: owned.length,
        exactCount: exact.length,
        changed,
      })
    }
    changed = true
  }

  if (!changed) return inspectHooks(listed.hooks, input)
  const verified = await readHooks(input, fetchImpl)
  if (!("hooks" in verified)) return { ...verified, changed }
  return { ...inspectHooks(verified.hooks, input), changed }
}

export function createBlueBubblesWebhookReconciler(
  input: BlueBubblesWebhookRegistrationInput,
  deps: WebhookRegistrationDeps = {},
): {
  reconcileNow: () => Promise<BlueBubblesWebhookRegistrationResult>
  close: () => void
} {
  const setIntervalImpl = deps.setIntervalImpl ?? ((callback: () => void, intervalMs: number) => setInterval(callback, intervalMs))
  const clearIntervalImpl = deps.clearIntervalImpl ?? ((timer: unknown) => clearInterval(timer as ReturnType<typeof setInterval>))
  let closed = false
  let active: Promise<BlueBubblesWebhookRegistrationResult> | null = null
  const reconcileNow = (): Promise<BlueBubblesWebhookRegistrationResult> => {
    if (closed) return Promise.resolve(result("listener-not-ready", "the BlueBubbles webhook reconciler is closed"))
    if (active) return active
    active = reconcileBlueBubblesWebhookRegistration(input, deps).finally(() => { active = null })
    return active
  }
  const timer = setIntervalImpl(() => { void reconcileNow() }, BLUEBUBBLES_WEBHOOK_RECONCILE_INTERVAL_MS)
  void reconcileNow().then((outcome) => {
    emitNervesEvent({
      component: "senses",
      event: "senses.bluebubbles_webhook_reconciled",
      level: outcome.ok ? "info" : "warn",
      message: "reconciled BlueBubbles webhook registration",
      meta: { state: outcome.state, changed: outcome.changed },
    })
  })
  return {
    reconcileNow,
    close: () => {
      if (closed) return
      closed = true
      clearIntervalImpl(timer)
    },
  }
}
