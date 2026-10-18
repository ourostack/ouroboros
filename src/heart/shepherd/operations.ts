import * as path from "node:path"

type ReadOptions = { agent: string; json?: boolean }
type Administration = ReadOptions & { expectedRevision: number; requestId: string }
export type ShepherdOperation =
  | ({ kind: "shepherd.status" } & ReadOptions)
  | ({ kind: "shepherd.inspect"; limit: number; id?: string; cursor?: string } & ReadOptions)
  | ({ kind: "shepherd.pause"; host: "cmux" | "herdr"; session: string } & Administration)
  | ({ kind: "shepherd.resume"; host: "cmux" | "herdr"; session: string } & Administration)
  | ({ kind: "shepherd.mandate.grant"; project: string; task: string; expiresAt: string; host?: "cmux" | "herdr"; session?: string; instance?: string } & Administration)
  | ({ kind: "shepherd.mandate.revoke"; id: string } & Administration)
  | ({ kind: "shepherd.reconcile"; id: string; resolution: "delivered" | "retired" } & Administration)
  | ({ kind: "shepherd.maintenance"; destination: string } & Administration)

export const SHEPHERD_ADMIN_USAGE = "Usage: ouro shepherd status|inspect|pause|resume|mandate grant|mandate revoke|reconcile|maintenance --agent <name> [operation options]; ouro shepherd chat --agent <name> [--session <UUID>] [--web]"
const nonempty = (value: string | undefined): value is string => !!value && value === value.trim() && value.length <= 2000 && !/[\x00-\x1f\x7f-\x9f]/.test(value)
const absolute = (value: string): boolean => path.isAbsolute(value) && path.normalize(value) === value

export function parseShepherdOperation(args: string[]): ShepherdOperation {
  const fail = (): never => { throw new Error(SHEPHERD_ADMIN_USAGE) }
  let operation = args[0]
  let offset = 1
  if (operation === "mandate") { operation += `.${args[1]}`; offset = 2 }
  const mutation = !["status", "inspect"].includes(operation ?? "")
  const operationFlags: Record<string, string[]> = {
    status: [], inspect: ["id", "cursor", "limit"],
    pause: ["host", "session"], resume: ["host", "session"],
    "mandate.grant": ["project", "task", "expires-at", "host", "session", "instance"],
    "mandate.revoke": ["id"], reconcile: ["id", "resolution"], maintenance: ["destination"],
  }
  if (!operation || !Object.hasOwn(operationFlags, operation)) return fail()
  const allowed = new Set(["agent", "json", ...operationFlags[operation]!, ...(mutation ? ["expected-revision", "request-id"] : [])])
  const values = new Map<string, string>()
  for (let i = offset; i < args.length; i++) {
    const flag = args[i]!
    const key = flag.slice(2)
    if (!flag.startsWith("--") || !allowed.has(key) || values.has(key)) return fail()
    if (key === "json") { values.set(key, "true"); continue }
    const value = args[++i]
    if (!nonempty(value) || value.startsWith("--")) return fail()
    values.set(key, value)
  }
  const required = (key: string): string => values.get(key) ?? fail()
  const integer = (key: string, fallback?: number): number => {
    const value = values.get(key)
    if (value === undefined && fallback !== undefined) return fallback
    if (!value || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) return fail()
    return Number(value)
  }
  const agent = required("agent")
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agent)) return fail()
  const common = { agent, ...(values.has("json") ? { json: true } : {}) }
  const host = (): "cmux" | "herdr" => {
    const value = required("host")
    return value === "cmux" || value === "herdr" ? value : fail()
  }
  if (operation === "status") return { kind: "shepherd.status", ...common }
  const id = (): string => {
    const value = required("id")
    if (!(operation === "mandate.revoke" ? /^mandate:[a-f0-9]{64}$|^[a-f0-9]{64}$/ : /^[a-f0-9]{64}$/).test(value)) return fail()
    return value
  }
  if (operation === "inspect") {
    const limit = integer("limit", 50)
    if (limit < 1 || limit > 200 || (values.has("id") && values.has("cursor"))) return fail()
    return { kind: "shepherd.inspect", ...common, limit, ...(values.has("id") ? { id: id() } : {}), ...(values.has("cursor") ? { cursor: required("cursor") } : {}) }
  }
  const admin = { ...common, expectedRevision: integer("expected-revision"), requestId: required("request-id") }
  if (admin.requestId.length > 200) return fail()
  if (operation === "pause" || operation === "resume") return { kind: `shepherd.${operation}`, ...admin, host: host(), session: required("session") }
  if (operation === "mandate.revoke") return { kind: "shepherd.mandate.revoke", ...admin, id: id() }
  if (operation === "reconcile") {
    const resolution = required("resolution")
    if (resolution !== "delivered" && resolution !== "retired") return fail()
    return { kind: "shepherd.reconcile", ...admin, id: id(), resolution }
  }
  if (operation === "maintenance") {
    const destination = required("destination")
    if (!absolute(destination)) return fail()
    return { kind: "shepherd.maintenance", ...admin, destination }
  }
  const project = required("project")
  const expiresAt = required("expires-at")
  if (!absolute(project) || !Number.isFinite(Date.parse(expiresAt)) || new Date(expiresAt).toISOString() !== expiresAt
    || (values.has("session") && !values.has("host")) || (values.has("instance") && !values.has("session"))) return fail()
  return {
    kind: "shepherd.mandate.grant", ...admin, project, task: required("task"), expiresAt,
    ...(values.has("host") ? { host: host() } : {}), ...(values.has("session") ? { session: required("session") } : {}),
    ...(values.has("instance") ? { instance: required("instance") } : {}),
  }
}
